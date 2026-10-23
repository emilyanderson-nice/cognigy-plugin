/**
 * Raw network-layer error shapes and the fixed class texts for the log reader
 * network-code tests. Test-only; nothing here touches a real environment.
 */
import { SENTINEL_ERR, SENTINEL_KEY, LOGS_URL } from "./logFixtures.js";

export const GENERIC_BODY = { error: "Reading the logs failed.", status: null };

/**
 * What axios rejects with when no HTTP response arrived: isAxiosError true,
 * NO response, a Node/axios `code`, and request values in config.
 */
export const rawAxiosError = (
  code: unknown,
  extra: Record<string, unknown> = {},
) => {
  const err: any = new Error(`${SENTINEL_ERR} connect failed`);
  err.isAxiosError = true;
  err.code = code;
  err.config = {
    url: LOGS_URL,
    headers: {
      Authorization: `Bearer ${SENTINEL_KEY}`,
      "X-API-Key": SENTINEL_KEY,
    },
  };
  err.request = { path: `${LOGS_URL}?token=${SENTINEL_KEY}` };
  Object.assign(err, extra);
  return err;
};

export const TLS_CODES = [
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];
export const TIMEOUT_CODES = [
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
];
export const DNS_CODES = ["ENOTFOUND", "EAI_AGAIN"];
export const UNREACHABLE_CODES = [
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_NETWORK",
  "ENETDOWN",
];

export const tlsText = (c: string) =>
  `Reading the logs failed: the TLS certificate of the Cognigy API host could not be verified (${c}). Typical causes: a corporate proxy or VPN that inspects traffic (ask IT for its root certificate and set NODE_EXTRA_CA_CERTS to it), an expired certificate, a wrong system clock, or a wrong host name in the API base URL. Restart the MCP client after changing NODE_EXTRA_CA_CERTS. Do not disable certificate verification.`;
export const timeoutText = (c: string) =>
  `Reading the logs failed: the connection timed out or was dropped (${c}). Check the network or VPN and try again.`;
export const dnsText = (c: string) =>
  `Reading the logs failed: the host name could not be resolved (${c}). Check the API base URL and the network.`;
export const unreachableText = (c: string) =>
  `Reading the logs failed: the host could not be reached (${c}). Check the API base URL, the network and any VPN.`;

/** [code, expected exact text] for every allowlisted code. */
export const ALLOWLIST: Array<[string, string]> = [
  ...TLS_CODES.map((c): [string, string] => [c, tlsText(c)]),
  ...TIMEOUT_CODES.map((c): [string, string] => [c, timeoutText(c)]),
  ...DNS_CODES.map((c): [string, string] => [c, dnsText(c)]),
  ...UNREACHABLE_CODES.map((c): [string, string] => [c, unreachableText(c)]),
];
