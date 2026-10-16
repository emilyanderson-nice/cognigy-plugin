/** Keys shorter than this are too likely to collide with ordinary text. */
export const MIN_REDACTABLE_KEY_LENGTH = 8;

const REPLACEMENT = "[redacted]";

/**
 * Replaces every occurrence of an API key in `text`, in any letter case, so it
 * can never leak. Matching is literal (no regular expression is built from the
 * key). Keys under MIN_REDACTABLE_KEY_LENGTH characters are not redacted.
 */
export function redactKey(text: string, apiKey: string): string {
  if (!apiKey || apiKey.length < MIN_REDACTABLE_KEY_LENGTH) return text;
  const needle = apiKey.toLowerCase();
  const size = apiKey.length;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.slice(i, i + size).toLowerCase() === needle) {
      out += REPLACEMENT;
      i += size;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}
