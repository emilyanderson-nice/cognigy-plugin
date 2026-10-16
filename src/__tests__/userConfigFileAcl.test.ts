import { describe, it, afterEach } from "@jest/globals";
import { userInfo } from "os";
import { restrictToOwner } from "../userConfigFile.js";
import {
  cleanupTmp,
  freshDir,
  type Call,
  type Runner,
  type RunResult,
} from "./helpers/configFixtures.js";
import { eq, ok, show } from "./helpers/specAssert.js";
import { join } from "path";

const saved = {
  USERNAME: process.env.USERNAME,
  USERDOMAIN: process.env.USERDOMAIN,
};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanupTmp();
});

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const WHOAMI_OK = `"FAKEDOM\\alice","${SID}"\r\n`;

function runnerWith(whoami: () => RunResult): {
  all: Call[];
  run: Runner;
  icacls: () => Call[];
  whoamiCalls: () => Call[];
} {
  const all: Call[] = [];
  const run: Runner = (command, args) => {
    all.push({ command, args: [...args] });
    return command === "whoami" ? whoami() : { status: 0 };
  };
  return {
    all,
    run,
    icacls: () => all.filter((c) => c.command === "icacls"),
    whoamiCalls: () => all.filter((c) => c.command === "whoami"),
  };
}

describe("H7: win32 ACL identity is the SID from the process token", () => {
  it.each<["file" | "dir", string]>([
    ["file", `*${SID}:(F)`],
    ["dir", `*${SID}:(OI)(CI)F`],
  ])(
    "%s: whoami succeeds so icacls grants the *SID and ignores hostile env names",
    (kind, grant) => {
      process.env.USERDOMAIN = "Evil Dom (x)";
      process.env.USERNAME = "Bob (work)";
      const target = join(freshDir(), "config.json");
      const r = runnerWith(() => ({ status: 0, stdout: WHOAMI_OK }));
      const result = restrictToOwner(target, kind, {
        platform: "win32",
        run: r.run,
      });
      eq(
        r.all,
        [
          { command: "whoami", args: ["/user", "/fo", "csv", "/nh"] },
          {
            command: "icacls",
            args: [target, "/inheritance:r", "/grant:r", grant],
          },
        ],
        `restrictToOwner(${kind}, SID)`,
        "H7: whoami first (exact args), then icacls with the *SID grant",
        "Resolve the user SID via whoami once, then grant `*<SID>` with F (file) or (OI)(CI)F (dir).",
      );
      eq(
        result,
        { ok: true, method: "icacls" },
        `restrictToOwner(${kind}, SID) result`,
        "H7: success result unchanged",
        "Report ok with method icacls.",
      );
      ok(
        !JSON.stringify(r.all).includes("Bob") &&
          !JSON.stringify(r.all).includes("Evil"),
        `restrictToOwner(${kind}, SID) env`,
        "H7: USERNAME/USERDOMAIN are never used when the SID is known",
        "no environment names in any command",
        show(r.all),
        "Do not build the grant from environment variables when the SID resolves.",
      );
    },
  );

  it("calls whoami exactly once per restrictToOwner call", () => {
    const r = runnerWith(() => ({ status: 0, stdout: WHOAMI_OK }));
    restrictToOwner(join(freshDir(), "x"), "file", {
      platform: "win32",
      run: r.run,
    });
    eq(
      r.whoamiCalls().length,
      1,
      "restrictToOwner(whoami count)",
      "H7: identity resolved once",
      "Do not run whoami more than once for a single call.",
    );
  });

  it.each<[string, () => RunResult]>([
    ["whoami exits non-zero", () => ({ status: 1, stdout: WHOAMI_OK })],
    ["whoami status is null", () => ({ status: null })],
    ["stdout is empty", () => ({ status: 0, stdout: "" })],
    ["stdout is missing", () => ({ status: 0 })],
    ["stdout is garbage", () => ({ status: 0, stdout: "ERROR: nope" })],
    [
      "SID field is malformed",
      () => ({ status: 0, stdout: '"FAKEDOM\\alice","not-a-sid"' }),
    ],
    [
      "whoami throws",
      () => {
        throw new Error("spawn whoami ENOENT");
      },
    ],
  ])("falls back to USERDOMAIN\\USERNAME when %s", (_label, whoami) => {
    process.env.USERDOMAIN = "FAKEDOM";
    process.env.USERNAME = "fakeuser";
    const r = runnerWith(whoami);
    const target = join(freshDir(), "config.json");
    const result = restrictToOwner(target, "file", {
      platform: "win32",
      run: r.run,
    });
    eq(
      [r.icacls().map((c) => c.args), result.ok],
      [[[target, "/inheritance:r", "/grant:r", "FAKEDOM\\fakeuser:(F)"]], true],
      `restrictToOwner(${_label})`,
      "H7: unusable whoami falls back to the environment name",
      "Fall back to USERDOMAIN\\USERNAME and still apply the grant.",
    );
  });

  it("falls back to os.userInfo().username when whoami fails and env is empty", () => {
    delete process.env.USERDOMAIN;
    delete process.env.USERNAME;
    const r = runnerWith(() => ({ status: 1 }));
    restrictToOwner(join(freshDir(), "config.json"), "file", {
      platform: "win32",
      run: r.run,
    });
    eq(
      r.icacls()[0]?.args[3],
      `${userInfo().username}:(F)`,
      "restrictToOwner(no whoami, no env)",
      "H7: last-resort fallback is os.userInfo().username",
      "Use the OS-reported username when nothing else is available.",
    );
  });

  it.each<["file" | "dir", string]>([
    ["file", "CORP\\explicit:(F)"],
    ["dir", "CORP\\explicit:(OI)(CI)F"],
  ])(
    "%s: an explicit options.user wins over whoami and is passed as given",
    (kind, grant) => {
      const r = runnerWith(() => ({ status: 0, stdout: WHOAMI_OK }));
      const target = join(freshDir(), "config.json");
      restrictToOwner(target, kind, {
        platform: "win32",
        run: r.run,
        user: "CORP\\explicit",
      });
      eq(
        r.icacls().map((c) => c.args),
        [[target, "/inheritance:r", "/grant:r", grant]],
        `restrictToOwner(${kind}, explicit user)`,
        "H7: options.user overrides SID resolution",
        "Pass an explicit user to icacls exactly as given.",
      );
    },
  );

  it("never runs whoami off Windows", () => {
    const r = runnerWith(() => ({ status: 0, stdout: WHOAMI_OK }));
    restrictToOwner(join(freshDir(), "nope"), "file", {
      platform: "linux",
      run: r.run,
    });
    eq(
      r.all,
      [],
      "restrictToOwner(linux)",
      "H7: the SID lookup is Windows-only",
      "Do not invoke any command on non-win32 platforms.",
    );
  });
});
