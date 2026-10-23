// Names a raw network failure of a log read without echoing anything the
// upstream said. Only an enumerated code is ever returned, and what is
// returned is the allowlist constant itself, never `err.code`.
//
// Overlap: REASONS in src/profiles/profileCliTest.ts classifies many of the
// same codes for the CLI connectivity test. Unifying the two tables is a
// recorded follow-up; that file is deliberately not changed here.

const TLS_CODES = [
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
] as const;
const TIMEOUT_CODES = [
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
] as const;
const DNS_CODES = ["ENOTFOUND", "EAI_AGAIN"] as const;
const UNREACHABLE_CODES = [
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_NETWORK",
  "ENETDOWN",
] as const;

const CLASSES: ReadonlyArray<{
  codes: readonly string[];
  text: (code: string) => string;
}> = [
  {
    codes: TLS_CODES,
    text: (code) =>
      `Reading the logs failed: the TLS certificate of the Cognigy API host could not be verified (${code}). ` +
      "Typical causes: a corporate proxy or VPN that inspects traffic (ask IT for its root certificate and set NODE_EXTRA_CA_CERTS to it), an expired certificate, a wrong system clock, or a wrong host name in the API base URL. " +
      "Restart the MCP client after changing NODE_EXTRA_CA_CERTS. Do not disable certificate verification.",
  },
  {
    codes: TIMEOUT_CODES,
    text: (code) =>
      `Reading the logs failed: the connection timed out or was dropped (${code}). Check the network or VPN and try again.`,
  },
  {
    codes: DNS_CODES,
    text: (code) =>
      `Reading the logs failed: the host name could not be resolved (${code}). Check the API base URL and the network.`,
  },
  {
    codes: UNREACHABLE_CODES,
    text: (code) =>
      `Reading the logs failed: the host could not be reached (${code}). Check the API base URL, the network and any VPN.`,
  },
];

// The code is read only from a raw network-layer AxiosError (no response).
// Plain Errors built from a response body carry a platform `code`, which must
// never qualify.
export function networkErrorBody(
  err: unknown,
): { error: string; status: null; code: string } | undefined {
  const e = err as { isAxiosError?: unknown; response?: unknown } | null;
  if (e?.isAxiosError !== true || e.response !== undefined) return undefined;
  const raw = (err as { code?: unknown }).code;
  if (typeof raw !== "string") return undefined;
  for (const { codes, text } of CLASSES) {
    const code = codes.find((c) => c === raw);
    if (code !== undefined) return { error: text(code), status: null, code };
  }
  return undefined;
}
