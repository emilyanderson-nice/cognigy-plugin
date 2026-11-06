/**
 * Shared by the read-only discovery probes (probe.mjs, vg-probe.mjs): reduce a response to its
 * SHAPE (types, array lengths, key names) so no id, name, address or number reaches disk, and replace
 * any string that contains a secret with <REDACTED>.
 */

export const SAFE_VALUE_KEYS = new Set([
  "type",
  "_type",
  "status",
  "version",
  "apiVersion",
  "kind",
  "mode",
  "state",
  "provider",
  "role",
  "resourceType",
  "nodeType",
  "locale",
  "code",
  "title",
  "next",
  "prev",
]);

// Tenant ids (24-hex object ids) never reach disk: not in file names, not in the stored path.
export const maskIds = (s) => s.replace(/[0-9a-f]{24}/gi, "{id}");

/** `secrets` is one string or a list of strings; a value containing any of them is redacted. */
export function makeRedactor(secrets) {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (s) => typeof s === "string" && s.length > 0,
  );
  const scrub = (s) => (list.some((x) => s.includes(x)) ? "<REDACTED>" : s);
  const classify = (s, key) => {
    if (/^[0-9a-f]{24}$/i.test(s)) return "<objectId>";
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    )
      return "<uuid>";
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return "<datetime>";
    if (/@[^\s]+\.[^\s]+/.test(s)) return "<email>";
    if (/^https?:\/\//i.test(s)) return "<url>";
    if (SAFE_VALUE_KEYS.has(key) && s.length <= 60) return s;
    return `<string:${s.length}>`;
  };
  const shape = (v, key = "", depth = 0, isError = false) => {
    if (v === null) return "null";
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "number") return "number";
    if (typeof v === "string")
      return isError && (key === "detail" || key === "msg") && v.length <= 200
        ? scrub(v)
        : classify(scrub(v), key);
    if (depth >= 8) return "<depth-limit>";
    if (Array.isArray(v))
      return {
        _array: v.length,
        _item: v.length ? shape(v[0], key, depth + 1) : null,
      };
    if (typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).slice(0, 80))
        out[k] = shape(v[k], k, depth + 1, isError);
      if (Object.keys(v).length > 80)
        out._truncatedKeys = Object.keys(v).length - 80;
      return out;
    }
    return typeof v;
  };
  return { shape, scrub };
}
