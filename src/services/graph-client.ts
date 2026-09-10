import axios, { AxiosError } from "axios";
import { GRAPH_API_BASE_URL } from "../constants.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_user_title?: string;
    error_user_msg?: string;
  };
}

/** GET request against the Graph API. `path` is relative, e.g. "me/accounts". */
export async function graphGet<T>(
  path: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const response = await axios.get<T>(`${GRAPH_API_BASE_URL}/${path}`, {
    params: { ...params, access_token: config.accessToken },
    timeout: 30000,
  });
  return response.data;
}

/** POST request against the Graph API. Sent as a form body, which is what the Graph API expects. */
export async function graphPost<T>(
  path: string,
  data: Record<string, unknown> = {}
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries({
    ...data,
    access_token: config.accessToken,
  })) {
    if (value === undefined || value === null) continue;
    body.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const response = await axios.post<T>(`${GRAPH_API_BASE_URL}/${path}`, body, {
    timeout: 60000,
  });
  return response.data;
}

/** DELETE request against the Graph API. */
export async function graphDelete<T>(
  path: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const response = await axios.delete<T>(`${GRAPH_API_BASE_URL}/${path}`, {
    params: { ...params, access_token: config.accessToken },
    timeout: 30000,
  });
  return response.data;
}

/** Turns a Graph API error into an actionable message for the model to act on. */
export function handleGraphError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<GraphErrorBody>;
    const graphError = axiosError.response?.data?.error;
    if (graphError) {
      const parts = [`Error: ${graphError.message ?? "Unknown Graph API error"}`];
      if (graphError.error_user_msg) parts.push(graphError.error_user_msg);
      if (graphError.code === 190) {
        parts.push(
          "The access token is invalid or expired. Generate a new long-lived token (see README's 'Getting a token' section)."
        );
      } else if (graphError.code === 200 || graphError.type === "OAuthException") {
        parts.push(
          "This usually means the token is missing a required permission, or the app hasn't been granted access to this Page/Ad Account/Instagram account in Business Settings."
        );
      } else if (graphError.code === 10) {
        parts.push(
          "The app may need this permission approved via App Review before it works for anyone other than app admins/testers."
        );
      } else if (graphError.code === 100) {
        parts.push("Check that all required IDs and parameters are correct for this call.");
      }
      if (graphError.fbtrace_id) parts.push(`(fbtrace_id: ${graphError.fbtrace_id})`);
      return parts.join(" ");
    }
    if (axiosError.code === "ECONNABORTED") {
      return "Error: Request to the Graph API timed out. Please try again.";
    }
    if (axiosError.response) {
      return `Error: Graph API request failed with status ${axiosError.response.status}.`;
    }
  }
  return `Error: Unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`;
}

export { config as metaConfig };
