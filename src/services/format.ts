import { CHARACTER_LIMIT } from "../constants.js";

/** Stringifies JSON and truncates with a clear message if it exceeds CHARACTER_LIMIT. */
export function toJsonText(data: unknown): string {
  const text = JSON.stringify(data, null, 2);
    if (text.length <= CHARACTER_LIMIT) return text;
      return (
          text.slice(0, CHARACTER_LIMIT) +
              `\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Narrow your query with 'fields' or 'limit'.]`
                );
                }
                
