/**
 * Environment configuration.
   *
   * Required:
 *   META_ACCESS_TOKEN   - A long-lived Page access token or System User access token
 *                         with the permissions the tools you use need (see README).
 *
 * Optional (used as defaults so tools don't need the ID passed every call):
 *   META_PAGE_ID        - Default Facebook Page ID(s) for page_* tools. Accepts a
 *                         single ID, or a comma-separated list (e.g. "111,222,333")
 *                         when you manage multiple Pages and want to be able to post
 *                         to all of them at once (pass page_id: "all", or omit it to
 *                         target just the first ID in the list — see facebook.ts).
 *   META_IG_USER_ID      - Default Instagram Business Account ID for instagram_* tools.
 *   META_AD_ACCOUNT_ID   - Default Ad Account ID (format act_<id>) for ads_* tools.
 */

export interface MetaConfig {
    accessToken: string;
  /** First configured Page ID — used as the single-page default (e.g. for ad attribution). */
  defaultPageId?: string;
  /** All configured Page IDs, in order. Empty array if none configured. */
  defaultPageIds: string[];
  defaultIgUserId?: string;
  defaultAdAccountId?: string;
}

export function loadConfig(): MetaConfig {
    const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) {
    console.error(
      "ERROR: META_ACCESS_TOKEN environment variable is required. " +
        "See README.md for how to generate a long-lived Page / System User access token."
    );
    process.exit(1);
}

  let defaultAdAccountId = process.env.META_AD_ACCOUNT_ID;
  if (defaultAdAccountId && !defaultAdAccountId.startsWith("act_")) {
    defaultAdAccountId = `act_${defaultAdAccountId}`;
}

  const defaultPageIds = (process.env.META_PAGE_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return {
    accessToken,
    defaultPageId: defaultPageIds[0],
    defaultPageIds,
    defaultIgUserId: process.env.META_IG_USER_ID,
    defaultAdAccountId,
};
}
