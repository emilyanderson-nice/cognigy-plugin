/**
 * Endpoint tokens are credentials: anyone holding a REST endpoint's URLToken
 * can send messages to it. These helpers keep tokens and token-bearing URLs
 * out of tool output unless the caller asks for them, and resolve a REST
 * endpoint's token server-side so talk_to_agent can address it by id.
 *
 * Kept out of filters.ts on purpose: filterResponse('endpoint') is pinned by
 * its own test and also feeds other tools.
 */

import { jsonSafeCopy } from "../utils/jsonSafe.js";

export interface EndpointOutput {
  URLToken?: unknown;
  endpointUrl?: unknown;
  [key: string]: unknown;
}

/**
 * Returns a copy of a filtered endpoint (or a raw endpoint) without its URL
 * token and URL, plus `hasToken`. With `reveal` the object is returned as is.
 */
export function redactEndpoint<T extends EndpointOutput>(
  endpoint: T,
  reveal = false,
  /** Pass the verdict computed from the RAW upstream item when `endpoint` is a filtered view. */
  hasToken?: boolean,
): T | (Omit<T, "URLToken" | "endpointUrl"> & { hasToken: boolean }) {
  if (reveal) return endpoint;
  const { URLToken, endpointUrl: _endpointUrl, ...rest } = endpoint;
  return { ...rest, hasToken: hasToken ?? hasUrlToken(URLToken) };
}

const TOKEN_KEYS = new Set(["URLToken", "endpointUrlToken"]);

/**
 * Copy of `value` without keys named URLToken / endpointUrlToken at any depth
 * (objects and arrays); everything else is kept as is. `keepTopLevel` leaves
 * the root object's own keys alone (an endpoint read with revealToken).
 */
export function stripTokenKeysDeep(value: unknown, keepTopLevel = false): any {
  if (Array.isArray(value)) return value.map((v) => stripTokenKeysDeep(v));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__") continue;
    if (!keepTopLevel && TOKEN_KEYS.has(key)) continue;
    out[key] = stripTokenKeysDeep(child);
  }
  return out;
}

/** The URL token of a REST endpoint URL (last path segment, ignoring `test`). */
export function tokenFromEndpointUrl(url: string): string | undefined {
  try {
    const segments = new URL(url).pathname
      .split("/")
      .filter((s) => s && s !== "test");
    return segments[segments.length - 1];
  } catch {
    return undefined;
  }
}

export const REDACTED = "<redacted>";

/**
 * JSON-safe copy of `value` in which every occurrence of a secret (the token
 * and the endpoint URLs that contain it) inside any string is replaced. Longer
 * secrets are replaced first so a full URL becomes one marker.
 */
export function scrubSecrets(
  value: unknown,
  secrets: (string | undefined)[],
): unknown {
  const list = [...new Set(secrets.filter((s): s is string => !!s))].sort(
    (a, b) => b.length - a.length,
  );
  const scrubText = (s: string) =>
    list.reduce((acc, secret) => acc.split(secret).join(REDACTED), s);
  return scrubDeep(jsonSafeCopy(value), scrubText);
}

function scrubDeep(v: unknown, scrubText: (s: string) => string): unknown {
  if (typeof v === "string") return scrubText(v);
  if (Array.isArray(v)) return v.map((i) => scrubDeep(i, scrubText));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(v)) {
      out[scrubText(k)] = scrubDeep(c, scrubText);
    }
    return out;
  }
  return v;
}

export function hasUrlToken(token: unknown): boolean {
  return typeof token === "string" && token.length > 0;
}

/** Minimal client surface needed to read one endpoint. */
interface EndpointReader {
  get(url: string): Promise<any>;
}

export type RestEndpointToken =
  | { ok: true; token: string; endpointId: string }
  | { ok: false; error: string };

/**
 * Looks an endpoint up by id and returns its URL token, or a fixed error text
 * (never the token, never upstream error text) when it is not a usable REST
 * endpoint.
 */
export async function resolveRestEndpointToken(
  client: EndpointReader,
  endpointId: string,
): Promise<RestEndpointToken> {
  let endpoint: any;
  try {
    endpoint = await client.get(`/v2.0/endpoints/${endpointId}`);
  } catch {
    return {
      ok: false,
      error: `Could not read endpoint ${endpointId}.`,
    };
  }
  if (endpoint?.channel !== "rest") {
    return {
      ok: false,
      error: `Endpoint ${endpointId} is not a REST endpoint (channel ${String(endpoint?.channel)}); talk_to_agent needs a REST endpoint.`,
    };
  }
  if (!hasUrlToken(endpoint.URLToken)) {
    return {
      ok: false,
      error: `Endpoint ${endpointId} has no URL token.`,
    };
  }
  return { ok: true, token: endpoint.URLToken, endpointId };
}
