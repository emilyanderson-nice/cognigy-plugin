/**
 * Per-hop host guard for talk_to_agent. The dispatcher guard validates only the
 * first URL, so an endpoint host answering 301/302/307/308 could otherwise
 * carry the request (and, for 307/308, the conversation payload) to another
 * host. Every hop must stay on the configured endpoint host (including port),
 * using the same comparison as the first-hop guard.
 */
import { checkEndpointUrl } from "../server/hostGuard.js";
import { applyProxyToRedirect, redirectTargetUrl } from "./proxy.js";

/**
 * Builds a follow-redirects `beforeRedirect` hook that aborts any hop leaving
 * `endpointBaseUrl`'s host, then applies the per-destination proxy routing.
 * The error never echoes the redirect destination or the request payload.
 */
export function endpointRedirectGuard(
  endpointBaseUrl: string,
): (redirectOptions: Record<string, unknown>) => void {
  return (redirectOptions) => {
    const hop = redirectTargetUrl(
      redirectOptions as Parameters<typeof redirectTargetUrl>[0],
    );
    if (!checkEndpointUrl(hop, endpointBaseUrl).ok) {
      throw new Error(
        "Cross-host redirect blocked: the endpoint answered with a redirect to a different host, which is never followed.",
      );
    }
    applyProxyToRedirect(redirectOptions);
  };
}
