import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { graphGet, graphPost, graphDelete, handleGraphError, metaConfig } from "../services/graph-client.js";
import { toJsonText } from "../services/format.js";
import { DEFAULT_LIMIT } from "../constants.js";

function describePageIdField(): string {
  const base =
    'Facebook Page ID to act on. Pass a single ID, an array of IDs to target multiple Pages at once, ' +
    'or the literal string "all" to target every Page configured in META_PAGE_ID. ' +
    "Omit to use the default configured in META_PAGE_ID";
  if (!metaConfig.defaultPageId) {
    return `${base} (none configured — required).`;
  }
  if (metaConfig.defaultPageIds.length > 1) {
    return `${base} (currently: ${metaConfig.defaultPageId}; ${metaConfig.defaultPageIds.length} Pages configured in total — pass "all" to reach every one of them).`;
  }
  return `${base} (currently: ${metaConfig.defaultPageId}).`;
}

const pageIdField = z.union([z.string(), z.array(z.string()).min(1)]).optional().describe(describePageIdField());

type PageIdInput = string | string[] | undefined;

// Page content endpoints (feed posts, photos, deleting a post) require an actual Page Access
// Token — the System User / Business token alone is not accepted there even when the System
// User has "manage posts" access to the Page (that grants the *ability* to mint a Page token,
// it isn't usable directly). Instagram's Content Publishing API doesn't have this requirement,
// which is why IG posting works with the System User token but plain Page posting didn't.
// We exchange for it once per Page per server instance and cache it (server instances are
// short-lived in stateless HTTP mode, so this is a small, safe win rather than a persistent store).
const pageAccessTokenCache = new Map<string, string>();

async function getPageAccessToken(pageId: string): Promise<string> {
  const cached = pageAccessTokenCache.get(pageId);
  if (cached) return cached;
  const data = await graphGet<{ access_token?: string }>(pageId, { fields: "access_token" });
  if (!data.access_token) {
    throw new Error(
      `Could not obtain a Page Access Token for Page ${pageId}. In Business Settings, make sure the System User ` +
        `has "Content" (manage posts) task access assigned directly on this Page.`
    );
  }
  pageAccessTokenCache.set(pageId, data.access_token);
  return data.access_token;
}

/** Resolves the page_id argument to one or more concrete Page IDs. */
function resolvePageIds(pageId: PageIdInput): string[] {
  if (Array.isArray(pageId)) {
    if (pageId.length === 0) {
      throw new Error("page_id was an empty array. Pass at least one Page ID, or omit page_id to use the default.");
    }
    return pageId;
  }
  if (pageId && pageId.toLowerCase() !== "all") {
    return [pageId];
  }
  if (metaConfig.defaultPageIds.length === 0) {
    throw new Error(
      "No Page ID given and META_PAGE_ID is not set. Pass page_id explicitly, or set META_PAGE_ID in the server's environment."
    );
  }
  if (pageId && pageId.toLowerCase() === "all") {
    return metaConfig.defaultPageIds;
  }
  // page_id omitted entirely — default to just the first configured Page (backward-compatible single-page default).
  return [metaConfig.defaultPageIds[0]];
}

export function registerFacebookTools(server: McpServer): void {
  // --- meta_get_page_info -------------------------------------------------
  const GetPageInfoSchema = z
    .object({
      page_id: pageIdField,
    })
    .strict();

  server.registerTool(
    "meta_get_page_info",
    {
      title: "Get Facebook Page Info",
      description: `Get profile info for a Facebook Page: name, category, follower/fan count, about text, linked Instagram account, and website.

Args:
  - page_id (string, optional): Page ID. Defaults to META_PAGE_ID if configured.

Returns JSON with fields: id, name, category, about, fan_count, followers_count, website, instagram_business_account.
Pass an array of Page IDs (or page_id: "all") to fetch several Pages at once — returns { pages: [...] } instead.

Use when: "What's our Page's follower count?" or to confirm which Page/Instagram account this server is pointed at.`,
      inputSchema: GetPageInfoSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof GetPageInfoSchema>) => {
      try {
        const pageIds = resolvePageIds(params.page_id);
        const fields = "id,name,category,about,fan_count,followers_count,website,link,instagram_business_account";
        const results = await Promise.allSettled(pageIds.map((id) => graphGet<Record<string, unknown>>(id, { fields })));
        if (pageIds.length === 1) {
          const [only] = results;
          if (only.status === "rejected") throw only.reason;
          return { content: [{ type: "text", text: toJsonText(only.value) }], structuredContent: only.value };
        }
        const pages = results.map((r, i) =>
          r.status === "fulfilled" ? r.value : { page_id: pageIds[i], error: handleGraphError(r.reason) }
        );
        const output = { pages };
        return { content: [{ type: "text", text: toJsonText(output) }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_list_page_posts ------------------------------------------------
  const ListPagePostsSchema = z
    .object({
      page_id: pageIdField,
      limit: z.number().int().min(1).max(100).default(DEFAULT_LIMIT).describe("Max posts to return (1-100)."),
      after: z.string().optional().describe("Pagination cursor from a previous call's paging.cursors.after."),
    })
    .strict();

  server.registerTool(
    "meta_list_page_posts",
    {
      title: "List Facebook Page Posts",
      description: `List recent posts published to a Facebook Page's feed, newest first.

Args:
  - page_id (string, optional): Page ID. Defaults to META_PAGE_ID if configured.
  - limit (number, optional): Max results, 1-100 (default 25).
  - after (string, optional): Pagination cursor for the next page.

Returns JSON: { posts: [{ id, message, created_time, permalink_url }], next_cursor }.
Pass an array of Page IDs (or page_id: "all") to list posts from several Pages at once — returns { pages: [{ page_id, posts, next_cursor, has_more }] } instead.

Use when: "What did we last post?" or to find a post's ID before fetching its insights.`,
      inputSchema: ListPagePostsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof ListPagePostsSchema>) => {
      try {
        const pageIds = resolvePageIds(params.page_id);
        const fetchOne = async (pageId: string) => {
          const data: any = await graphGet(`${pageId}/posts`, {
            fields: "id,message,created_time,permalink_url,attachments{type,url}",
            limit: params.limit,
            after: params.after,
          });
          return {
            page_id: pageId,
            count: data.data?.length ?? 0,
            posts: data.data ?? [],
            next_cursor: data.paging?.cursors?.after,
            has_more: Boolean(data.paging?.next),
          };
        };
        const results = await Promise.allSettled(pageIds.map(fetchOne));
        if (pageIds.length === 1) {
          const [only] = results;
          if (only.status === "rejected") throw only.reason;
          const { page_id, ...output } = only.value;
          return { content: [{ type: "text", text: toJsonText(output) }], structuredContent: output };
        }
        const pages = results.map((r, i) =>
          r.status === "fulfilled" ? r.value : { page_id: pageIds[i], error: handleGraphError(r.reason) }
        );
        const output = { pages };
        return { content: [{ type: "text", text: toJsonText(output) }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_create_page_post ------------------------------------------------
  const CreatePagePostSchema = z
    .object({
      page_id: pageIdField,
      message: z.string().min(1).max(63206).describe("The post's text content."),
      link: z.string().url().optional().describe("A URL to attach as a link preview card."),
      scheduled_publish_time: z
        .number()
        .int()
        .optional()
        .describe(
          "Unix timestamp (seconds) to schedule the post for, must be 10 minutes to 6 months in the future. Omit to publish immediately."
        ),
    })
    .strict();

  server.registerTool(
    "meta_create_page_post",
    {
      title: "Create Facebook Page Post",
      description: `Publish (or schedule) a text/link post to a Facebook Page's feed.

Args:
  - page_id (string, optional): Page ID. Defaults to META_PAGE_ID if configured.
  - message (string, required): Post text, up to ~63,000 characters.
  - link (string, optional): URL to attach as a link preview.
  - scheduled_publish_time (number, optional): Unix timestamp to schedule for later (10 min - 6 months out). Omit to publish now.

Returns JSON: { id, scheduled: boolean } for a single Page, or { results: [{ page_id, id?, scheduled?, error? }], succeeded, failed } when posting to multiple Pages at once.

Requires the token to have 'pages_manage_posts' permission for each Page.

Use when: "Post this update to our Facebook Page" or "schedule this for tomorrow at 9am".
To post the same message to several Pages in one go (e.g. all Narsis Pages), pass page_id as an array of Page IDs, or "all" to target every Page configured in META_PAGE_ID.
Don't use for photos/videos — use meta_create_page_photo_post for images.`,
      inputSchema: CreatePagePostSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreatePagePostSchema>) => {
      try {
        const pageIds = resolvePageIds(params.page_id);
        const body: Record<string, unknown> = { message: params.message };
        if (params.link) body.link = params.link;
        if (params.scheduled_publish_time) {
          body.published = false;
          body.scheduled_publish_time = params.scheduled_publish_time;
        }
        const postOne = async (pageId: string) => {
          const pageToken = await getPageAccessToken(pageId);
          const data: any = await graphPost(`${pageId}/feed`, body, pageToken);
          return { page_id: pageId, id: data.id, scheduled: Boolean(params.scheduled_publish_time) };
        };
        const results = await Promise.allSettled(pageIds.map(postOne));

        if (pageIds.length === 1) {
          const [only] = results;
          if (only.status === "rejected") throw only.reason;
          const { page_id, ...output } = only.value;
          return {
            content: [
              {
                type: "text",
                text: output.scheduled
                  ? `Post scheduled successfully. ID: ${output.id}`
                  : `Post published successfully. ID: ${output.id}`,
              },
            ],
            structuredContent: output,
          };
        }

        const perPage = results.map((r, i) =>
          r.status === "fulfilled" ? r.value : { page_id: pageIds[i], error: handleGraphError(r.reason) }
        );
        const succeeded = perPage.filter((r) => !("error" in r)).length;
        const failed = perPage.length - succeeded;
        const output = { results: perPage, succeeded, failed };
        return {
          content: [
            {
              type: "text",
              text: `Posted to ${succeeded}/${perPage.length} Page(s).${failed > 0 ? ` ${failed} failed — see results for details.` : ""}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_create_page_photo_post -------------------------------------------
  const CreatePagePhotoPostSchema = z
    .object({
      page_id: pageIdField,
      image_url: z.string().url().describe("Publicly reachable URL of the image to post."),
      caption: z.string().max(63206).optional().describe("Caption text for the photo."),
      scheduled_publish_time: z
        .number()
        .int()
        .optional()
        .describe("Unix timestamp (seconds) to schedule for later (10 min - 6 months out). Omit to publish now."),
    })
    .strict();

  server.registerTool(
    "meta_create_page_photo_post",
    {
      title: "Create Facebook Page Photo Post",
      description: `Publish (or schedule) a single photo post to a Facebook Page, sourced from a public image URL.

Args:
  - page_id (string, optional): Page ID. Defaults to META_PAGE_ID if configured.
  - image_url (string, required): Publicly reachable URL of the image (Meta's servers fetch it).
  - caption (string, optional): Caption/text for the post.
  - scheduled_publish_time (number, optional): Unix timestamp to schedule for later. Omit to publish now.

Returns JSON: { id, post_id, scheduled: boolean } for a single Page, or { results: [{ page_id, id?, post_id?, scheduled?, error? }], succeeded, failed } when posting to multiple Pages at once.

Requires 'pages_manage_posts' permission for each Page. The image_url must be publicly accessible (no auth, no localhost).

Use when: "Post this product photo to our Page".
To post the same photo to several Pages in one go (e.g. all Narsis Pages), pass page_id as an array of Page IDs, or "all" to target every Page configured in META_PAGE_ID.`,
      inputSchema: CreatePagePhotoPostSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreatePagePhotoPostSchema>) => {
      try {
        const pageIds = resolvePageIds(params.page_id);
        const body: Record<string, unknown> = { url: params.image_url };
        if (params.caption) body.caption = params.caption;
        if (params.scheduled_publish_time) {
          body.published = false;
          body.scheduled_publish_time = params.scheduled_publish_time;
        }
        const postOne = async (pageId: string) => {
          const pageToken = await getPageAccessToken(pageId);
          const data: any = await graphPost(`${pageId}/photos`, body, pageToken);
          return {
            page_id: pageId,
            id: data.id,
            post_id: data.post_id,
            scheduled: Boolean(params.scheduled_publish_time),
          };
        };
        const results = await Promise.allSettled(pageIds.map(postOne));

        if (pageIds.length === 1) {
          const [only] = results;
          if (only.status === "rejected") throw only.reason;
          const { page_id, ...output } = only.value;
          return {
            content: [
              {
                type: "text",
                text: `Photo post created. Photo ID: ${output.id}${output.post_id ? `, Post ID: ${output.post_id}` : ""}`,
              },
            ],
            structuredContent: output,
          };
        }

        const perPage = results.map((r, i) =>
          r.status === "fulfilled" ? r.value : { page_id: pageIds[i], error: handleGraphError(r.reason) }
        );
        const succeeded = perPage.filter((r) => !("error" in r)).length;
        const failed = perPage.length - succeeded;
        const output = { results: perPage, succeeded, failed };
        return {
          content: [
            {
              type: "text",
              text: `Photo posted to ${succeeded}/${perPage.length} Page(s).${failed > 0 ? ` ${failed} failed — see results for details.` : ""}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_delete_post --------------------------------------------------
  const DeletePostSchema = z
    .object({
      post_id: z.string().min(1).describe("The full post/photo ID to delete, e.g. '123456789_987654321'."),
    })
    .strict();

  server.registerTool(
    "meta_delete_post",
    {
      title: "Delete Facebook Post",
      description: `Permanently delete a published or scheduled Facebook Page post.

Args:
  - post_id (string, required): The post ID (from meta_create_page_post, meta_create_page_photo_post, or meta_list_page_posts).

Returns JSON: { success: boolean }.

This is irreversible. Use when the user explicitly asks to remove/delete/take down a specific post.`,
      inputSchema: DeletePostSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof DeletePostSchema>) => {
      try {
        const [pageId] = params.post_id.split("_");
        const pageToken = pageId ? await getPageAccessToken(pageId).catch(() => undefined) : undefined;
        const data: any = await graphDelete(params.post_id, {}, pageToken);
        return {
          content: [{ type: "text", text: data.success ? "Post deleted successfully." : "Delete request sent." }],
          structuredContent: { success: Boolean(data.success) },
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_get_post_insights ----------------------------------------------
  const GetPostInsightsSchema = z
    .object({
      post_id: z.string().min(1).describe("The post ID to fetch insights for."),
    })
    .strict();

  server.registerTool(
    "meta_get_post_insights",
    {
      title: "Get Facebook Post Insights",
      description: `Get performance metrics for a single published Facebook Page post: impressions, reach, and reactions breakdown.

Args:
  - post_id (string, required): The post ID.

Returns JSON: { metrics: [{ name, values }] } covering post_impressions, post_impressions_unique, post_reactions_by_type_total.

Requires 'read_insights' permission. Only works on posts owned by a Page the token manages.

Use when: "How did our last post perform?"`,
      inputSchema: GetPostInsightsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof GetPostInsightsSchema>) => {
      try {
        const data: any = await graphGet(`${params.post_id}/insights`, {
          metric: "post_impressions,post_impressions_unique,post_reactions_by_type_total",
        });
        const output = { post_id: params.post_id, metrics: data.data ?? [] };
        return { content: [{ type: "text", text: toJsonText(output) }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );
}
