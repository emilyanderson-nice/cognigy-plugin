// Safe form of a log message that may carry request URLs, query strings, form
// bodies or JSON: URLs shrink to host + path, query and form text and the JSON
// body go, and only the top-level key names of a small JSON object stay.
// Only the head the scrub pre-cut keeps is reduced; text beyond it is dropped
// (marked with an ellipsis), so it can never reach the output raw. Each scan is
// linear (no nested quantifiers, lookbehinds anchor every start), so a hostile
// message cannot make it expensive.

// Any `scheme://`; the lookbehind starts a scan only at the start of a scheme
// token and the length bound keeps each attempt constant-time.
const SCHEME = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,19}:\/\//g;
const NEXT_SPACE = /\s/g;
const AUTHORITY_END = /[/?#]/;
const QUERY_OR_FRAGMENT = /[?#]/;
// `?key=` and the rest of that whitespace-free token.
const RELATIVE_QUERY = /\?[\w.%-]+=\S*/g;
// Two or more key=value pairs joined by & with no spaces.
const FORM_RUN = /(?<![\w.%=-])[\w.%-]+=[^\s&]*(?:&[\w.%-]+=[^\s&]*)+/g;
const KEY_NAME = /^[a-z][A-Za-z0-9_]{0,29}$/;
const MAX_PAYLOAD_KEYS = 8;

// `host:port` as opposed to `user:password`: a 1-5 digit port after the last
// `:` and a host-like name (dotted, `localhost` or a bracketed IPv6 literal)
// before it, ignoring any `user@` prefix. A dotted username with a numeric
// password prefix before a reserved character is indistinguishable from this
// and is read as host:port (documented gap).
const PORT = /^\d{1,5}$/;
function isHostPort(authority: string): boolean {
  const colon = authority.lastIndexOf(":");
  if (colon === -1 || !PORT.test(authority.slice(colon + 1))) return false;
  const host = authority.slice(authority.lastIndexOf("@", colon) + 1, colon);
  return (
    host.includes(".") ||
    host.toLowerCase() === "localhost" ||
    (host.startsWith("[") && host.endsWith("]"))
  );
}

function reduceUrls(text: string): { text: string; risky: boolean } {
  let out = "";
  let from = 0;
  let risky = false;
  SCHEME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCHEME.exec(text)) !== null) {
    const start = m.index + m[0].length;
    NEXT_SPACE.lastIndex = start;
    const space = NEXT_SPACE.exec(text);
    const end = space ? space.index : text.length;
    const rest = text.slice(start, end);
    const authorityEnd = rest.search(AUTHORITY_END);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    // A password may contain `/`, `?` or `#`, which would end the authority
    // before its `@`. With a `:` in the authority (user:password, or host:port)
    // the userinfo therefore runs to the last `@` of the whole token, so no
    // part of a credential survives. The exception is a host-like name with a
    // numeric port: that is host:port, so an `@` in the path or query (a
    // `/@scope/pkg` route, an email) is not userinfo.
    const at = (
      isHostPort(authority)
        ? authority
        : authority.includes(":")
          ? rest
          : authority
    ).lastIndexOf("@");
    const remainder = rest.slice(at + 1);
    const query = remainder.search(QUERY_OR_FRAGMENT);
    risky ||= at !== -1 || query !== -1;
    out +=
      text.slice(from, m.index) +
      (query === -1 ? remainder : remainder.slice(0, query));
    from = end;
    SCHEME.lastIndex = end;
  }
  return { text: out + text.slice(from), risky };
}

function payloadToken(span: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(span);
  } catch {
    return "<payload>";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "<payload>";
  }
  const keys = Object.keys(parsed);
  return keys.length >= 1 &&
    keys.length <= MAX_PAYLOAD_KEYS &&
    keys.every((key) => KEY_NAME.test(key))
    ? `<payload:${keys.join(",")}>`
    : "<payload>";
}

const CUT_MARK = "…";

// `reduced` is the reduced head; text beyond the head (`msg` past `headLength`)
// is never copied or parsed. The payload span runs from the first `{` to the
// last `}` of the whole message; when that `}` lies past the head the result is
// a bare `<payload>`. Text before the first `{` and after the last `}` within
// the head is kept as it is.
function reducePayload(
  reduced: string,
  msg: string,
  headLength: number,
): string {
  const tailDropped = msg.length > headLength;
  const open = reduced.indexOf("{");
  if (open === -1) return tailDropped ? reduced + CUT_MARK : reduced;
  const before = reduced.slice(0, open);
  const close = msg.lastIndexOf("}");
  if (close < msg.indexOf("{")) return `${before}<payload>`;
  // A span that closes past the head is never parsed: its key names would come
  // from text the head cut dropped.
  if (close >= headLength) return `${before}<payload>`;
  const closeReduced = reduced.lastIndexOf("}");
  if (closeReduced < open) return `${before}<payload>`;
  return (
    before +
    payloadToken(reduced.slice(open, closeReduced + 1)) +
    reduced.slice(closeReduced + 1) +
    (tailDropped ? CUT_MARK : "")
  );
}

// Returns the reduced text, or null when the message is not risky. Risky: a
// URL with a query, fragment or userinfo, a `?key=` query, a form body of two
// or more pairs, or any `{`.
export function reduceRisky(msg: string, scanChars: number): string | null {
  const braces = msg.indexOf("{") !== -1;
  const head = msg.length > scanChars ? msg.slice(0, scanChars) : msg;
  const urls = reduceUrls(head);
  const withoutQuery = urls.text.replace(RELATIVE_QUERY, "");
  const withoutForms = withoutQuery.replace(FORM_RUN, "<form>");
  const risky =
    braces ||
    urls.risky ||
    withoutQuery !== urls.text ||
    withoutForms !== withoutQuery;
  return risky ? reducePayload(withoutForms, msg, head.length) : null;
}
