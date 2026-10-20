#!/usr/bin/env node
/**
 * `cognigy-setup` — one-command installer for the NiCE Cognigy Plugin.
 * Run: `npx --allow-git=root -y -p github:<fork repo> cognigy-setup` (the fork repository,
 * FORK_REPO below).
 *
 * Collects the Cognigy API base URL + key (key masked, never echoed or written
 * to shell history), asks which client(s) to set up, and performs the full
 * install + credential wiring for each:
 *   - Claude Code (terminal + desktop/GUI): via the `claude` plugin CLI when
 *     present (key → keychain), else a creds-file fallback + printed commands.
 *   - Claude Desktop (standalone app): merges an auto-updating MCP server entry
 *     into claude_desktop_config.json.
 *   - ChatGPT + Codex (CLI + IDE): `codex plugin add` (the plugin's own server)
 *     + plugin marketplace for skills; creds-file only.
 *   - Antigravity (IDE + `agy` CLI): stages a plugin and registers it, writing
 *     MCP servers, skills and agents into the shared ~/.gemini/config tree.
 *
 * Non-interactive (scripting/CI): pass --client, --api-base-url, --api-key.
 *
 * `install --project` installs the plugin for the CURRENT PROJECT only (Claude
 * Code project scope, declared in .claude/settings.json) instead of for the
 * user. Claude Code is the only client that supports it.
 */
import { createInterface } from "readline";
import { pathToFileURL } from "url";
import type { UserConfigFile } from "./userConfigFile.js";
import { writeUserConfigFile } from "./userConfigFile.js";
import {
  autoUpdateHint,
  detectClaudePath,
  installClaudeCode,
  uninstallClaudeCode,
  updateClaudeCode,
  type InstallScope,
} from "./install/claudeCode.js";
import {
  FORK_PLUGIN_ID,
  FORK_REPO,
  getEngineSpec,
} from "./install/forkIdentity.js";
import { prewarmEngine } from "./install/prewarm.js";
import {
  desktopHasCognigyEntry,
  installClaudeDesktop,
  installedDesktopEngineVersion,
  purgeUserHome,
  resolveDesktopConfigPath,
  uninstallClaudeDesktop,
} from "./install/claudeDesktop.js";
import {
  antigravityHasPlugin,
  detectAntigravity,
  installAntigravity,
  installedPluginVersion,
  uninstallAntigravity,
  updateAntigravity,
} from "./install/antigravity.js";
import { detectOnPath } from "./install/cliRunner.js";
import {
  DESKTOP_LAUNCHER_FILE,
  writeDesktopLauncher,
} from "./install/desktopLauncher.js";
import {
  codexGuiSteps,
  codexHasCognigyPlugin,
  installCodex,
  uninstallCodex,
  updateCodex,
} from "./install/codex.js";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, join, parse, resolve } from "path";
import { CognigyApiClient } from "./api/client.js";
import { runProfileCommand } from "./profiles/profileCli.js";
import { loadProfilesFromSystem } from "./profiles/profiles.js";
import {
  removeProfile,
  setDefaultProfile,
  upsertProfile,
} from "./profiles/profilesStore.js";

const DEFAULT_BASE_URL = "https://api-trial.cognigy.ai";

// ANSI styling — auto-disabled when stdout is not a TTY or NO_COLOR is set, so
// piped/CI output stays plain text.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap =
  (open: string, close: string) =>
  (t: string): string =>
    useColor ? `\x1b[${open}m${t}\x1b[${close}m` : t;
const bold = wrap("1", "22");
const dim = wrap("2", "22");
const green = wrap("32", "39");
const cyan = wrap("36", "39");
const yellow = wrap("33", "39");
const RULE = "═".repeat(60);

// Control codes handled during masked input.
const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = 8;
const DELETE = 127;

type Client =
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "antigravity"
  | "other-hosts";
// "other-hosts" is last on purpose: it is the catch-all for clients we do not
// wire, so it reads as the fallback at the bottom of the menu.
const ALL_CLIENTS: Client[] = [
  "claude-code",
  "claude-desktop",
  "codex",
  "antigravity",
  "other-hosts",
];
const CLIENT_LABELS: Record<Client, string> = {
  // Post-Apr-2026 Desktop redesign: the standalone CLI and Desktop's "Code" tab
  // share ~/.claude, so one Claude-Code install serves both. "Claude Desktop"
  // here means the separate Chat connector wired into claude_desktop_config.json.
  "claude-code": "Claude Code (CLI + Desktop 'Code' tab)",
  "claude-desktop": "Claude Desktop chat (standalone connector)",
  // OpenAI merged Codex into the ChatGPT desktop app (July 2026); one
  // ~/.codex/config.toml serves that app, the CLI, and the IDE extension.
  codex: "ChatGPT + Codex (CLI + IDE)",
  // The IDE, the `agy` CLI and the SDK all read ~/.gemini/config, so one install
  // serves every Antigravity surface.
  antigravity: "Antigravity (IDE + agy CLI)",
  "other-hosts": "Other hosts (VS Code, Kiro, …) — writes a local creds file",
};

interface Flags {
  clients: Client[];
  /** --client values that are not (or no longer) valid targets — kept, not
   * silently dropped, so callers can refuse to act on them. */
  invalidClients: string[];
  apiBaseUrl?: string;
  apiKey?: string;
  /** --project: install for the current project (Claude Code only). */
  project: boolean;
}

function isClient(v: string): v is Client {
  return (ALL_CLIENTS as string[]).includes(v);
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { clients: [], invalidClients: [], project: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => argv[++i];
    const addClient = (v: string | undefined) => {
      // An empty value (`--client=$UNSET`, or a trailing `--client`) must be
      // rejected too: silently ignoring it leaves the selection empty, and on
      // uninstall an empty selection means "every client".
      if (!v) v = "(empty)";
      if (isClient(v)) {
        if (!flags.clients.includes(v)) flags.clients.push(v);
      } else if (!flags.invalidClients.includes(v)) {
        flags.invalidClients.push(v);
      }
    };
    if (arg === "--api-base-url") flags.apiBaseUrl = take();
    else if (arg.startsWith("--api-base-url="))
      flags.apiBaseUrl = arg.slice("--api-base-url=".length);
    else if (arg === "--api-key") flags.apiKey = take();
    else if (arg.startsWith("--api-key="))
      flags.apiKey = arg.slice("--api-key=".length);
    else if (arg === "--client") addClient(take());
    else if (arg.startsWith("--client="))
      addClient(arg.slice("--client=".length));
    else if (arg === "--project") flags.project = true;
  }
  return flags;
}

/**
 * Resolve scope + target clients. Project scope is Claude Code only: it
 * defaults to that client and rejects any other rather than narrowing the list
 * silently (a dropped client would look installed when it is not).
 */
export function planInstall(
  flags: Pick<Flags, "project" | "clients">,
): { scope: InstallScope; clients: Client[] } | { error: string } {
  if (!flags.project) return { scope: "user", clients: flags.clients };
  const unsupported = flags.clients.filter((c) => c !== "claude-code");
  if (unsupported.length > 0) {
    return {
      error:
        `--project only supports claude-code; it cannot be combined with: ${unsupported.join(", ")}. ` +
        "Drop those --client values, or run without --project for a user-wide install.",
    };
  }
  return { scope: "project", clients: ["claude-code"] };
}

/** The error text for unknown --client values (with a hint for retired ones). */
export function unknownClientsMessage(invalid: string[]): string {
  return (
    `Unknown --client value(s): ${invalid.join(", ")}. Valid values: ${ALL_CLIENTS.join(", ")}.\n` +
    (invalid.includes("gemini")
      ? `  Gemini CLI support was removed: https://github.com/${FORK_REPO}/blob/main/docs/install/gemini-cli.md\n` +
        "  Remove an installed extension with: gemini extensions uninstall cognigy\n"
      : "")
  );
}

/**
 * Exit loudly on unknown or empty --client values. Ignoring them is unsafe on
 * uninstall: `uninstall --client gemini --yes` (a retired target) or
 * `uninstall --client= --yes` would leave the selection empty, fall through to
 * the no-filter default, and remove the plugin from every client the user
 * meant to keep.
 */
function rejectInvalidClients(invalid: string[]): void {
  if (invalid.length === 0) return;
  process.stderr.write(unknownClientsMessage(invalid));
  process.exit(1);
}

/** Which clients look installed — used to pre-select the interactive menu. */
export function detectClients(): Record<Client, boolean> {
  return {
    "claude-code": detectClaudePath() !== null,
    "claude-desktop": existsSync(dirname(resolveDesktopConfigPath())),
    // Config-dir probe as well as PATH: the IDE extension / ChatGPT desktop
    // app share ~/.codex without necessarily exposing the CLI.
    codex:
      detectOnPath("codex") !== null || existsSync(join(homedir(), ".codex")),
    antigravity: detectAntigravity(),
    // Never auto-detected, so it is never pre-checked: writing a plaintext key
    // to disk must stay an explicit choice. Claude-only users keep the keychain
    // path with nothing on disk.
    "other-hosts": false,
  };
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Read a line without echoing it (masked with asterisks). */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const finish = (cleanup: () => void) => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      cleanup();
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r" || code === CTRL_D) {
          finish(() => resolve(value));
          return;
        }
        if (code === CTRL_C) {
          finish(() => reject(new Error("cancelled")));
          return;
        }
        if (code === BACKSPACE || code === DELETE) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += ch;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

/** Parse a comma/space-separated menu answer like "1,2" into client keys. */
export function parseClientSelection(answer: string, menu: Client[]): Client[] {
  const picked: Client[] = [];
  for (const tok of answer.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(tok);
    const client = Number.isInteger(n) ? menu[n - 1] : undefined;
    if (client && !picked.includes(client)) picked.push(client);
  }
  return picked;
}

/**
 * Interactive checkbox list: ↑/↓ (or j/k) move, Space toggles, Enter confirms
 * (requires at least one selection), Ctrl-C cancels. Redraws in place via ANSI
 * cursor moves. Requires a raw-mode TTY — callers fall back otherwise.
 */
function checkboxSelect(
  items: { label: string; checked: boolean }[],
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const state = items.map((it) => it.checked);
    let cursor = 0;
    // Lines we own and redraw: one per item + one help line.
    const rows = items.length + 1;

    const render = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${rows}A`);
      items.forEach((it, i) => {
        const pointer = i === cursor ? cyan("❯") : " ";
        const box = state[i] ? green("[x]") : "[ ]";
        process.stdout.write(`\x1b[2K\r ${pointer} ${box} ${it.label}\n`);
      });
      process.stdout.write(
        `\x1b[2K\r${dim("   ↑/↓ move · Space check/uncheck · Enter confirm")}\n`,
      );
    };

    const cleanup = () => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk: string) => {
      if (chunk === "\x03") {
        cleanup();
        reject(new Error("cancelled"));
        return;
      }
      if (chunk === "\r" || chunk === "\n") {
        const picked = state
          .map((on, i) => (on ? i : -1))
          .filter((i) => i >= 0);
        if (picked.length === 0) return; // require at least one
        cleanup();
        process.stdout.write("\n");
        resolve(picked);
        return;
      }
      if (chunk === " ") {
        state[cursor] = !state[cursor];
        render(false);
        return;
      }
      if (chunk === "\x1b[A" || chunk === "\x1bOA" || chunk === "k") {
        cursor = (cursor - 1 + items.length) % items.length;
        render(false);
        return;
      }
      if (chunk === "\x1b[B" || chunk === "\x1bOB" || chunk === "j") {
        cursor = (cursor + 1) % items.length;
        render(false);
        return;
      }
    };

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    render(true);
    stdin.on("data", onData);
  });
}

async function chooseClients(): Promise<Client[]> {
  const detected = detectClients();
  const menu = ALL_CLIENTS;
  process.stdout.write(
    bold("Where should the NiCE Cognigy plugin be installed?\n"),
  );

  // Non-TTY (rare in interactive mode): fall back to a numbered text prompt.
  if (!process.stdin.isTTY) {
    menu.forEach((c, i) => {
      const mark = detected[c] ? green(" (detected)") : "";
      process.stdout.write(
        `  ${cyan(String(i + 1))}) ${CLIENT_LABELS[c]}${mark}\n`,
      );
    });
    const defaults = menu.filter((c) => detected[c]);
    const defaultLabel = defaults.length
      ? defaults.map((c) => menu.indexOf(c) + 1).join(",")
      : "1";
    const answer = await ask(
      `Select (comma-separated numbers) [${defaultLabel}]: `,
    );
    const chosen = answer
      ? parseClientSelection(answer, menu)
      : defaults.length
        ? defaults
        : [menu[0]];
    return chosen.length ? chosen : [menu[0]];
  }

  const items = menu.map((c) => ({
    label: `${CLIENT_LABELS[c]}${detected[c] ? green(" (detected)") : ""}`,
    checked: detected[c],
  }));
  const picked = await checkboxSelect(items);
  return picked.map((i) => menu[i]);
}

/** Success text for a project-scope Claude Code install. */
export function projectInstallSummary(cwd: string): string {
  return (
    `\n  Project: ${cwd}\n` +
    "  The plugin is declared in that folder's .claude/settings.json, so you can commit it for your teammates.\n" +
    "  The API key is NOT in the project: Claude Code keeps it in its own per-user credential store.\n" +
    "  Claude Code may ask you to trust the project settings the first time you open the project.\n"
  );
}

const PROJECT_FLAG_SUBCOMMANDS = ["uninstall", "update", "status"];

/** `--project` only applies to `install`; explain how to undo a project install. */
export function rejectProjectFlag(
  subcommand: string,
  argv: string[],
): string | undefined {
  if (!PROJECT_FLAG_SUBCOMMANDS.includes(subcommand)) return undefined;
  if (!argv.includes("--project")) return undefined;
  return (
    `--project is not supported by '${subcommand}': it only applies to 'install'.\n` +
    "To remove a project install, run this in the project folder:\n" +
    `  claude plugin uninstall ${FORK_PLUGIN_ID} --scope project\n`
  );
}

function stripTrailingSeparators(p: string): string {
  const root = parse(p).root;
  let out = p;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** Refuses a home folder or filesystem root; warns when it is not a project root. */
export function projectDirProblem(
  cwd: string,
  home: string,
  exists: (path: string) => boolean,
): { refuse?: string; warn?: string } | undefined {
  const norm = (p: string): string => {
    const s = stripTrailingSeparators(resolve(p));
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  const dir = norm(cwd);
  if (dir === norm(home)) {
    return {
      refuse:
        `Refusing a project install in your home folder (${cwd}): it would apply to every project under it.\n` +
        "Run this from the project folder instead.",
    };
  }
  if (dir === norm(parse(resolve(cwd)).root)) {
    return {
      refuse:
        `Refusing a project install at the filesystem root (${cwd}).\n` +
        "Run this from the project folder instead.",
    };
  }
  if (!exists(join(cwd, ".git")) && !exists(join(cwd, ".claude"))) {
    return {
      warn:
        `Note: ${cwd} does not look like a project root (no .git or .claude folder).\n` +
        "Continuing; make sure this is the folder you want the plugin declared in.",
    };
  }
  return undefined;
}

function runInstall(
  client: Client,
  creds: UserConfigFile,
  scope: InstallScope = "user",
): void {
  if (client === "other-hosts") {
    // Nothing to wire: these hosts either install the plugin themselves (VS
    // Code reads our Claude-format manifest) or take a hand-written MCP entry.
    // What they cannot do is supply credentials — `userConfig` is Claude-only,
    // so they pass "${user_config.*}" through untouched. The engine treats such
    // placeholders as unset and falls back to this file.
    const configFile = writeUserConfigFile(creds);
    process.stdout.write(
      green("\n✓ Other hosts") +
        `: wrote credentials to ${configFile} ` +
        dim("(dir 0700, file 0600)") +
        ".\n" +
        "  Any host that starts the engine now picks these up automatically.\n\n" +
        `  ${bold("VS Code / Copilot")} — install the plugin, then restart:\n` +
        `      ${cyan("1.")} Set ${bold('"chat.plugins.enabled": true')} in settings.json.\n` +
        `      ${cyan("2.")} Add ${bold(`"chat.plugins.marketplaces": ["${FORK_REPO}"]`)}.\n` +
        `      ${cyan("3.")} Extensions view → search ${bold("@agentPlugins")} → install ${bold("cognigy")}.\n` +
        dim(
          "  You get tools, skills, and agents. Leave the credential fields alone —\n" +
            "  VS Code has no prompt for them; this file covers it.\n",
        ),
    );
    // The manifest's `npx` is resolved from PATH, and some hosts have been seen
    // to start it with a PATH that excludes a node installed via nvm/fnm/volta
    // (their bin dir is added by the shell profile, which a GUI-launched app
    // need not have sourced). Not reproducible on demand — printed as
    // conditional troubleshooting, not as a known defect.
    process.stdout.write(
      "\n" +
        yellow(bold("  If the server fails with 'npx: command not found':")) +
        "\n" +
        `    ${cyan("•")} Your node is probably from nvm/fnm/volta, whose bin dir the host may not have on PATH.\n` +
        `    ${cyan("•")} Quit the host completely and relaunch it from a terminal, or\n` +
        `    ${cyan("•")} point the MCP entry at an absolute path — find it with ${dim(process.platform === "win32" ? "where npx" : "which npx")}.\n`,
    );
    return;
  }
  if (client === "claude-code") {
    const res = installClaudeCode(creds, scope);
    if (res.method === "cli" && scope === "project") {
      process.stdout.write(
        green(bold("\n✅ Claude Code — installed for THIS project.")) +
          projectInstallSummary(process.cwd()),
      );
    } else if (res.method === "cli") {
      process.stdout.write(
        green(bold("\n✅ Claude Code — all set.")) +
          " Plugin installed via the claude CLI " +
          dim("(key stored in keychain)") +
          ".\n  Just restart Claude Code (or /reload-plugins) — you get " +
          green("tools, skills, and agents") +
          ". No further steps.\n" +
          dim(
            "  This install is shared with the Claude Desktop 'Code' tab.\n" +
              `  To get future fixes automatically, enable auto-update once:\n    ${autoUpdateHint()}\n`,
          ),
      );
    } else {
      // No `claude` CLI on PATH. This is the Desktop-only case: `/plugin`
      // commands only work inside a *terminal* Claude Code session, NOT the
      // Desktop "Code" tab — there, plugins install via the GUI plugin browser.
      process.stdout.write(
        green("\n✓ Claude Code") +
          `: 'claude' CLI not found — wrote creds to ${res.configFile}.\n` +
          "  Finish in whichever Claude Code you use:\n\n" +
          `  ${bold("• Terminal Claude Code")} — paste these in a session:\n` +
          (res.commands ?? []).map((c) => cyan(`      ${c}`)).join("\n") +
          "\n\n" +
          `  ${bold("• Claude Desktop → 'Code' tab")} — use the plugin browser:\n` +
          `      ${cyan("1.")} Click ${bold("+")} near the prompt → ${bold("Plugins")} → ${bold("Add plugin")}.\n` +
          `      ${cyan("2.")} Add the marketplace ${bold(FORK_REPO)}, then install the ${bold("Cognigy")} plugin.\n`,
      );
    }
    if (res.method === "cli") {
      // A cold first launch downloads + builds the engine, which can outlast
      // Claude Code's 30s MCP connect timeout. Best-effort: never fails the install.
      let warm: ReturnType<typeof prewarmEngine>;
      try {
        warm = prewarmEngine(getEngineSpec());
      } catch (err) {
        // getEngineSpec reads package.json and can throw.
        warm = {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      process.stdout.write(
        warm.ok
          ? dim(
              "  Engine cache primed — the first session should connect promptly.\n",
            )
          : yellow(
              `  ⚠ Could not pre-warm the engine cache (${warm.reason}). The first session may time out connecting; run /mcp and reconnect to fix it.\n`,
            ),
      );
    }
    // Windows: a normal Claude Code restart often isn't enough — the old
    // process lingers and the plugin won't load. Users must fully kill it or
    // reboot before the tools/skills/agents appear.
    if (process.platform === "win32") {
      process.stdout.write(
        "\n" +
          cyan(bold("  Windows — finish applying the plugin:\n")) +
          `    ${cyan("•")} ${bold("Fully quit")} Claude Code — end every ${bold("Claude")} process in ${bold("Task Manager")} (a normal close can leave it running), then reopen it.\n` +
          `    ${cyan("•")} If the tools/skills/agents still don't appear, ${bold("restart your machine")}.\n`,
      );
    }
    return;
  }
  if (client === "codex") {
    const res = installCodex(creds);
    if (res.method === "cli" && res.installedPlugin) {
      process.stdout.write(
        green(bold("\n✅ ChatGPT + Codex — all set.")) +
          ` Plugin installed; credentials in ${res.configFile}.\n` +
          dim(
            "  (one install serves the ChatGPT desktop app, the Codex CLI, and the IDE extension)\n",
          ) +
          `  Start a ${bold("new thread")} — you get ${green("tools and skills")}.\n` +
          dim(
            "  Codex loads plugins at session start, so an open thread won't see them.\n",
          ),
      );
    } else {
      // Either no `codex` on PATH, or a CLI step failed. The creds file is
      // written either way, so the remaining work is entirely in-app.
      process.stdout.write(
        green("\n✓ ChatGPT + Codex") +
          `: wrote credentials to ${res.configFile}.\n` +
          "  Finish in the ChatGPT app:\n\n" +
          (res.guiSteps ?? codexGuiSteps())
            .map((step, i) => `    ${cyan(`${i + 1}.`)} ${step}\n`)
            .join("") +
          "\n" +
          `    ${cyan("5.")} Start a ${bold("new thread")}.\n` +
          dim(
            "  Or, in a Codex session: /plugins → install cognigy from cognigy-plugin.\n",
          ),
      );
    }
    if (process.platform === "win32") {
      process.stdout.write(
        "\n" +
          cyan(bold("  Windows — finish applying:\n")) +
          `    ${cyan("•")} ${bold("Fully quit")} the ChatGPT desktop app / Codex IDE extension (end lingering processes in ${bold("Task Manager")}), then reopen.\n`,
      );
    }
    return;
  }
  if (client === "antigravity") {
    const res = installAntigravity(creds);
    process.stdout.write(
      green(bold("\n✅ Antigravity — all set.")) +
        ` Plugin installed to ${res.pluginDir}\n` +
        `  ${green(String(res.skills.length))} skills · ${green(String(res.agents.length))} agents · ` +
        green("2") +
        " MCP servers\n" +
        dim(
          `  API key stored in ${res.credsFile}, not in any mcp_config.json.\n`,
        ) +
        "  Restart Antigravity — the IDE and the " +
        bold("agy") +
        " CLI share this config, so you get " +
        green("tools, skills, and agents") +
        " in both.\n" +
        dim(
          "  The engine auto-updates on every launch; run `cognigy-setup update` to re-stage skills and agents.\n",
        ),
    );
    if (res.removedLegacyServer) {
      process.stdout.write(
        dim(
          "  Removed an older 'cognigy' entry from the global mcp_config.json so only one engine boots.\n",
        ),
      );
    }
    if (res.skills.length === 0) {
      // Only possible from a broken/partial package — the assets ship in dist.
      process.stdout.write(
        yellow(
          "  ⚠ No skills found in this engine build; tools will work but workflow guidance won't load.\n",
        ),
      );
    }
    printUpstreamEngineNotice(client);
    return;
  }
  // claude-desktop
  const res = installClaudeDesktop(creds);
  process.stdout.write(
    green("\n✓ Claude Desktop") +
      `: 'Cognigy' connector added to ${res.configPath}\n` +
      (res.backupPath
        ? dim(`  (backed up existing config to ${res.backupPath})\n`)
        : "") +
      "  Restart Claude Desktop — the 'Cognigy' connector gives you the " +
      bold("tools") +
      ".\n",
  );
  // Windows Desktop needs a firmer restart + a tool-refresh nudge, else the
  // connector either doesn't appear or appears with no tools loaded.
  if (process.platform === "win32") {
    process.stdout.write(
      "\n" +
        cyan(bold("  Windows — make the connector appear:\n")) +
        `    ${cyan("•")} If this run hit a permissions error, re-run it in a terminal opened ${bold("as Administrator")}.\n` +
        `    ${cyan("•")} ${bold("Fully quit")} Claude Desktop from the system tray (closing the window leaves it running), then reopen it.\n` +
        `    ${cyan("•")} Confirm the ${bold("Cognigy")} connector shows under Settings → Connectors.\n` +
        `    ${cyan("•")} Then ${bold("disable it and re-enable it once")} to force a tool refresh.\n`,
    );
  }
  // A loud, unmissable block: on Desktop chat, skills + agents come ONLY from
  // these manual in-app steps. Without them the user has tools and nothing else.
  process.stdout.write(
    "\n" +
      yellow(RULE) +
      "\n" +
      yellow(bold("  ⚠️  ONE MORE STEP — CLAUDE DESKTOP CHAT ONLY  ⚠️")) +
      "\n" +
      yellow(RULE) +
      "\n" +
      bold("  You are NOT done yet.") +
      " The connector gives you tools only.\n" +
      "  " +
      bold(yellow("SKILLS & AGENTS install ONLY via these in-app steps")) +
      " —\n  do them now, in Claude Desktop:\n\n" +
      `    ${cyan("1.")} In chat, go ${bold("Customize")} → ${bold("Plugins")} → ${bold("Add")} → ${bold("Add marketplace")}.\n` +
      `    ${cyan("2.")} In the URL field enter ${bold(FORK_REPO)}, select the result, click ${bold("Sync")}.\n` +
      `    ${cyan("3.")} The ${bold("cognigy-plugin")} marketplace is now added.\n` +
      `    ${cyan("4.")} Install the ${bold("Cognigy")} plugin by clicking ${bold("+")}.\n` +
      `    ${cyan("5.")} On the local-MCP warning, click ${bold("Continue")}.\n\n` +
      dim(
        "  Leave the plugin's own 'platform' connector unconnected — the\n" +
          "  'Cognigy' connector already serves the tools.\n",
      ) +
      yellow(RULE) +
      "\n",
  );
  printUpstreamEngineNotice(client);
}

/**
 * Desktop and Antigravity launch the engine through the shared launcher, which
 * pulls Cognigy's published npm package rather than this fork's engine.
 */
export function upstreamEngineNotice(client: string): string | undefined {
  if (client !== "claude-desktop" && client !== "antigravity") return undefined;
  return (
    "Note: this client runs Cognigy's published engine, without this fork's changes. " +
    "Re-running the installer does not change that for now.\n"
  );
}

function printUpstreamEngineNotice(client: string): void {
  const notice = upstreamEngineNotice(client);
  if (notice) process.stdout.write("\n" + yellow(notice));
}

/** Indented, dim variant of the notice for `status` output. */
function printUpstreamEngineNoticeDim(client: string): void {
  const notice = upstreamEngineNotice(client);
  if (notice) process.stdout.write(dim(`    ${notice}`));
}

/** `status` — report what's installed on each surface. */
function runStatus(): void {
  const cliPath = detectClaudePath();
  const desktopEngine = installedDesktopEngineVersion();
  const desktopWired = desktopHasCognigyEntry();

  process.stdout.write(bold(cyan("\nNiCE Cognigy Plugin — status\n\n")));
  process.stdout.write(
    `  Claude Code CLI:      ${cliPath ? green("found") + dim(` (${cliPath})`) : yellow("not on PATH")}\n`,
  );
  if (cliPath) {
    process.stdout.write(
      dim("    Plugin version is managed by Claude Code — see `/plugin`.\n"),
    );
  }
  process.stdout.write(
    `  Claude Desktop chat:  ${desktopWired ? green("connector wired") : dim("not wired")}` +
      (desktopEngine ? dim(` · engine ${desktopEngine}`) : "") +
      "\n",
  );
  if (desktopWired) printUpstreamEngineNoticeDim("claude-desktop");
  const agPlugin = antigravityHasPlugin();
  const agVersion = installedPluginVersion();
  process.stdout.write(
    `  Antigravity:          ${agPlugin ? green("plugin installed") : dim("not installed")}` +
      (agVersion ? dim(` · v${agVersion}`) : "") +
      "\n",
  );
  if (agPlugin) printUpstreamEngineNoticeDim("antigravity");
  process.stdout.write(
    `  ChatGPT + Codex:      ${codexHasCognigyPlugin() ? green("plugin installed") : dim("not installed")}\n`,
  );
  process.stdout.write("\n");
}

/** `update` — pull the latest plugin (Claude Code); Desktop auto-updates. */
function runUpdate(): void {
  process.stdout.write(bold(cyan("\nUpdating NiCE Cognigy Plugin\n\n")));
  const res = updateClaudeCode();
  if (res.method === "cli") {
    process.stdout.write(
      green("✓ Claude Code") +
        ": plugin updated. Restart Claude Code (or /reload-plugins) to apply.\n",
    );
  } else {
    process.stdout.write(
      yellow("• Claude Code") +
        ": 'claude' CLI not found. To update, run in a session:\n" +
        (res.commands ?? []).map((c) => cyan(`    ${c}`)).join("\n") +
        "\n",
    );
  }
  // The launcher lives outside the versioned engine dir, so it is the one file
  // an engine bump cannot refresh. Rewrite it — but only where one already
  // exists, so this never creates a launcher on a machine using neither client.
  if (existsSync(DESKTOP_LAUNCHER_FILE)) writeDesktopLauncher();
  process.stdout.write(
    dim(
      "• Claude Desktop chat connector auto-updates its engine on every restart — nothing to do.\n",
    ),
  );
  // Codex auto-upgrades git marketplaces on plugin startup, so this is only a
  // "don't wait for the next app start" nudge. Only touch it when the plugin
  // is actually installed, so `plugin add` can't register a plugin for someone
  // who never wanted one.
  if (codexHasCognigyPlugin()) {
    const cx = updateCodex();
    if (cx.method === "fallback") {
      // No CLI to drive, and nothing to do: Codex refreshes the marketplace
      // itself at the next start. Printing `codex ...` here would be useless
      // advice for someone who demonstrably has no `codex`.
      process.stdout.write(
        dim(
          "• ChatGPT + Codex: 'codex' CLI not found — restart the app instead; it refreshes plugins itself on startup.\n",
        ),
      );
    } else if (cx.refreshed && cx.reinstalled) {
      process.stdout.write(
        green("✓ ChatGPT + Codex") +
          ": marketplace refreshed and plugin re-installed. Restart the app (or start a new thread) to apply.\n" +
          dim(
            "  (Codex would have picked this up on its own at the next app start.)\n",
          ),
      );
    } else if (cx.reinstalled) {
      // `plugin add` re-installed from a snapshot the upgrade failed to move,
      // so this may well be the version already installed. Don't call it a
      // refresh.
      process.stdout.write(
        yellow("• ChatGPT + Codex") +
          ": plugin re-installed, but refreshing the marketplace failed — you may still be on the previous version.\n" +
          dim(
            "  Codex retries the refresh on its own at the next app start.\n",
          ),
      );
    } else {
      process.stdout.write(
        yellow("• ChatGPT + Codex") +
          ": update failed — run it by hand:\n" +
          cyan("    codex plugin marketplace upgrade\n") +
          cyan(`    codex plugin add ${FORK_PLUGIN_ID}\n`),
      );
    }
  } else {
    process.stdout.write(
      dim("• ChatGPT + Codex: plugin not installed — nothing to update.\n"),
    );
  }
  // Antigravity's engine auto-updates via the launcher, but the plugin's skills
  // and agents are plain files — only a re-stage picks up a newer engine's copy.
  if (antigravityHasPlugin()) {
    const ag = updateAntigravity();
    process.stdout.write(
      green("✓ Antigravity") +
        `: plugin re-synced (${ag.skills.length} skills, ${ag.agents.length} agents). Restart Antigravity to apply.\n` +
        dim(
          "  (From now on the launcher does this itself on the first launch after a release.)\n",
        ),
    );
  } else {
    process.stdout.write(
      dim("• Antigravity: plugin not installed — nothing to update.\n"),
    );
  }
  process.stdout.write("\n");
}

/**
 * `uninstall` — remove the plugin + connector. `--client` narrows it to one or
 * more clients (default: all, matching `install`'s flag). `--purge` also drops
 * ~/.cognigy-plugin, which is shared by every client, so it runs independently
 * of which clients were selected.
 */
async function runUninstall(argv: string[]): Promise<void> {
  const purge = argv.includes("--purge");
  const assumeYes = argv.includes("--yes") || argv.includes("-y");
  const flags = parseFlags(argv);
  rejectInvalidClients(flags.invalidClients);
  const selected = flags.clients;
  const targets = selected.length > 0 ? selected : [...ALL_CLIENTS];
  const wants = (client: Client) => targets.includes(client);

  process.stdout.write(bold(cyan("\nUninstalling NiCE Cognigy Plugin\n\n")));
  // ~/.cognigy-plugin holds the credentials the engine falls back to for every
  // client — purging it while leaving other clients wired breaks them.
  if (purge && selected.length > 0) {
    process.stdout.write(
      yellow(
        "! --purge deletes ~/.cognigy-plugin, which every client shares.\n" +
          "  Clients you are keeping will lose their credentials.\n\n",
      ),
    );
  }
  if (!assumeYes) {
    // Never delete without an explicit yes. Non-interactive (piped/CI) has no
    // way to answer the prompt, so require --yes there rather than proceeding.
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "Refusing to uninstall non-interactively. Re-run with --yes (add --purge to also delete ~/.cognigy-plugin).\n",
      );
      process.exit(1);
    }
    const ans = await ask(
      `Remove the Cognigy plugin/connector from ${targets.map((c) => CLIENT_LABELS[c]).join(", ")}${purge ? " and delete ~/.cognigy-plugin" : ""}? [y/N]: `,
    );
    if (!/^y(es)?$/i.test(ans)) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  if (wants("claude-code")) runUninstallClaudeCode();
  if (wants("claude-desktop")) runUninstallClaudeDesktop();
  if (wants("codex")) runUninstallCodex();
  if (wants("antigravity")) runUninstallAntigravity();
  if (wants("other-hosts")) runUninstallOtherHosts(purge);

  if (purge) {
    process.stdout.write(
      purgeUserHome()
        ? green("✓ Removed ~/.cognigy-plugin") + " (credentials + engine).\n"
        : dim("• ~/.cognigy-plugin") + ": nothing to remove.\n",
    );
  }

  process.stdout.write(
    dim("\nRestart your client(s) to finish removing the plugin.\n\n"),
  );
}

function runUninstallClaudeCode(): void {
  const code = uninstallClaudeCode();
  if (code.method === "cli") {
    const parts = [
      code.removedPlugin ? "plugin" : null,
      code.removedMarketplace ? "marketplace" : null,
    ].filter(Boolean);
    process.stdout.write(
      parts.length
        ? green("✓ Claude Code") + `: removed ${parts.join(" + ")}.\n`
        : dim("• Claude Code") +
            ": nothing to remove (plugin/marketplace not installed via the CLI).\n",
    );
  } else {
    process.stdout.write(
      yellow("• Claude Code") +
        ": 'claude' CLI not found. Remove by hand in a session:\n" +
        (code.commands ?? []).map((c) => cyan(`    ${c}`)).join("\n") +
        "\n",
    );
  }
}

function runUninstallClaudeDesktop(): void {
  // Purge is handled globally by the caller — never per-client.
  const desk = uninstallClaudeDesktop(resolveDesktopConfigPath(), false);
  process.stdout.write(
    (desk.removedEntry ? green("✓ Claude Desktop") : dim("• Claude Desktop")) +
      `: ${desk.removedEntry ? "connector removed from" : "no connector found in"} ${desk.configPath}\n` +
      // The plugin half lives in the claude.ai account + IndexedDB, not a local
      // file, so nothing here can remove it — same reason we can't install it.
      dim("  installed the plugin too? remove it in Customize → Plugins.\n"),
  );
}

function runUninstallCodex(): void {
  const codex = uninstallCodex();
  if (codex.method === "cli") {
    process.stdout.write(
      (codex.removedPlugin
        ? green("✓ ChatGPT + Codex")
        : dim("• ChatGPT + Codex")) +
        `: ${codex.removedPlugin ? "plugin removed" : "no plugin installed"}` +
        (codex.removedMarketplace ? ", marketplace deregistered" : "") +
        ".\n",
    );
  } else {
    process.stdout.write(
      dim("• ChatGPT + Codex") +
        ": 'codex' CLI not found — remove the plugin in the app\n" +
        dim("  (Plugins in the sidebar → ⋯ on Cognigy → Uninstall).\n"),
    );
  }
}

function runUninstallAntigravity(): void {
  const ag = uninstallAntigravity();
  process.stdout.write(
    (ag.removedPlugin ? green("✓ Antigravity") : dim("• Antigravity")) +
      `: ${ag.removedPlugin ? "plugin removed" : "no plugin found"}` +
      (ag.removedLegacyServer
        ? dim(
            "\n  also cleared an older 'cognigy' entry from the global mcp_config.json",
          )
        : "") +
      "\n",
  );
}

/**
 * The `other-hosts` install wires nothing — it only writes the shared creds
 * file — so there is nothing client-specific to undo. Say so rather than
 * silently doing nothing, and point at `--purge`, which owns that file (it is
 * shared by every client, so removing it can't belong to one target).
 */
function runUninstallOtherHosts(purge: boolean): void {
  process.stdout.write(
    dim("• Other hosts") +
      ": nothing was wired — the install only wrote credentials.\n" +
      (purge
        ? dim("  ~/.cognigy-plugin is removed below.\n")
        : dim(
            "  Re-run with --purge to delete ~/.cognigy-plugin, and uninstall the\n" +
              "  plugin in the host itself (VS Code: Extensions → cognigy).\n",
          )),
  );
}

/**
 * Split argv into a subcommand + the remaining args. The first token is the
 * subcommand only when it's a non-flag positional; a leading flag (e.g.
 * `--client`) keeps the historical `cognigy-setup --client …` form by defaulting
 * to `install`. An unknown non-flag word is returned verbatim so main() can
 * reject it (rather than silently treating a typo as `install`).
 */
export function parseSubcommand(raw: string[]): {
  sub: string;
  rest: string[];
} {
  const first = raw[0];
  if (first && !first.startsWith("-"))
    return { sub: first, rest: raw.slice(1) };
  return { sub: "install", rest: raw };
}

/** Removes a single leading "setup" token (the `npx … setup` spelling). */
export function stripSetupToken(argv: string[]): string[] {
  return argv[0] === "setup" ? argv.slice(1) : argv.slice();
}

async function main(): Promise<void> {
  const raw = stripSetupToken(process.argv.slice(2));
  const { sub, rest } = parseSubcommand(raw);
  const projectRejection = rejectProjectFlag(sub, rest);
  if (projectRejection) {
    process.stderr.write(projectRejection);
    process.exit(1);
  }
  switch (sub) {
    case "install":
      break;
    case "status":
      return runStatus();
    case "update":
      return runUpdate();
    case "uninstall":
      return runUninstall(rest);
    case "profile":
      process.exitCode = await runProfileCommand(rest, {
        out: (text) => void process.stdout.write(text),
        err: (text) => void process.stderr.write(text),
        isTTY: Boolean(process.stdin.isTTY),
        ask,
        askHidden,
        env: process.env,
        loadProfiles: () => loadProfilesFromSystem(),
        store: { upsertProfile, removeProfile, setDefaultProfile },
        createGetter: (p) =>
          new CognigyApiClient({
            baseUrl: p.apiBaseUrl,
            apiKey: p.apiKey,
            auditAttribution: false,
            maxRetries: 0,
            timeoutMs: 10000,
            quiet: true,
          }),
      });
      return;
    default:
      process.stderr.write(
        `Unknown command '${sub}'. Use: install | status | update | uninstall | profile.\n`,
      );
      process.exit(1);
  }

  const argv = rest;
  const flags = parseFlags(argv);
  rejectInvalidClients(flags.invalidClients);
  const plan = planInstall(flags);
  if ("error" in plan) {
    process.stderr.write(`${plan.error}\n`);
    process.exit(1);
  }
  const { scope } = plan;
  if (scope === "project") {
    const problem = projectDirProblem(process.cwd(), homedir(), existsSync);
    if (problem?.refuse) {
      process.stderr.write(`${problem.refuse}\n`);
      process.exit(1);
    }
    if (problem?.warn) process.stdout.write(yellow(`${problem.warn}\n`));
  }
  const interactive = process.stdin.isTTY && flags.apiKey === undefined;

  let apiBaseUrl = flags.apiBaseUrl;
  let apiKey = flags.apiKey;
  let clients = plan.clients;

  if (interactive) {
    process.stdout.write(bold(cyan("\n🚀 NiCE Cognigy Plugin Setup\n\n")));
    if (scope === "user") clients = await chooseClients();
    process.stdout.write("\n");
    const urlAnswer = await ask(`Cognigy API base URL [${DEFAULT_BASE_URL}]: `);
    apiBaseUrl = urlAnswer || DEFAULT_BASE_URL;
    apiKey = await askHidden("Cognigy API key: ");
  } else {
    apiBaseUrl = apiBaseUrl || DEFAULT_BASE_URL;
    if (clients.length === 0) {
      process.stderr.write(
        `No client selected. Pass one or more of: ${ALL_CLIENTS.map(
          (c) => `--client ${c}`,
        ).join(
          ", ",
        )} (or --project to install Claude Code for this project).\n`,
      );
      process.exit(1);
    }
  }

  if (!apiKey) {
    process.stderr.write(
      "No API key provided. Pass --api-key <key> or run interactively.\n",
    );
    process.exit(1);
  }

  const creds: UserConfigFile = {
    COGNIGY_API_BASE_URL: apiBaseUrl as string,
    COGNIGY_API_KEY: apiKey,
  };

  // Isolate per-client failures: one client's install blowing up must not skip
  // the clients queued behind it (they are independent installs, and the user
  // asked for all of them). Failures are collected and reported at the end.
  const failed: { client: Client; message: string }[] = [];
  for (const client of clients) {
    try {
      runInstall(client, creds, scope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ client, message });
      process.stdout.write(
        "\n" + yellow(`✗ ${CLIENT_LABELS[client]}: ${message}`) + "\n",
      );
    }
  }

  if (failed.length > 0) {
    const ok = clients.length - failed.length;
    process.stderr.write(
      yellow(
        bold(
          `\n${ok} of ${clients.length} client(s) set up; ${failed.length} failed: ` +
            failed.map((f) => f.client).join(", ") +
            ".\n",
        ),
      ),
    );
    process.exit(1);
  }

  process.stdout.write(green(bold("\n✓ Done.\n")));
}

function runCli(): void {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "cancelled") {
      process.stderr.write("Cancelled.\n");
      process.exit(130);
    }
    process.stderr.write(`Setup failed: ${msg}\n`);
    process.exit(1);
  });
}

/**
 * True when this module is the process entrypoint. npm installs the
 * `cognigy-setup` bin as a symlink, and Node resolves ESM entry points through
 * realpath — so `import.meta.url` is the real file while `argv[1]` is the
 * symlink. Compare against the realpath of `argv[1]` or the guard never fires
 * under `npx …` and the whole installer silently no-ops.
 */
export function isMainModule(
  moduleUrl: string,
  argv1: string | undefined,
): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

// Run only when invoked as the bin, not when imported (e.g. by tests).
if (isMainModule(import.meta.url, process.argv[1])) {
  runCli();
}
