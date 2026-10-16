/**
 * plugin/scripts/statusline-segment.sh: prints the session's Cognigy
 * environment for a Claude Code status line. Runs against a temp HOME; the
 * script's $PPID is this Jest worker, so a state file keyed by process.pid
 * is found on the first hop.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugin",
  "scripts",
  "statusline-segment.sh",
);
const posix = process.platform !== "win32";
const d = posix ? describe : describe.skip;

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const sessions = (home: string) => join(home, ".cognigy-plugin", "sessions");

function home(state?: Record<string, unknown>, key = String(process.pid)) {
  const h = mkdtempSync(join(tmpdir(), "cognigy-statusline-"));
  homes.push(h);
  if (state) {
    mkdirSync(sessions(h), { recursive: true });
    writeFileSync(
      join(sessions(h), `${key}.json`),
      JSON.stringify(
        {
          pinned: null,
          pinSource: null,
          host: null,
          lastUsed: null,
          configured: 2,
          environments: ["a", "b"],
          pid: process.pid,
          claudePid: process.pid,
          updatedAt: "2026-10-16T12:00:00.000Z",
          ...state,
        },
        null,
        2,
      ),
    );
  }
  return h;
}

/** A PATH holding only what the script may use without jq. */
function minimalPath(): string {
  const bin = mkdtempSync(join(tmpdir(), "cognigy-statusline-bin-"));
  homes.push(bin);
  for (const tool of ["ps", "sed", "tr", "rm"]) {
    const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
      encoding: "utf8",
    }).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  return bin;
}

const BASH = posix
  ? spawnSync("bash", ["-c", "command -v bash"], {
      encoding: "utf8",
    }).stdout.trim()
  : "bash";

const hasJq = posix && spawnSync("bash", ["-c", "command -v jq"]).status === 0;

function run(h: string, env: Record<string, string> = {}, noJq = false) {
  const r = spawnSync(BASH, [SCRIPT], {
    env: {
      HOME: h,
      PATH: noJq ? minimalPath() : (process.env.PATH ?? ""),
      COGNIGY_SL_COLOR: "0",
      ...env,
    },
    encoding: "utf8",
  });
  expect([r.status, r.stderr]).toEqual([0, ""]);
  return r.stdout;
}

d("statusline-segment.sh", () => {
  const modes: Array<[string, boolean]> = [
    ...(hasJq ? [["with jq", false] as [string, boolean]] : []),
    ["without jq (sed fallback)", true],
  ];
  for (const [label, noJq] of modes) {
    describe(label, () => {
      it("pinned -> cognigy:<name>", () => {
        expect(
          run(home({ pinned: "prod", pinSource: "use_environment" }), {}, noJq),
        ).toBe("cognigy:prod");
      });

      it("a plugin-settings pin prints its name", () => {
        expect(
          run(home({ pinned: "edj", pinSource: "plugin-settings" }), {}, noJq),
        ).toBe("cognigy:edj");
      });

      it("unpinned with two or more configured -> cognigy:unpinned", () => {
        expect(run(home({}), {}, noJq)).toBe("cognigy:unpinned");
      });

      it("unpinned with a last-used environment appends it", () => {
        expect(run(home({ lastUsed: "dev" }), {}, noJq)).toBe(
          "cognigy:unpinned (last dev)",
        );
      });

      it("one configured -> its last-used name, else the single name", () => {
        expect(
          run(
            home({ configured: 1, environments: ["solo"], lastUsed: "solo" }),
            {},
            noJq,
          ),
        ).toBe("cognigy:solo");
        expect(
          run(home({ configured: 1, environments: ["solo"] }), {}, noJq),
        ).toBe("cognigy:solo");
      });

      it("zero configured and unpinned prints nothing", () => {
        expect(run(home({ configured: 0, environments: [] }), {}, noJq)).toBe(
          "",
        );
      });
    });
  }

  it("no state file prints nothing", () => {
    expect(run(home())).toBe("");
  });

  it("a file for a non-ancestor pid is ignored", () => {
    expect(run(home({ pinned: "x" }, "999999999"))).toBe("");
  });

  it("a stale file (server pid dead) prints nothing and is deleted", () => {
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    const h = home({ pinned: "old", pid: dead });
    expect(run(h)).toBe("");
    expect(existsSync(join(sessions(h), `${process.pid}.json`))).toBe(false);
  });

  it("colours by default: dim prefix, truecolor name", () => {
    const out = run(home({ pinned: "prod" }), { COGNIGY_SL_COLOR: "1" });
    expect(out).toBe(
      "\u001b[2mcognigy:\u001b[0m\u001b[38;2;125;207;255mprod\u001b[0m",
    );
  });
});

d("statusline-segment.sh colour with a note", () => {
  it("dims the (last ...) note", () => {
    const out = run(home({ lastUsed: "dev" }), { COGNIGY_SL_COLOR: "1" });
    expect(out).toBe(
      "\u001b[2mcognigy:\u001b[0m\u001b[38;2;125;207;255munpinned\u001b[0m\u001b[2m (last dev)\u001b[0m",
    );
  });
});
