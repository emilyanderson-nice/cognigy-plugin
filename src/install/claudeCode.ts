/**
 * Install the Cognigy plugin into Claude Code (terminal + desktop/GUI — one path
 * via the `claude` CLI). When `claude` is on PATH we drive the plugin CLI, which
 * routes the API key to the OS keychain via `--config`. When it isn't (some
 * IDE/desktop installs don't expose the CLI), we fall back to writing the
 * ~/.cognigy-plugin/config.json creds file and printing the `/plugin` commands
 * for the user to paste in-app.
 */
import type { UserConfigFile } from "../userConfigFile.js";
import { writeUserConfigFile } from "../userConfigFile.js";
import { detectOnPath, runCliTool } from "./cliRunner.js";

import {
  FORK_MARKETPLACE_NAME as MARKETPLACE_NAME,
  FORK_PLUGIN_ID as PLUGIN_ID,
  FORK_REPO as MARKETPLACE,
} from "./forkIdentity.js";

export type InstallScope = "user" | "project";

/** `claude plugin marketplace add <owner/repo>` — idempotent (no-op if present). */
export function buildMarketplaceAddArgs(
  scope: InstallScope = "user",
): string[] {
  const args = ["plugin", "marketplace", "add", MARKETPLACE];
  return scope === "project" ? [...args, "--scope", "project"] : args;
}

/** `claude plugin update <id>` — pull the latest plugin version. */
export function buildPluginUpdateArgs(): string[] {
  return ["plugin", "update", PLUGIN_ID];
}

/** `claude plugin uninstall <id>`. */
export function buildPluginUninstallArgs(): string[] {
  return ["plugin", "uninstall", PLUGIN_ID];
}

/** `claude plugin marketplace remove <name>`. */
export function buildMarketplaceRemoveArgs(): string[] {
  return ["plugin", "marketplace", "remove", MARKETPLACE_NAME];
}

/** `claude plugin install <id> --scope user --config k=v ...`. */
export function buildPluginInstallArgs(
  creds: UserConfigFile,
  scope: InstallScope = "user",
): string[] {
  // Both scopes pass --config: the manifest's userConfig options are required,
  // and the sensitive key lands in Claude Code's user-level credential store,
  // never in the project's .claude/settings.json.
  return [
    "plugin",
    "install",
    PLUGIN_ID,
    "--scope",
    scope,
    "--config",
    `cognigy_api_base_url=${creds.COGNIGY_API_BASE_URL ?? ""}`,
    "--config",
    `cognigy_api_key=${creds.COGNIGY_API_KEY ?? ""}`,
  ];
}

/** Resolve `claude` on PATH, or null. */
export function detectClaudePath(): string | null {
  return detectOnPath("claude");
}

function runClaude(claudePath: string, args: string[]) {
  return runCliTool("claude", claudePath, args);
}

export type ClaudeCodeMethod = "cli" | "fallback";

export interface ClaudeCodeResult {
  method: ClaudeCodeMethod;
  /** Fallback only: creds file written + commands to paste in-app. */
  configFile?: string;
  commands?: string[];
}

/** The `/plugin` commands a user pastes in-app when the CLI isn't available. */
export function fallbackCommands(): string[] {
  return [
    `/plugin marketplace add ${MARKETPLACE}`,
    `/plugin install ${PLUGIN_ID}`,
  ];
}

// On Windows the claude CLI runs through cmd.exe, where a double quote breaks
// the quoting and %NAME% expands even inside quotes; line breaks and NUL are
// never valid in an argument. Reject them up front, never echoing the value.
const UNSAFE_ARG_CHARS = /["%\r\n\0]/;

function assertSafeToPass(field: string, value: string | undefined): void {
  if (value !== undefined && UNSAFE_ARG_CHARS.test(value)) {
    throw new Error(
      `The ${field} cannot be passed safely to the claude CLI because it contains ` +
        `a double quote, percent sign, line break or NUL character. Remove those characters and try again.`,
    );
  }
}

/**
 * Install into Claude Code. Uses the CLI when present; otherwise writes the
 * creds file and returns the manual commands. Throws only if the CLI is present
 * but the install step fails outright (after already writing the creds fallback
 * so the user isn't left with nothing).
 */
export function installClaudeCode(
  creds: UserConfigFile,
  scope: InstallScope = "user",
): ClaudeCodeResult {
  assertSafeToPass("API key", creds.COGNIGY_API_KEY);
  assertSafeToPass("API base URL", creds.COGNIGY_API_BASE_URL);

  const claudePath = detectClaudePath();

  if (!claudePath) {
    if (scope === "project") {
      throw new Error(
        "--project needs the `claude` CLI on your PATH, and it was not found. " +
          "Inside Claude Code you can use /plugin and choose project scope instead.",
      );
    }
    const configFile = writeUserConfigFile(creds);
    return { method: "fallback", configFile, commands: fallbackCommands() };
  }

  // Idempotent — a pre-existing marketplace exits 0. User scope logs and
  // continues (the install step surfaces a real failure); project scope aborts
  // before the install and before any creds are written.
  const add = runClaude(claudePath, buildMarketplaceAddArgs(scope));
  if (add.status !== 0 || add.error) {
    if (scope === "project") {
      throw new Error(
        `'claude plugin marketplace add' failed (${add.error ? add.error.message : `exit ${add.status}`}); project install aborted.`,
      );
    }
    process.stderr.write(
      `[cognigy] 'plugin marketplace add ${MARKETPLACE_NAME}' exited ${add.status}; continuing.\n`,
    );
  }

  // Project scope never touches the user's creds file: Claude Code keeps the
  // --config values in its own per-user store, and a project install must not
  // overwrite the real ~/.cognigy-plugin/config.json.
  const install = runClaude(claudePath, buildPluginInstallArgs(creds, scope));
  if (install.status !== 0 || install.error) {
    const reason = install.error
      ? install.error.message
      : `exit ${install.status}`;
    if (scope === "project") {
      throw new Error(
        `'claude plugin install' failed (${reason}). Nothing in your files outside the project was changed. ` +
          `Re-run "cognigy-setup install --project" once the problem is fixed (it is safe to repeat), ` +
          `or set the URL and key from inside Claude Code with: /plugin configure ${PLUGIN_ID}`,
      );
    }
    // Leave the user a working fallback before surfacing the failure.
    const configFile = writeUserConfigFile(creds);
    throw new Error(
      `'claude plugin install' failed (${reason}). Wrote creds to ${configFile}; ` +
        `paste these in Claude Code instead:\n  ${fallbackCommands().join("\n  ")}`,
    );
  }

  return { method: "cli" };
}

/** `/plugin` commands to update / uninstall by hand when the CLI isn't present. */
export function updateFallbackCommands(): string[] {
  return [`/plugin update ${PLUGIN_ID}`];
}
export function uninstallFallbackCommands(): string[] {
  return [
    `/plugin uninstall ${PLUGIN_ID}`,
    `/plugin marketplace remove ${MARKETPLACE_NAME}`,
  ];
}

/** The one-time toggle that opts a third-party marketplace into auto-update. */
export function autoUpdateHint(): string {
  return `/plugin → Marketplaces → ${MARKETPLACE_NAME} → enable auto-update`;
}

export interface ClaudeCodeActionResult {
  method: ClaudeCodeMethod;
  commands?: string[];
}

/** Update the plugin via the CLI when present; else return the manual command. */
export function updateClaudeCode(): ClaudeCodeActionResult {
  const claudePath = detectClaudePath();
  if (!claudePath)
    return { method: "fallback", commands: updateFallbackCommands() };
  const res = runClaude(claudePath, buildPluginUpdateArgs());
  if (res.status !== 0 || res.error) {
    const reason = res.error ? res.error.message : `exit ${res.status}`;
    throw new Error(`'claude plugin update' failed (${reason}).`);
  }
  return { method: "cli" };
}

export interface ClaudeCodeUninstallResult {
  method: ClaudeCodeMethod;
  /** CLI only: whether each step actually removed something (exit 0). */
  removedPlugin?: boolean;
  removedMarketplace?: boolean;
  /** Fallback only: the manual `/plugin` commands. */
  commands?: string[];
}

/**
 * Uninstall the plugin + remove the marketplace via the CLI; else manual.
 * Reports per-step success so callers don't claim a removal that didn't happen
 * (a "not installed" state exits non-zero — we log-and-continue, not fail).
 */
export function uninstallClaudeCode(): ClaudeCodeUninstallResult {
  const claudePath = detectClaudePath();
  if (!claudePath)
    return { method: "fallback", commands: uninstallFallbackCommands() };
  const un = runClaude(claudePath, buildPluginUninstallArgs());
  const removedPlugin = un.status === 0 && !un.error;
  if (!removedPlugin) {
    process.stderr.write(
      `[cognigy] 'plugin uninstall ${PLUGIN_ID}' did not remove anything (exit ${un.status}); continuing.\n`,
    );
  }
  const mp = runClaude(claudePath, buildMarketplaceRemoveArgs());
  const removedMarketplace = mp.status === 0 && !mp.error;
  return { method: "cli", removedPlugin, removedMarketplace };
}
