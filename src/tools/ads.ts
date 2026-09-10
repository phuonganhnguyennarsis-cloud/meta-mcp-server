import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { graphGet, graphPost, handleGraphError, metaConfig } from "../services/graph-client.js";
import { toJsonText } from "../services/format.js";
import { DEFAULT_LIMIT } from "../constants.js";

const adAccountIdField = z
  .string()
  .optional()
  .describe(
    `Ad Account ID (e.g. 'act_1234567890', the 'act_' prefix is added automatically if omitted). Defaults to META_AD_ACCOUNT_ID` +
      (metaConfig.defaultAdAccountId ? ` (currently: ${metaConfig.defaultAdAccountId}).` : " (none configured — required).")
  );

function resolveAdAccountId(adAccountId?: string): string {
  const id = adAccountId || metaConfig.defaultAdAccountId;
  if (!id) {
    throw new Error(
      "No Ad Account ID given and META_AD_ACCOUNT_ID is not set. Pass ad_account_id explicitly, or set META_AD_ACCOUNT_ID in the server's environment."
    );
  }
  return id.startsWith("act_") ? id : `act_${id}`;
}

const STATUS_WARNING =
  "SAFETY: defaults to PAUSED so nothing spends money until a human reviews it in Ads Manager and switches it to ACTIVE. Only pass status='ACTIVE' when the user has explicitly confirmed they want it live and spending immediately.";

export function registerAdsTools(server: McpServer): void {
  // --- meta_list_ad_campaigns ------------------------------------------------
  const ListCampaignsSchema = z
    .object({
      ad_account_id: adAccountIdField,
      limit: z.number().int().min(1).max(100).default(DEFAULT_LIMIT).describe("Max campaigns to return (1-100)."),
      after: z.string().optional().describe("Pagination cursor from a previous call's paging.cursors.after."),
    })
    .strict();

  server.registerTool(
    "meta_list_ad_campaigns",
    {
      title: "List Ad Campaigns",
      description: `List ad campaigns in a Meta Ad Account, newest first.

Args:
  - ad_account_id (string, optional): Ad Account ID. Defaults to META_AD_ACCOUNT_ID if configured.
  - limit (number, optional): Max results, 1-100 (default 25).
  - after (string, optional): Pagination cursor for the next page.

Returns JSON: { campaigns: [{ id, name, objective, status, daily_budget, lifetime_budget, created_time }], next_cursor }.

Use when: "What campaigns are running?" or to find a campaign's ID before creating an ad set under it.`,
      inputSchema: ListCampaignsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof ListCampaignsSchema>) => {
      try {
        const accountId = resolveAdAccountId(params.ad_account_id);
        const data: any = await graphGet(`${accountId}/campaigns`, {
          fields: "id,name,objective,status,daily_budget,lifetime_budget,created_time",
          limit: params.limit,
          after: params.after,
        });
        const output = {
          count: data.data?.length ?? 0,
          campaigns: data.data ?? [],
          next_cursor: data.paging?.cursors?.after,
          has_more: Boolean(data.paging?.next),
        };
        return { content: [{ type: "text", text: toJsonText(output) }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_create_ad_campaign ------------------------------------------------
  const ObjectiveEnum = z.enum([
    "OUTCOME_AWARENESS",
    "OUTCOME_TRAFFIC",
    "OUTCOME_ENGAGEMENT",
    "OUTCOME_LEADS",
    "OUTCOME_SALES",
    "OUTCOME_APP_PROMOTION",
  ]);
  const StatusEnum = z.enum(["ACTIVE", "PAUSED"]);

  const CreateCampaignSchema = z
    .object({
      ad_account_id: adAccountIdField,
      name: z.string().min(1).max(400).describe("Internal campaign name for your own reference (not shown to the public)."),
      objective: ObjectiveEnum.describe(
        "Campaign objective: OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, or OUTCOME_APP_PROMOTION."
      ),
      status: StatusEnum.default("PAUSED").describe(`Initial status. ${STATUS_WARNING}`),
      daily_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Optional campaign-level daily budget, in the ad account's currency minor unit (e.g. cents for USD; for VND pass the whole amount, e.g. 500000 for 500,000 VND). Omit to set budgets per ad set instead."
        ),
    })
    .strict();

  server.registerTool(
    "meta_create_ad_campaign",
    {
      title: "Create Ad Campaign",
      description: `Create a new ad campaign in a Meta Ad Account. This does NOT create ads yet — you still need meta_create_ad_set and meta_create_ad underneath it.

Args:
  - ad_account_id (string, optional): Ad Account ID. Defaults to META_AD_ACCOUNT_ID if configured.
  - name (string, required): Internal name for the campaign.
  - objective (string, required): One of OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_APP_PROMOTION.
  - status ('ACTIVE' | 'PAUSED', optional, default 'PAUSED'): ${STATUS_WARNING}
  - daily_budget (number, optional): Campaign-level daily budget (Campaign Budget Optimization). Omit to budget per ad set.

Returns JSON: { id, status }.

Use when: "Set up a new campaign to promote our fall collection."`,
      inputSchema: CreateCampaignSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreateCampaignSchema>) => {
      try {
        const accountId = resolveAdAccountId(params.ad_account_id);
        const body: Record<string, unknown> = {
          name: params.name,
          objective: params.objective,
          status: params.status,
          special_ad_categories: JSON.stringify([]),
        };
        if (params.daily_budget) body.daily_budget = params.daily_budget;
        const data: any = await graphPost(`${accountId}/campaigns`, body);
        const output = { id: data.id, status: params.status };
        return {
          content: [
            {
              type: "text",
              text: `Campaign created (${params.status}). ID: ${output.id}${
                params.status === "PAUSED" ? " — review in Ads Manager, then set status='ACTIVE' when ready to spend." : ""
              }`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_create_ad_set ------------------------------------------------
  const OptimizationGoalEnum = z.enum([
    "LINK_CLICKS",
    "REACH",
    "IMPRESSIONS",
    "POST_ENGAGEMENT",
    "LANDING_PAGE_VIEWS",
    "OFFSITE_CONVERSIONS",
    "THRUPLAY",
  ]);
  const BillingEventEnum = z.enum(["IMPRESSIONS", "LINK_CLICKS"]);
  const GenderEnum = z.enum(["ALL", "MALE", "FEMALE"]);

  const CreateAdSetSchema = z
    .object({
      ad_account_id: adAccountIdField,
      campaign_id: z.string().min(1).describe("The parent campaign's ID (from meta_create_ad_campaign or meta_list_ad_campaigns)."),
      name: z.string().min(1).max(400).describe("Internal ad set name for your own reference."),
      daily_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Daily budget in the ad account's currency minor unit (e.g. cents for USD; for VND pass the whole amount). Required unless the parent campaign has campaign-level budget optimization."
        ),
      optimization_goal: OptimizationGoalEnum.default("LINK_CLICKS").describe("What the delivery system optimizes for."),
      billing_event: BillingEventEnum.default("IMPRESSIONS").describe("What you're charged for."),
      countries: z
        .array(z.string().length(2))
        .min(1)
        .default(["VN"])
        .describe("ISO 3166-1 alpha-2 country codes to target, e.g. ['VN']."),
      age_min: z.number().int().min(13).max(65).default(18).describe("Minimum target age (13-65)."),
      age_max: z.number().int().min(13).max(65).default(65).describe("Maximum target age (13-65)."),
      genders: GenderEnum.default("ALL").describe("Target gender."),
      status: StatusEnum.default("PAUSED").describe(`Initial status. ${STATUS_WARNING}`),
    })
    .strict();

  server.registerTool(
    "meta_create_ad_set",
    {
      title: "Create Ad Set",
      description: `Create an ad set (budget + targeting + schedule) under an existing campaign. Uses simplified location/age/gender targeting — for advanced targeting (interests, custom audiences, lookalikes), use Ads Manager directly.

Args:
  - ad_account_id (string, optional): Ad Account ID. Defaults to META_AD_ACCOUNT_ID if configured.
  - campaign_id (string, required): Parent campaign ID.
  - name (string, required): Internal ad set name.
  - daily_budget (number, optional): Daily budget in account currency minor unit. Required unless the campaign has campaign-level budget.
  - optimization_goal (string, optional, default 'LINK_CLICKS'): LINK_CLICKS, REACH, IMPRESSIONS, POST_ENGAGEMENT, LANDING_PAGE_VIEWS, OFFSITE_CONVERSIONS, or THRUPLAY.
  - billing_event (string, optional, default 'IMPRESSIONS'): IMPRESSIONS or LINK_CLICKS.
  - countries (string[], optional, default ['VN']): ISO country codes to target.
  - age_min / age_max (number, optional, default 18/65): Age range.
  - genders ('ALL' | 'MALE' | 'FEMALE', optional, default 'ALL').
  - status ('ACTIVE' | 'PAUSED', optional, default 'PAUSED'): ${STATUS_WARNING}

Returns JSON: { id, status }.

Use when: "Create an ad set targeting women 25-45 in Vietnam with a 300,000 VND daily budget."`,
      inputSchema: CreateAdSetSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreateAdSetSchema>) => {
      try {
        const accountId = resolveAdAccountId(params.ad_account_id);
        const body: Record<string, unknown> = {
          campaign_id: params.campaign_id,
          name: params.name,
          optimization_goal: params.optimization_goal,
          billing_event: params.billing_event,
          status: params.status,
          targeting: JSON.stringify({
            geo_locations: { countries: params.countries },
            age_min: params.age_min,
            age_max: params.age_max,
            ...(params.genders !== "ALL" ? { genders: [params.genders === "MALE" ? 1 : 2] } : {}),
          }),
        };
        if (params.daily_budget) body.daily_budget = params.daily_budget;
        const data: any = await graphPost(`${accountId}/adsets`, body);
        const output = { id: data.id, status: params.status };
        return {
          content: [{ type: "text", text: `Ad set created (${params.status}). ID: ${output.id}` }],
          structuredContent: output,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_create_ad_creative ------------------------------------------------
  const CtaEnum = z.enum([
    "LEARN_MORE",
    "SHOP_NOW",
    "SIGN_UP",
    "SUBSCRIBE",
    "CONTACT_US",
    "MESSAGE_PAGE",
    "GET_OFFER",
    "DOWNLOAD",
  ]);
  const pageIdField = z
    .string()
    .optional()
    .describe(
      `Facebook Page ID the ad is shown as coming from. Defaults to META_PAGE_ID` +
        (metaConfig.defaultPageId ? ` (currently: ${metaConfig.defaultPageId}).` : " (none configured — required).")
    );

  const CreateAdCreativeSchema = z
    .object({
      ad_account_id: adAccountIdField,
      page_id: pageIdField,
      name: z.string().min(1).max(400).describe("Internal creative name for your own reference."),
      message: z.string().min(1).max(2000).describe("Primary text shown above the image/video."),
      link: z.string().url().describe("Destination URL the ad clicks through to."),
      image_url: z.string().url().optional().describe("Publicly reachable image URL for the ad creative."),
      call_to_action_type: CtaEnum.default("LEARN_MORE").describe("Button label on the ad."),
    })
    .strict();

  server.registerTool(
    "meta_create_ad_creative",
    {
      title: "Create Ad Creative",
      description: `Create a reusable ad creative (the actual image/text/link/button people will see) in an Ad Account. Combine with meta_create_ad to launch it.

Args:
  - ad_account_id (string, optional): Ad Account ID. Defaults to META_AD_ACCOUNT_ID if configured.
  - page_id (string, optional): Facebook Page the ad is attributed to. Defaults to META_PAGE_ID if configured.
  - name (string, required): Internal creative name.
  - message (string, required): Primary ad text.
  - link (string, required): Destination URL.
  - image_url (string, optional): Publicly reachable image URL.
  - call_to_action_type (string, optional, default 'LEARN_MORE'): LEARN_MORE, SHOP_NOW, SIGN_UP, SUBSCRIBE, CONTACT_US, MESSAGE_PAGE, GET_OFFER, or DOWNLOAD.

Returns JSON: { id }.

Use when: "Create the ad creative for our fall collection using this photo and this headline."`,
      inputSchema: CreateAdCreativeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreateAdCreativeSchema>) => {
      try {
        const accountId = resolveAdAccountId(params.ad_account_id);
        const pageId = params.page_id || metaConfig.defaultPageId;
        if (!pageId) {
          throw new Error("No Page ID given and META_PAGE_ID is not set. Pass page_id explicitly, or set META_PAGE_ID in the server's environment.");
        }
        const objectStorySpec: Record<string, unknown> = {
          page_id: pageId,
          link_data: {
            message: params.message,
            link: params.link,
            call_to_action: { type: params.call_to_action_type },
            ...(params.image_url ? { picture: params.image_url } : {}),
          },
        };
        const data: any = await graphPost(`${accountId}/adcreatives`, {
          name: params.name,
          object_story_spec: JSON.stringify(objectStorySpec),
        });
        const output = { id: data.id };
        return { content: [{ type: "text", text: `Ad creative created. ID: ${output.id}` }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_create_ad ------------------------------------------------
  const CreateAdSchema = z
    .object({
      ad_account_id: adAccountIdField,
      name: z.string().min(1).max(400).describe("Internal ad name for your own reference."),
      adset_id: z.string().min(1).describe("The parent ad set's ID (from meta_create_ad_set)."),
      creative_id: z.string().min(1).describe("The ad creative's ID (from meta_create_ad_creative)."),
      status: StatusEnum.default("PAUSED").describe(`Initial status. ${STATUS_WARNING}`),
    })
    .strict();

  server.registerTool(
    "meta_create_ad",
    {
      title: "Create Ad",
      description: `Create an ad by combining an ad set with a creative. This is the final step that actually launches (or stages) the ad.

Args:
  - ad_account_id (string, optional): Ad Account ID. Defaults to META_AD_ACCOUNT_ID if configured.
  - name (string, required): Internal ad name.
  - adset_id (string, required): Parent ad set ID.
  - creative_id (string, required): Ad creative ID.
  - status ('ACTIVE' | 'PAUSED', optional, default 'PAUSED'): ${STATUS_WARNING}

Returns JSON: { id, status }.

Use when: "Launch the ad using that ad set and that creative."`,
      inputSchema: CreateAdSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreateAdSchema>) => {
      try {
        const accountId = resolveAdAccountId(params.ad_account_id);
        const data: any = await graphPost(`${accountId}/ads`, {
          name: params.name,
          adset_id: params.adset_id,
          creative: JSON.stringify({ creative_id: params.creative_id }),
          status: params.status,
        });
        const output = { id: data.id, status: params.status };
        return {
          content: [
            {
              type: "text",
              text: `Ad created (${params.status}). ID: ${output.id}${
                params.status === "PAUSED" ? " — it will not spend until switched to ACTIVE." : " — it is now live and spending."
              }`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_update_ad_status ------------------------------------------------
  const LevelEnum = z.enum(["CAMPAIGN", "ADSET", "AD"]);
  const UpdateStatusEnum = z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]);

  const UpdateStatusSchema = z
    .object({
      level: LevelEnum.describe("Which kind of object object_id refers to."),
      object_id: z.string().min(1).describe("The campaign, ad set, or ad ID to update."),
      status: UpdateStatusEnum.describe(
        "New status. ACTIVE resumes spending, PAUSED stops it (reversible), ARCHIVED/DELETED are for cleanup (DELETED is permanent)."
      ),
    })
    .strict();

  server.registerTool(
    "meta_update_ad_status",
    {
      title: "Update Campaign/Ad Set/Ad Status",
      description: `Change the status of a campaign, ad set, or ad — most commonly used to pause spending or resume a paused item.

Args:
  - level ('CAMPAIGN' | 'ADSET' | 'AD', required): What object_id refers to.
  - object_id (string, required): The ID of that campaign/ad set/ad.
  - status ('ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED', required): ACTIVE resumes spending immediately. PAUSED stops spending (reversible). DELETED is permanent.

Returns JSON: { id, status }.

Use when: "Pause that campaign" or "turn the fall collection ad back on". Confirm with the user before setting status='ACTIVE' (starts spending) or 'DELETED' (irreversible).`,
      inputSchema: UpdateStatusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof UpdateStatusSchema>) => {
      try {
        await graphPost(params.object_id, { status: params.status });
        const output = { id: params.object_id, status: params.status };
        return {
          content: [{ type: "text", text: `${params.level} ${params.object_id} status set to ${params.status}.` }],
          structuredContent: output,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_get_ad_insights ------------------------------------------------
  const DatePresetEnum = z.enum([
    "today",
    "yesterday",
    "last_7d",
    "last_14d",
    "last_30d",
    "this_month",
    "last_month",
    "lifetime",
  ]);

  const GetInsightsSchema = z
    .object({
      level: LevelEnum.describe("Which kind of object object_id refers to."),
      object_id: z.string().min(1).describe("The campaign, ad set, or ad ID to fetch performance for."),
      date_preset: DatePresetEnum.default("last_7d").describe("Reporting window."),
    })
    .strict();

  server.registerTool(
    "meta_get_ad_insights",
    {
      title: "Get Ad Performance Insights",
      description: `Get performance metrics (spend, impressions, reach, clicks, CTR, CPC) for a campaign, ad set, or ad over a given date range.

Args:
  - level ('CAMPAIGN' | 'ADSET' | 'AD', required): What object_id refers to.
  - object_id (string, required): The ID of that campaign/ad set/ad.
  - date_preset (string, optional, default 'last_7d'): today, yesterday, last_7d, last_14d, last_30d, this_month, last_month, or lifetime.

Returns JSON: { insights: [{ spend, impressions, reach, clicks, ctr, cpc, currency }] }. Empty insights array usually means the item hasn't been ACTIVE yet or had no delivery in this window.

Use when: "How is that campaign performing?" or "what did we spend last week?"`,
      inputSchema: GetInsightsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof GetInsightsSchema>) => {
      try {
        const data: any = await graphGet(`${params.object_id}/insights`, {
          date_preset: params.date_preset,
          fields: "spend,impressions,reach,clicks,ctr,cpc,account_currency",
        });
        const output = { object_id: params.object_id, level: params.level, date_preset: params.date_preset, insights: data.data ?? [] };
        return { content: [{ type: "text", text: toJsonText(output) }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );
}
