/**
 * Small helpers shared by the conversation transcript list and read modules.
 */

export interface ConversationClient {
  get(url: string, config?: { params?: Record<string, unknown> }): Promise<any>;
}

export interface TranscriptResult {
  body: Record<string, unknown>;
  hint?: { warning?: string; action?: string };
}

/** Numeric HTTP status of a thrown client error, if it carries one. */
export function errorStatus(error: unknown): number | undefined {
  const e = error as any;
  if (typeof e?.status === "number") return e.status;
  if (typeof e?.response?.status === "number") return e.response.status;
  return undefined;
}

/**
 * A fixed-text error: the upstream message is never echoed, only a numeric
 * status is named.
 */
export function upstreamError(what: string, error: unknown): Error {
  const status = errorStatus(error);
  return new Error(
    status === undefined
      ? `Could not read ${what}.`
      : `Could not read ${what} (HTTP ${status}).`,
  );
}

export const MAX_FIELD_CHARS = 200;

/**
 * An upstream value that may be passed on as is: a string (cut to
 * MAX_FIELD_CHARS), a finite number, a boolean or null. Objects, arrays and
 * anything else give undefined, so a field that is not a scalar can never carry
 * nested data into the output.
 */
export function scalar(
  value: unknown,
): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    return value.length > MAX_FIELD_CHARS
      ? `${value.slice(0, MAX_FIELD_CHARS - 1)}…`
      : value;
  }
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return undefined;
}

/** Milliseconds since the epoch for an ISO string, or undefined when unreadable. */
export function parseInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** Rows of a list/get response: `items`, or the response itself when an array. */
export function rowsOf(response: any): any[] {
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.items) ? response.items : [];
}
