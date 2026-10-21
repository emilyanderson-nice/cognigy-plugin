/**
 * Session state file for status lines. One MCP server runs per Claude Code
 * session, so the server writes ~/.cognigy-plugin/sessions/<claudePid>.json
 * describing which environment the session uses; a status line script finds
 * it by walking up its own process ancestry to the same `claude` pid.
 *
 * Best-effort throughout: every failure is logged at debug level and
 * swallowed, so it can never affect a tool call. The file never holds keys.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostOf } from "../profiles/profiles.js";
import type { EnvironmentRegistry } from "./registry.js";
import type { SessionPin } from "./sessionPin.js";

export const SESSION_STATE_ENV_VAR = "COGNIGY_SESSION_STATE";
export const SESSION_KEY_ENV_VAR = "COGNIGY_SESSION_KEY";
export const STATUSLINE_SCRIPT = "statusline-segment.sh";

const MAX_HOPS = 6;
const SAFE_KEY = /^[A-Za-z0-9._-]{1,128}$/;

export type PsLookup = (
  pid: number,
) => { ppid: number; comm: string } | undefined;

type LogFn = (message: string, meta?: Record<string, unknown>) => void;

export interface SessionStateOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pid?: number;
  ppid?: number;
  platform?: NodeJS.Platform;
  lookup?: PsLookup;
  now?: () => Date;
  /** Debug logger; every swallowed failure goes here. */
  log?: LogFn;
  /** Where to find the bundled status line script, first match wins. */
  scriptSources?: string[];
}

export interface SessionState {
  /** The state file path, or undefined when disabled or no session found. */
  readonly file: string | undefined;
  /** Rewrites the file from the current pin and registry. */
  write(): void;
  /** Records a successfully dispatched call; rewrites only on a change. */
  dispatched(environment: { name: string; host: string }): void;
  /** Deletes the file. Safe to repeat. */
  remove(): void;
}

/** `ps -o ppid=,comm= -p <pid>` (macOS/Linux). */
export const psLookup: PsLookup = (pid) => {
  const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim();
  const m = /^(\d+)\s+(.+)$/.exec(out);
  return m ? { ppid: Number(m[1]), comm: m[2].trim() } : undefined;
};

/**
 * Walks up from `startPid` (inclusive) to the first process whose command
 * basename is exactly `claude`. Undefined when none within the hop limit.
 */
export function findClaudePid(
  startPid: number,
  lookup: PsLookup,
  maxHops = MAX_HOPS,
): number | undefined {
  let pid = startPid;
  try {
    for (let hop = 0; hop < maxHops && pid > 1; hop++) {
      const row = lookup(pid);
      if (!row) return undefined;
      if (basename(row.comm) === "claude") return pid;
      pid = row.ppid;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const noop = () => {};

/** A state file that does nothing (opted out, or no session found). */
export const DISABLED_SESSION_STATE: SessionState = {
  file: undefined,
  write: noop,
  dispatched: noop,
  remove: noop,
};

export function sessionStateDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env[SESSION_STATE_ENV_VAR]?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

export function createSessionState(
  registry: EnvironmentRegistry,
  pin: SessionPin,
  options: SessionStateOptions = {},
): SessionState {
  const env = options.env ?? process.env;
  const log = options.log ?? noop;
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  if (sessionStateDisabled(env)) {
    log("Session state file disabled", { env: SESSION_STATE_ENV_VAR });
    return DISABLED_SESSION_STATE;
  }

  let key: string | undefined;
  let claudePid: number | null = null;
  const override = env[SESSION_KEY_ENV_VAR]?.trim();
  if (override) {
    if (!SAFE_KEY.test(override)) {
      log("Session state file skipped: unsafe session key", {
        env: SESSION_KEY_ENV_VAR,
      });
      return DISABLED_SESSION_STATE;
    }
    key = override;
  } else {
    const platform = options.platform ?? process.platform;
    const found =
      platform === "win32"
        ? undefined
        : findClaudePid(
            options.ppid ?? process.ppid,
            options.lookup ?? psLookup,
          );
    if (found === undefined) {
      log("Session state file skipped: no claude ancestor process found");
      return DISABLED_SESSION_STATE;
    }
    claudePid = found;
    key = String(found);
  }

  const dir = join(options.homeDir ?? homedir(), ".cognigy-plugin", "sessions");
  const file = join(dir, `${key}.json`);
  let lastUsed: { name: string; host: string } | undefined;

  const contents = (): Record<string, unknown> => {
    const snap = registry.snapshot();
    const current = pin.get();
    const pinnedProfile = current
      ? snap.profiles.find((p) => p.name === current.name)
      : undefined;
    const host = current
      ? pinnedProfile
        ? hostOf(pinnedProfile.apiBaseUrl)
        : null
      : (lastUsed?.host ?? null);
    return {
      pinned: current?.name ?? null,
      pinSource: current?.source ?? null,
      host,
      lastUsed: lastUsed?.name ?? null,
      configured: snap.configuredNames.length,
      environments: snap.configuredNames,
      pid,
      claudePid,
      updatedAt: now().toISOString(),
    };
  };

  const write = () => {
    try {
      const body = JSON.stringify(contents(), null, 2) + "\n";
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${pid}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      try {
        renameSync(tmp, file);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
    } catch (err) {
      log("Session state file not written", { error: messageOf(err) });
    }
  };

  return {
    file,
    write,
    dispatched(environment) {
      if (
        lastUsed?.name === environment.name &&
        lastUsed.host === environment.host
      ) {
        return;
      }
      lastUsed = { name: environment.name, host: environment.host };
      write();
    },
    remove() {
      try {
        // After a plugin reload the new server has already rewritten this
        // file for the same session; only remove it while it's still ours.
        if (!existsSync(file)) return;
        const owner = (
          JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }
        ).pid;
        if (owner !== undefined && owner !== pid) return;
        rmSync(file, { force: true });
      } catch (err) {
        log("Session state file not removed", { error: messageOf(err) });
      }
    },
  };
}

/** Where the bundled script lives relative to this module (dist or src). */
export function defaultScriptSources(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    // dist/environments -> dist/plugin-assets/scripts (published package)
    join(here, "..", "plugin-assets", "scripts", STATUSLINE_SCRIPT),
    // src|dist/environments -> plugin/scripts (git checkout)
    join(here, "..", "..", "plugin", "scripts", STATUSLINE_SCRIPT),
  ];
}

/**
 * Copies the status line script to ~/.cognigy-plugin/statusline-segment.sh
 * (0700), a path that does not change between plugin versions.
 */
export function installStatuslineScript(
  homeDir: string = homedir(),
  sources: string[] = defaultScriptSources(),
  log: LogFn = noop,
): void {
  try {
    const source = sources.find((s) => existsSync(s));
    if (!source) {
      log("Status line script not installed: bundled script not found");
      return;
    }
    const dir = join(homeDir, ".cognigy-plugin");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, STATUSLINE_SCRIPT);
    const tmp = `${target}.${process.pid}.tmp`;
    copyFileSync(source, tmp);
    chmodSync(tmp, 0o700);
    renameSync(tmp, target);
  } catch (err) {
    log("Status line script not installed", { error: messageOf(err) });
  }
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
