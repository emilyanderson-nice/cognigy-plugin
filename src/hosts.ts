/**
 * Cognigy host normalisation and sibling-host derivation, shared by config.ts
 * and the named-profile loader.
 */
/**
 * Normalise the API base URL so it always points to the API host.
 * Users may supply the bare UI URL (e.g. https://dev.cognigy.ai) instead of the
 * API URL (https://api-dev.cognigy.ai).  We detect this and prepend "api-".
 */
export function normalizeApiBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (
      !url.hostname.startsWith("api-") &&
      url.hostname.endsWith(".cognigy.ai")
    ) {
      url.hostname = `api-${url.hostname}`;
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // fall through
  }
  return raw.replace(/\/+$/, "");
}

/**
 * The "api" word of a Cognigy API hostname, wherever a deployment puts it:
 * a leading segment ("api-dev.cognigy.ai"), a segment after a tenant prefix
 * ("cognigy-api-na1.nicecxone.com"), or a whole DNS label ("api.test", the
 * shape a local cluster uses because its hostnames have no environment
 * suffix to hang a hyphen on). The lookbehind/lookahead keep "myapi-dev" and
 * "rapid.example" untouched — "api" must be bounded on both sides.
 */
const API_HOST_SEGMENT = /(^|-)api(?=[-.])/;

/**
 * Derive a sibling base URL from the API base URL by swapping the "api"
 * segment of the hostname for another one (e.g. "endpoint", "static"):
 * api-dev.cognigy.ai -> endpoint-dev.cognigy.ai,
 * cognigy-api-na1.nicecxone.com -> cognigy-endpoint-na1.nicecxone.com,
 * api.test -> endpoint.test. A hostname with no such segment is returned as
 * is — callers must then rely on the explicit COGNIGY_*_BASE_URL overrides.
 */
export function deriveHostBaseUrl(
  apiBaseUrl: string,
  replacement: string,
): string {
  try {
    const url = new URL(apiBaseUrl);
    url.hostname = url.hostname.replace(API_HOST_SEGMENT, `$1${replacement}`);
    // `host`, not `hostname`: a local cluster often listens on a non-default
    // port, and the sibling services sit behind the same ingress port.
    return `${url.protocol}//${url.host}`;
  } catch {
    // Not a parseable URL: fall back to a host-scoped replace on the
    // scheme://host portion only, leaving any path/query untouched.
    const schemeMatch = apiBaseUrl.match(/^([a-z]+:\/\/)([^/?#]*)(.*)$/i);
    if (!schemeMatch) return apiBaseUrl;
    const [, scheme, host, rest] = schemeMatch;
    return `${scheme}${host.replace(API_HOST_SEGMENT, `$1${replacement}`)}${rest}`;
  }
}

/** True when derivation found no "api" segment to swap. */
export function hostDerivationFailed(apiBaseUrl: string): boolean {
  try {
    return !API_HOST_SEGMENT.test(new URL(apiBaseUrl).hostname);
  } catch {
    return true;
  }
}

/**
 * Derive the endpoint base URL from the API base URL.
 * Pattern: https://api-{env}.cognigy.ai -> https://endpoint-{env}.cognigy.ai
 */
export function deriveEndpointBaseUrl(apiBaseUrl: string): string {
  return deriveHostBaseUrl(apiBaseUrl, "endpoint");
}

/**
 * Derive the static-files base URL from the API base URL.
 * Pattern: https://api-{env}.cognigy.ai -> https://static-{env}.cognigy.ai
 */
export function deriveStaticFilesBaseUrl(apiBaseUrl: string): string {
  return deriveHostBaseUrl(apiBaseUrl, "static");
}

/**
 * Derive the webchat demo base URL from the API base URL.
 * Pattern: https://api-{env}.cognigy.ai -> https://webchat-{env}.cognigy.ai
 */
export function deriveWebchatBaseUrl(apiBaseUrl: string): string {
  return deriveHostBaseUrl(apiBaseUrl, "webchat");
}
