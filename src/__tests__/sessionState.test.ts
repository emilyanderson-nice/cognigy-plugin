/**
 * Session state file: ~/.cognigy-plugin/sessions/<claudePid>.json tells the
 * Claude Code status line which environment this session uses. Written at
 * boot, on pin changes and when the last-used environment changes; removed
 * on shutdown. Best-effort throughout: it never affects a tool call.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SESSION_KEY_ENV_VAR,
  SESSION_STATE_ENV_VAR,
  createSessionState,
  findClaudePid,
  installStatuslineScript,
  type PsLookup,
  type SessionStateOptions,
} from "../environments/sessionState.js";
import { createSessionPin } from "../environments/sessionPin.js";
import { createEnvironmentRegistry } from "../environments/registry.js";
import { rig } from "./helpers/bootstrapRig.js";
import {
  ALL_KEYS,
  KEY_A,
  KEY_B,
  parse,
  setOf,
  usable,
} from "./helpers/dispatchHarness.js";
import type { ProfileSet } from "../profiles/profiles.js";

const posix = process.platform !== "win32";
const homes: string[] = [];
const tempHome = () => {
  const h = mkdtempSync(join(tmpdir(), "cognigy-session-state-"));
  homes.push(h);
  return h;
};

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const TWO = () => setOf(usable("A", KEY_A), usable("B", KEY_B));

/** Fake process table: pid -> [ppid, comm]. */
const table =
  (rows: Record<number, [number, string]>): PsLookup =>
  (pid) => {
    const row = rows[pid];
    return row ? { ppid: row[0], comm: row[1] } : undefined;
  };

// Server 300 <- npm exec 200 <- claude 100 <- zsh 50 <- launchd 1
const TREE = table({
  300: [200, "node"],
  200: [100, "npm exec cognigy-mcp"],
  100: [50, "claude"],
  50: [1, "-zsh"],
  1: [0, "/sbin/launchd"],
});

const opts = (
  home: string,
  extra: Partial<SessionStateOptions> = {},
): SessionStateOptions => ({
  env: {},
  homeDir: home,
  pid: 300,
  ppid: 200,
  platform: "darwin",
  lookup: TREE,
  now: () => new Date("2026-10-16T12:00:00.000Z"),
  ...extra,
});

const stateFile = (home: string, key = "100") =>
  join(home, ".cognigy-plugin", "sessions", `${key}.json`);
const readState = (home: string, key?: string) =>
  JSON.parse(readFileSync(stateFile(home, key), "utf8")) as Record<
    string,
    unknown
  >;

describe("findClaudePid", () => {
  it("walks up from ppid to the first ancestor named claude", () => {
    expect(findClaudePid(200, TREE)).toBe(100);
  });

  it("matches the command basename (full path, versioned dir)", () => {
    const t = table({
      200: [100, "npm exec cognigy-mcp"],
      100: [1, "/Users/x/.local/share/claude/versions/claude"],
    });
    expect(findClaudePid(200, t)).toBe(100);
  });

  it("does not match names that merely contain claude", () => {
    const t = table({
      200: [100, "claude-desktop"],
      100: [1, "/Applications/Claude.app/Contents/MacOS/Claude"],
    });
    expect(findClaudePid(200, t)).toBeUndefined();
  });

  it("gives up after the hop limit, at init, or on lookup failure", () => {
    const chain: Record<number, [number, string]> = {};
    for (let p = 20; p > 1; p--) chain[p] = [p - 1, "sh"];
    chain[1] = [0, "launchd"];
    expect(findClaudePid(20, table({ ...chain, 2: [1, "claude"] }))).toBe(
      undefined,
    );
    expect(findClaudePid(200, table({}))).toBeUndefined();
    expect(
      findClaudePid(200, () => {
        throw new Error("ps missing");
      }),
    ).toBeUndefined();
  });
});

describe("createSessionState: file contents", () => {
  it("boot write: unpinned, two configured, no host, no keys, private modes", () => {
    const home = tempHome();
    const registry = rig(TWO()).parts.registry;
    const s = createSessionState(registry, createSessionPin(), opts(home));
    expect(s.file).toBe(stateFile(home));
    s.write();
    expect(readState(home)).toEqual({
      pinned: null,
      pinSource: null,
      host: null,
      lastUsed: null,
      configured: 2,
      environments: ["a", "b"],
      pid: 300,
      claudePid: 100,
      updatedAt: "2026-10-16T12:00:00.000Z",
    });
    const raw = readFileSync(stateFile(home), "utf8");
    for (const k of ALL_KEYS) expect(raw).not.toContain(k);
    if (posix) {
      expect(statSync(stateFile(home)).mode & 0o777).toBe(0o600);
      expect(
        statSync(join(home, ".cognigy-plugin", "sessions")).mode & 0o777,
      ).toBe(0o700);
    }
    // Atomic: no temp files left behind.
    expect(readdirSync(join(home, ".cognigy-plugin", "sessions"))).toEqual([
      "100.json",
    ]);
  });

  it("pinned: name, source and the pinned environment's api host", () => {
    const home = tempHome();
    const registry = rig(TWO()).parts.registry;
    const pin = createSessionPin();
    pin.set({ name: "b", source: "COGNIGY_ENVIRONMENT" });
    const s = createSessionState(registry, pin, opts(home));
    s.write();
    expect(readState(home)).toMatchObject({
      pinned: "b",
      pinSource: "COGNIGY_ENVIRONMENT",
      host: "api-b.cognigy.ai",
    });
  });

  it("dispatched: records lastUsed and its host, rewrites only on change", () => {
    const home = tempHome();
    const registry = rig(TWO()).parts.registry;
    let t = 0;
    const s = createSessionState(
      registry,
      createSessionPin(),
      opts(home, { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)) }),
    );
    s.write();
    s.dispatched({ name: "a", host: "api-a.cognigy.ai" });
    const first = readState(home);
    expect(first).toMatchObject({ lastUsed: "a", host: "api-a.cognigy.ai" });
    s.dispatched({ name: "a", host: "api-a.cognigy.ai" });
    expect(readState(home).updatedAt).toBe(first.updatedAt);
    s.dispatched({ name: "b", host: "api-b.cognigy.ai" });
    expect(readState(home)).toMatchObject({
      lastUsed: "b",
      host: "api-b.cognigy.ai",
    });
  });

  it("remove deletes the file and is safe to repeat", () => {
    const home = tempHome();
    const s = createSessionState(
      rig(TWO()).parts.registry,
      createSessionPin(),
      opts(home),
    );
    s.write();
    s.remove();
    expect(existsSync(stateFile(home))).toBe(false);
    expect(() => s.remove()).not.toThrow();
  });

  it(`${SESSION_KEY_ENV_VAR} overrides the file name and skips the ps walk`, () => {
    const home = tempHome();
    const lookup = jest.fn<PsLookup>(() => undefined);
    const s = createSessionState(
      rig(TWO()).parts.registry,
      createSessionPin(),
      opts(home, { env: { [SESSION_KEY_ENV_VAR]: "my-key_1" }, lookup }),
    );
    s.write();
    expect(lookup).not.toHaveBeenCalled();
    expect(readState(home, "my-key_1")).toMatchObject({ claudePid: null });
  });

  it("an unsafe session key is refused (no path traversal)", () => {
    const home = tempHome();
    const s = createSessionState(
      rig(TWO()).parts.registry,
      createSessionPin(),
      opts(home, { env: { [SESSION_KEY_ENV_VAR]: "../evil" } }),
    );
    expect(s.file).toBeUndefined();
    s.write();
    expect(existsSync(join(home, ".cognigy-plugin"))).toBe(false);
  });

  it(`${SESSION_STATE_ENV_VAR}=0 disables it entirely`, () => {
    const home = tempHome();
    const lookup = jest.fn<PsLookup>(TREE);
    const s = createSessionState(
      rig(TWO()).parts.registry,
      createSessionPin(),
      opts(home, { env: { [SESSION_STATE_ENV_VAR]: "0" }, lookup }),
    );
    s.write();
    s.dispatched({ name: "a", host: "h" });
    expect(s.file).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(existsSync(join(home, ".cognigy-plugin"))).toBe(false);
  });

  it("no claude ancestor, or Windows: no file, logged at debug", () => {
    const home = tempHome();
    const log = jest.fn();
    const none = createSessionState(
      rig(TWO()).parts.registry,
      createSessionPin(),
      opts(home, { lookup: table({}), log }),
    );
    none.write();
    expect(none.file).toBeUndefined();
    expect(log).toHaveBeenCalled();
    const win = createSessionState(
      rig(TWO()).parts.registry,
      createSessionPin(),
      opts(home, { platform: "win32" }),
    );
    expect(win.file).toBeUndefined();
    expect(existsSync(join(home, ".cognigy-plugin"))).toBe(false);
  });

  it("write failures and a throwing registry are logged, never thrown", () => {
    const home = tempHome();
    // A regular file where the directory should be: mkdir fails.
    writeFileSync(join(home, ".cognigy-plugin"), "not a dir");
    const log = jest.fn();
    const s = createSessionState(
      rig(TWO()).parts.registry,
      createSessionPin(),
      opts(home, { log }),
    );
    expect(() => s.write()).not.toThrow();
    expect(() => s.dispatched({ name: "a", host: "h" })).not.toThrow();
    expect(() => s.remove()).not.toThrow();
    expect(log).toHaveBeenCalled();

    const badRegistry = createEnvironmentRegistry({
      loadProfiles: (): ProfileSet => {
        throw new Error("boom");
      },
      createRuntime: () => {
        throw new Error("unused");
      },
    });
    const throwing = {
      ...badRegistry,
      snapshot: () => {
        throw new Error("snapshot exploded");
      },
    };
    const s2 = createSessionState(
      throwing,
      createSessionPin(),
      opts(tempHome(), { log }),
    );
    expect(() => s2.write()).not.toThrow();
  });
});

describe("bootstrap wiring", () => {
  const boot = (home: string, env: NodeJS.ProcessEnv = {}) =>
    rig(TWO(), env, undefined, opts(home, { env }));

  it("writes at boot after the launch pin is applied", () => {
    const home = tempHome();
    boot(home, { COGNIGY_ENVIRONMENT: "a" });
    expect(readState(home)).toMatchObject({
      pinned: "a",
      pinSource: "COGNIGY_ENVIRONMENT",
      host: "api-a.cognigy.ai",
      configured: 2,
    });
  });

  it("use_environment set and clear rewrite the file", async () => {
    const home = tempHome();
    const r = boot(home);
    await r.call("use_environment", { name: "b" });
    expect(readState(home)).toMatchObject({
      pinned: "b",
      pinSource: "use_environment",
      host: "api-b.cognigy.ai",
    });
    await r.call("use_environment", { clear: true });
    expect(readState(home)).toMatchObject({
      pinned: null,
      pinSource: null,
      host: null,
    });
  });

  it("a successful dispatched call records lastUsed; a failed one does not", async () => {
    const home = tempHome();
    const r = rig(
      TWO(),
      {},
      {
        b: async () => {
          throw new Error("api down");
        },
      },
      opts(home),
    );
    await r.call("list_resources", { environment: "b" });
    expect(readState(home).lastUsed).toBeNull();
    const ok = await r.call("list_resources", { environment: "a" });
    expect(ok.isError).toBeUndefined();
    expect(readState(home)).toMatchObject({
      lastUsed: "a",
      host: "api-a.cognigy.ai",
    });
  });

  it("parts.sessionState.remove() deletes the file (shutdown path)", () => {
    const home = tempHome();
    const r = boot(home);
    expect(existsSync(stateFile(home))).toBe(true);
    r.parts.sessionState.remove();
    expect(existsSync(stateFile(home))).toBe(false);
  });

  it("boot copies the status line script to the stable path (0700)", () => {
    const home = tempHome();
    boot(home);
    const stable = join(home, ".cognigy-plugin", "statusline-segment.sh");
    expect(readFileSync(stable, "utf8")).toMatch(/^#!\/usr\/bin\/env bash/);
    if (posix) expect(statSync(stable).mode & 0o777).toBe(0o700);
  });

  it("a broken state directory never affects tool calls", async () => {
    const home = tempHome();
    writeFileSync(join(home, ".cognigy-plugin"), "not a dir");
    const r = boot(home);
    const pinned = await r.call("use_environment", { name: "a" });
    expect(parse(pinned).pinned).toMatchObject({ name: "a" });
    const call = await r.call("list_resources", {});
    expect(call.isError).toBeUndefined();
  });
});

describe("installStatuslineScript", () => {
  it("copies the first existing source; missing sources are a logged no-op", () => {
    const home = tempHome();
    const src = join(home, "src.sh");
    writeFileSync(src, "#!/usr/bin/env bash\necho hi\n");
    const log = jest.fn();
    installStatuslineScript(home, [join(home, "missing.sh"), src], log);
    expect(
      readFileSync(
        join(home, ".cognigy-plugin", "statusline-segment.sh"),
        "utf8",
      ),
    ).toContain("echo hi");
    const other = tempHome();
    expect(() =>
      installStatuslineScript(other, [join(other, "nope.sh")], log),
    ).not.toThrow();
    expect(existsSync(join(other, ".cognigy-plugin"))).toBe(false);
    expect(log).toHaveBeenCalled();
  });
});
