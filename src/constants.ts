// Graph API version — bump periodically; Meta deprecates old versions on a rolling schedule.
export const GRAPH_API_VERSION = "v21.0";
export const GRAPH_API_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Maximum characters returned in a single tool response before truncation.
export const CHARACTER_LIMIT = 25000;

// Default page size for list endpoints.
export const DEFAULT_LIMIT = 25;
