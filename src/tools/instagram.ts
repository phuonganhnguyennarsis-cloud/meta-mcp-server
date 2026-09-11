import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { graphGet, graphPost, handleGraphError, metaConfig } from "../services/graph-client.js";
import { toJsonText } from "../services/format.js";
import { DEFAULT_LIMIT } from "../constants.js";

const igUserIdField = z
  .string()
  .optional()
  .describe(
    `Instagram Business Account ID to act on. Omit to use the default configured in META_IG_USER_ID` +
      (metaConfig.defaultIgUserId ? ` (currently: ${metaConfig.defaultIgUserId}).` : " (none configured — required).")
  );

function resolveIgUserId(igUserId?: string): string {
  const id = igUserId || metaConfig.defaultIgUserId;
  if (!id) {
    throw new Error(
      "No Instagram Business Account ID given and META_IG_USER_ID is not set. Pass ig_user_id explicitly, or set META_IG_USER_ID in the server's environment."
    );
  }
  return id;
}

/** Polls a media container's status until it's FINISHED (for video/reel uploads, which process async). */
async function waitForContainerReady(containerId: string, timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status: any = await graphGet(containerId, { fields: "status_code" });
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR") {
      throw new Error("Media container processing failed on Meta's side (status_code=ERROR). Check the media URL and format.");
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(
    `Timed out after ${timeoutMs / 1000}s waiting for media to finish processing. It may still complete — check with meta_list_instagram_media shortly.`
  );
}

export function registerInstagramTools(server: McpServer): void {
  // --- meta_get_instagram_account_info -------------------------------------
  const GetIgInfoSchema = z.object({ ig_user_id: igUserIdField }).strict();

  server.registerTool(
    "meta_get_instagram_account_info",
    {
      title: "Get Instagram Account Info",
      description: `Get profile info for an Instagram Business/Creator account: username, follower count, bio, linked Facebook Page.

Args:
  - ig_user_id (string, optional): Instagram Business Account ID. Defaults to META_IG_USER_ID if configured.

Returns JSON with fields: id, username, name, biography, followers_count, media_count, website.

Use when: "What's our Instagram follower count?" or to confirm which account this server is pointed at.`,
      inputSchema: GetIgInfoSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof GetIgInfoSchema>) => {
      try {
        const igUserId = resolveIgUserId(params.ig_user_id);
        const data = await graphGet(igUserId, {
          fields: "id,username,name,biography,followers_count,media_count,website",
        });
        return { content: [{ type: "text", text: toJsonText(data) }], structuredContent: data as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_list_instagram_media --------------------------------------------
  const ListIgMediaSchema = z
    .object({
      ig_user_id: igUserIdField,
      limit: z.number().int().min(1).max(100).default(DEFAULT_LIMIT).describe("Max media items to return (1-100)."),
      after: z.string().optional().describe("Pagination cursor from a previous call's paging.cursors.after."),
    })
    .strict();

  server.registerTool(
    "meta_list_instagram_media",
    {
      title: "List Instagram Media",
      description: `List recent posts (image/video/carousel/reel) published to an Instagram Business account, newest first.

Args:
  - ig_user_id (string, optional): Instagram Business Account ID. Defaults to META_IG_USER_ID if configured.
  - limit (number, optional): Max results, 1-100 (default 25).
  - after (string, optional): Pagination cursor for the next page.

Returns JSON: { media: [{ id, caption, media_type, media_url, permalink, timestamp }], next_cursor }.

Use when: "What have we posted on Instagram recently?" or to find a media ID before fetching insights.`,
      inputSchema: ListIgMediaSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof ListIgMediaSchema>) => {
      try {
        const igUserId = resolveIgUserId(params.ig_user_id);
        const data: any = await graphGet(`${igUserId}/media`, {
          fields: "id,caption,media_type,media_url,permalink,timestamp",
          limit: params.limit,
          after: params.after,
        });
        const output = {
          count: data.data?.length ?? 0,
          media: data.data ?? [],
          next_cursor: data.paging?.cursors?.after,
          has_more: Boolean(data.paging?.next),
        };
        return { content: [{ type: "text", text: toJsonText(output) }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_create_instagram_post -------------------------------------------
  const MediaTypeEnum = z.enum(["IMAGE", "REELS"]);

  const CreateIgPostSchema = z
    .object({
      ig_user_id: igUserIdField,
      media_type: MediaTypeEnum.describe(
        "'IMAGE' for a photo post, 'REELS' for a video/reel. Use meta_create_instagram_carousel_post for multi-image posts."
      ),
      media_url: z
        .string()
        .url()
        .describe("Publicly reachable URL of the image (jpg) or video (mp4/mov) to post."),
      caption: z.string().max(2200).optional().describe("Caption text, up to 2200 characters. Hashtags allowed inline."),
    })
    .strict();

  server.registerTool(
    "meta_create_instagram_post",
    {
      title: "Create Instagram Post",
      description: `Publish a single image or Reel to an Instagram Business account. This is a two-step Meta workflow (create container, then publish) handled as one call; for REELS it waits for Meta to finish processing the video before publishing.

Args:
  - ig_user_id (string, optional): Instagram Business Account ID. Defaults to META_IG_USER_ID if configured.
  - media_type ('IMAGE' | 'REELS', required): Post type.
  - media_url (string, required): Publicly reachable URL of the image or video (Meta's servers fetch it).
  - caption (string, optional): Caption text up to 2200 characters.

Returns JSON: { id } — the published media's ID.

Requires 'instagram_content_publish' permission and the IG account must be linked to a Facebook Page the token manages. REELS uploads can take up to ~2 minutes to process.

Use when: "Post this photo/reel to our Instagram". Don't use for multi-image carousels — use meta_create_instagram_carousel_post instead.`,
      inputSchema: CreateIgPostSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreateIgPostSchema>) => {
      try {
        const igUserId = resolveIgUserId(params.ig_user_id);
        const containerBody: Record<string, unknown> = { caption: params.caption };
        if (params.media_type === "REELS") {
          containerBody.media_type = "REELS";
          containerBody.video_url = params.media_url;
        } else {
          containerBody.image_url = params.media_url;
        }
        const container: any = await graphPost(`${igUserId}/media`, containerBody);
        if (params.media_type === "REELS") {
          await waitForContainerReady(container.id);
        }
        const published: any = await graphPost(`${igUserId}/media_publish`, {
          creation_id: container.id,
        });
        const output = { id: published.id };
        return { content: [{ type: "text", text: `Instagram post published. Media ID: ${output.id}` }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_create_instagram_story --------------------------------------------
  const StoryMediaTypeEnum = z.enum(["IMAGE", "VIDEO"]);

  const CreateIgStorySchema = z
    .object({
      ig_user_id: igUserIdField,
      media_type: StoryMediaTypeEnum.describe("'IMAGE' for a photo story, 'VIDEO' for a video story."),
      media_url: z
        .string()
        .url()
        .describe("Publicly reachable URL of the image (jpg) or video (mp4/mov) to post as a Story."),
    })
    .strict();

  server.registerTool(
    "meta_create_instagram_story",
    {
      title: "Create Instagram Story",
      description: `Publish a single image or video to an Instagram Business account's Story (visible 24 hours). Two-step Meta workflow (create container with media_type STORIES, then publish) handled as one call; for VIDEO it waits for Meta to finish processing before publishing.

Args:
  - ig_user_id (string, optional): Instagram Business Account ID. Defaults to META_IG_USER_ID if configured.
  - media_type ('IMAGE' | 'VIDEO', required): Story type.
  - media_url (string, required): Publicly reachable URL of the image or video (Meta's servers fetch it).

Returns JSON: { id } — the published story's media ID.

IMPORTANT LIMITATION: Meta's Graph API for Stories does not support adding music stickers, link/swipe-up stickers, polls, or any other interactive sticker — the Content Publishing API only supports a plain image/video Story. Those stickers can only be added by hand inside the Instagram app.

Requires 'instagram_content_publish' permission and the IG account must be linked to a Facebook Page the token manages.

Use when: "Post this photo/video to our Instagram Story."`,
      inputSchema: CreateIgStorySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreateIgStorySchema>) => {
      try {
        const igUserId = resolveIgUserId(params.ig_user_id);
        const containerBody: Record<string, unknown> = { media_type: "STORIES" };
        if (params.media_type === "VIDEO") {
          containerBody.video_url = params.media_url;
        } else {
          containerBody.image_url = params.media_url;
        }
        const container: any = await graphPost(`${igUserId}/media`, containerBody);
        if (params.media_type === "VIDEO") {
          await waitForContainerReady(container.id);
        }
        const published: any = await graphPost(`${igUserId}/media_publish`, {
          creation_id: container.id,
        });
        const output = { id: published.id };
        return {
          content: [
            {
              type: "text",
              text: `Instagram Story published (plain story — no music/link sticker; add those by hand in-app if needed). Media ID: ${output.id}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_create_instagram_carousel_post -----------------------------------
  const CreateIgCarouselSchema = z
    .object({
      ig_user_id: igUserIdField,
      media_urls: z
        .array(z.string().url())
        .min(2, "A carousel needs at least 2 items")
        .max(10, "A carousel supports at most 10 items")
        .describe("Publicly reachable image URLs, in the order they should appear (2-10 items)."),
      caption: z.string().max(2200).optional().describe("Caption text, up to 2200 characters."),
    })
    .strict();

  server.registerTool(
    "meta_create_instagram_carousel_post",
    {
      title: "Create Instagram Carousel Post",
      description: `Publish a multi-image carousel post (2-10 images) to an Instagram Business account.

Args:
  - ig_user_id (string, optional): Instagram Business Account ID. Defaults to META_IG_USER_ID if configured.
  - media_urls (string[], required): 2-10 publicly reachable image URLs, in display order.
  - caption (string, optional): Caption text for the whole carousel, up to 2200 characters.

Returns JSON: { id } — the published carousel's media ID.

Requires 'instagram_content_publish' permission.

Use when: "Post these 4 product photos as a carousel on Instagram."`,
      inputSchema: CreateIgCarouselSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreateIgCarouselSchema>) => {
      try {
        const igUserId = resolveIgUserId(params.ig_user_id);
        const childIds: string[] = [];
        for (const url of params.media_urls) {
          const child: any = await graphPost(`${igUserId}/media`, {
            image_url: url,
            is_carousel_item: true,
          });
          childIds.push(child.id);
        }
        const container: any = await graphPost(`${igUserId}/media`, {
          media_type: "CAROUSEL",
          caption: params.caption,
          children: childIds.join(","),
        });
        const published: any = await graphPost(`${igUserId}/media_publish`, {
          creation_id: container.id,
        });
        const output = { id: published.id, item_count: childIds.length };
        return {
          content: [{ type: "text", text: `Instagram carousel published with ${output.item_count} items. Media ID: ${output.id}` }],
          structuredContent: output,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  // --- meta_get_instagram_media_insights -------------------------------------
  const GetIgInsightsSchema = z
    .object({
      media_id: z.string().min(1).describe("The Instagram media ID to fetch insights for."),
    })
    .strict();

  server.registerTool(
    "meta_get_instagram_media_insights",
    {
      title: "Get Instagram Media Insights",
      description: `Get performance metrics for a single published Instagram post: reach, likes, comments, saves, shares.

Args:
  - media_id (string, required): The media ID (from meta_create_instagram_post or meta_list_instagram_media).

Returns JSON: { metrics: [{ name, values }] } covering reach, likes, comments, saved, shares.

Requires 'instagram_manage_insights' permission.

Use when: "How did our last Instagram post do?"`,
      inputSchema: GetIgInsightsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof GetIgInsightsSchema>) => {
      try {
        const data: any = await graphGet(`${params.media_id}/insights`, {
          metric: "reach,likes,comments,saved,shares",
        });
        const output = { media_id: params.media_id, metrics: data.data ?? [] };
        return { content: [{ type: "text", text: toJsonText(output) }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );
}
