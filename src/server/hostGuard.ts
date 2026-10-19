/**
 * Host guard for talk_to_agent: an explicit `endpointUrl` may only target the
 * selected environment's own endpoint host, so a call for one environment can
 * never carry that environment's traffic to another host. Fails closed: any
 * URL that is not unambiguously an absolute http(s) URL on that host is
 * rejected. Reasons never contain the supplied URL.
 */

/** Backslashes and whitespace/control characters make parsers disagree on the host. */
// eslint-disable-next-line no-control-regex
const AMBIGUOUS_CHARS = /[\\\s\u0000-\u001f\u007f]/;

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

export type HostCheck =
  | { ok: true }
  /** `urlHost` is set only for a clean URL that simply names another host. */
  | { ok: false; urlHost?: string };

/** Accepts `endpointUrl` only if it unambiguously targets the host of `endpointBaseUrl`. */
export function checkEndpointUrl(
  endpointUrl: string,
  endpointBaseUrl: string,
): HostCheck {
  if (AMBIGUOUS_CHARS.test(endpointUrl)) return { ok: false };
  const target = parseHttpUrl(endpointUrl);
  const base = parseHttpUrl(endpointBaseUrl);
  if (!target || !base) return { ok: false };
  if (target.username !== "" || target.password !== "") return { ok: false };
  return target.host === base.host
    ? { ok: true }
    : { ok: false, urlHost: target.host };
}
