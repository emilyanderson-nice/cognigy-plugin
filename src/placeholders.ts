/** Detection of unexpanded plugin-manifest placeholders in env values. */
/**
 * True for a value that is nothing but an unexpanded `${...}` placeholder.
 *
 * `userConfig` is a Claude Code extension to the plugin manifest: Claude Code
 * prompts for the values and substitutes them into `mcpServers.*.env`. Hosts
 * that only implement the portable subset (VS Code / Copilot, Kiro, …) copy
 * the manifest text through verbatim, so the engine receives the literal
 * "${user_config.cognigy_api_key}". Those strings are non-empty, which means
 * that without this check they (a) reach axios as a real base URL and fail with
 * ERR_INVALID_URL, and (b) shadow the on-disk fallback written by the setup CLI.
 *
 * Deliberately anchored to the whole (trimmed) value: a real API key or URL is
 * never entirely wrapped in `${…}`, so this cannot discard a genuine credential.
 */
export function isUnexpandedPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("${") && trimmed.endsWith("}");
}

/** An env value, or undefined when absent or an unexpanded placeholder. */
export function usableEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return isUnexpandedPlaceholder(value) ? undefined : value;
}

/**
 * Extra sentence for the "not set" errors when the host handed us a
 * placeholder. Without it the message reads as "not set" to someone looking
 * straight at a manifest that plainly does set it.
 */
export function placeholderHint(raw: string | undefined): string {
  if (!raw || !isUnexpandedPlaceholder(raw)) return "";
  return (
    ` This host did not substitute the plugin manifest placeholder ${raw.trim()} ` +
    `(it does not support userConfig), so the value never arrived.`
  );
}
