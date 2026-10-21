import { describe, it, expect, afterAll, jest } from "@jest/globals";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

jest.setTimeout(120000);

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
): void {
  try {
    expect(actual).toEqual(expected);
  } catch {
    throw new Error(
      [
        `1. WHAT FAILED: ${testName}`,
        `2. REQUIREMENT VIOLATED: ${requirement}`,
        `3. EXPECTED: ${JSON.stringify(expected)}`,
        `4. ACTUAL: ${JSON.stringify(actual)}`,
        `5. GUIDANCE: ${guidance}`,
      ].join("\n"),
    );
  }
}

const REAL_ROOT = process.cwd();
const FORK = "emilyanderson-nice/cognigy-plugin";

/** The four files that carry the engine pin, relative to a repo root. */
const PIN_FILES = [
  "plugin/.claude-plugin/plugin.json",
  "plugin/mcp.json",
  "plugin/.codex-plugin/mcp.json",
  "plugin/.cursor-plugin/plugin.json",
];
const MARKETPLACE = ".claude-plugin/marketplace.json";

const pin = (version: string) => `github:${FORK}#v${version}`;
const FLAG = "--allow-git=root";
/** The full launch args: the git-allow flag FIRST, then the npx invocation. */
const pinArgs = (version: string) => [
  FLAG,
  "-y",
  "-p",
  pin(version),
  "cognigy-mcp",
];
/** Index of the engine spec inside pinArgs(). */
const SPEC_INDEX = 3;
/** Valid flag-bearing args for `version` with only the spec token replaced. */
const argsWithSpec = (version: string, spec: string) => {
  const a = pinArgs(version);
  a[SPEC_INDEX] = spec;
  return a;
};

function readJson(root: string, rel: string): any {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}
function writeJson(root: string, rel: string, value: unknown): void {
  writeFileSync(join(root, rel), JSON.stringify(value, null, 2) + "\n");
}

const V: string = readJson(REAL_ROOT, "package.json").version;

const LOCK = "package-lock.json";

/**
 * A synthetic lockfile (2-space JSON, trailing newline, optional CRLF). The root
 * `version` and `packages[""].version` carry `version`. A decoy dependency
 * carries `decoy` both as its own version and inside its `resolved` text, so a
 * stamper that replaces the old version string anywhere is caught.
 */
function lockText(version: string, decoy: string, nl = "\n"): string {
  const lock = {
    name: "@cognigy/plugin-engine",
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "@cognigy/plugin-engine",
        version,
        dependencies: { decoy: "^1.0.0" },
      },
      "node_modules/decoy": {
        version: decoy,
        resolved: `https://registry.invalid/decoy/-/decoy-${decoy}.tgz`,
      },
    },
  };
  return (JSON.stringify(lock, null, 2) + "\n").replace(/\n/g, nl);
}

// ---------------------------------------------------------------- Part 1

describe("fork manifests: real repo files", () => {
  for (const rel of PIN_FILES) {
    it(`${rel} pins the fork's github tag for package.json version`, () => {
      const args = readJson(REAL_ROOT, rel).mcpServers.platform.args;
      check(
        `${rel} mcpServers.platform.args`,
        "The platform server must launch the engine from the fork's tagged release matching package.json",
        pinArgs(V),
        args,
        "Make the platform server args exactly: --allow-git=root first (so npm 12 permits the github: spec), then -y, -p, the fork github spec pinned to the release tag for the current package version, then the cognigy-mcp bin name.",
      );
    });
  }

  it("marketplace is named cognigy-plugin-v2", () => {
    check(
      "marketplace name",
      "The fork marketplace name must be distinct from upstream and the earlier fork",
      "cognigy-plugin-v2",
      readJson(REAL_ROOT, MARKETPLACE).name,
      "Set the marketplace name to the v2 fork's name.",
    );
  });

  it("marketplace owner url is this fork's repository", () => {
    check(
      "marketplace owner.url",
      "The marketplace owner must link to this fork's repository",
      `https://github.com/${FORK}`,
      readJson(REAL_ROOT, MARKETPLACE).owner.url,
      "Point the owner url at this fork's GitHub repository.",
    );
  });

  it("marketplace file mentions no previous fork identity", () => {
    const text = readFileSync(join(REAL_ROOT, MARKETPLACE), "utf8");
    check(
      "marketplace text contains pb-crackers",
      "No trace of the previous fork owner may remain",
      false,
      text.includes("pb-crackers"),
      "Remove every reference to the previous fork owner from the marketplace file.",
    );
    check(
      "marketplace text contains cognigy-plugin-pb",
      "No trace of the previous fork marketplace name may remain",
      false,
      text.includes("cognigy-plugin-pb"),
      "Remove every reference to the previous fork marketplace name from the marketplace file.",
    );
  });
});

// ---------------------------------------------------------------- Part 2

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Throwaway copy of everything the scripts touch. Never the real repo. */
function makeRawCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "fork-manifests-"));
  tempRoots.push(root);
  cpSync(join(REAL_ROOT, "package.json"), join(root, "package.json"));
  cpSync(join(REAL_ROOT, "plugin"), join(root, "plugin"), { recursive: true });
  mkdirSync(join(root, ".claude-plugin"));
  cpSync(join(REAL_ROOT, MARKETPLACE), join(root, MARKETPLACE));
  cpSync(join(REAL_ROOT, "scripts"), join(root, "scripts"), {
    recursive: true,
  });
  for (const rel of [
    "package.json",
    MARKETPLACE,
    "scripts/check-plugin-manifest.mjs",
    ...PIN_FILES,
  ]) {
    if (!existsSync(join(root, rel))) {
      throw new Error(`fixture error: ${rel} missing from temp copy`);
    }
  }
  if (!root.startsWith(tmpdir())) {
    throw new Error("fixture error: temp root outside tmpdir");
  }
  return root;
}

function manifestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "skills") walk(rel);
      } else if (e.name === "plugin.json") {
        out.push(rel);
      }
    }
  };
  walk("plugin");
  return out;
}

/**
 * A copy whose identity is made valid by the fixture itself (independent of the
 * real manifests), so a failing script run can only be caused by the single
 * mutation a test applies afterwards.
 */
function makeValidCopy(
  version: string = V,
  opts: { lock?: boolean; lockNewline?: string } = {},
): string {
  const root = makeRawCopy();
  if (opts.lock !== false) {
    writeFileSync(
      join(root, LOCK),
      lockText(version, version, opts.lockNewline ?? "\n"),
    );
  }
  const pkg = readJson(root, "package.json");
  pkg.version = version;
  writeJson(root, "package.json", pkg);
  for (const rel of PIN_FILES) {
    const j = readJson(root, rel);
    j.mcpServers.platform.args = pinArgs(version);
    writeJson(root, rel, j);
  }
  for (const rel of manifestFiles(root)) {
    const j = readJson(root, rel);
    if ("version" in j) {
      j.version = version;
      writeJson(root, rel, j);
    }
  }
  const mpPath = join(root, MARKETPLACE);
  const mp = JSON.parse(
    readFileSync(mpPath, "utf8")
      .replace(/pb-crackers/g, "emilyanderson-nice")
      .replace(/cognigy-plugin-pb/g, "cognigy-plugin-v2"),
  );
  mp.name = "cognigy-plugin-v2";
  mp.owner.url = `https://github.com/${FORK}`;
  writeJson(root, MARKETPLACE, mp);
  return root;
}

function run(root: string, script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join("scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.replace(/\\/g, "/");
  return { status: r.status, output };
}

const CHECK = "check-plugin-manifest.mjs";

function expectCheckPasses(root: string, label: string): void {
  const r = run(root, CHECK);
  check(
    `${label}: check-plugin-manifest exit status`,
    "A copy with a fully valid fork identity must pass the manifest check",
    0,
    r.status,
    `The manifest check must accept the fork identity (v2 marketplace name, fork-pinned engine in every manifest). Output was: ${r.output.slice(0, 300)}`,
  );
}

describe("check-plugin-manifest.mjs", () => {
  it("fixture sanity: temp copy contains the files and is not the real repo", () => {
    const root = makeValidCopy();
    check(
      "temp root differs from real root",
      "Scripts must only ever run in throwaway copies",
      true,
      root !== REAL_ROOT && existsSync(join(root, "scripts")),
      "Fixture must create a distinct temp root containing scripts/.",
    );
  });

  it("(a) exits 0 on an unmodified copy of the repo", () => {
    const root = makeRawCopy();
    check(
      "unmodified copy carries the fork identity",
      "The committed manifests must already be the fork's (marketplace v2, fork-pinned engine)",
      {
        name: "cognigy-plugin-v2",
        pin: pinArgs(V),
      },
      {
        name: readJson(root, MARKETPLACE).name,
        pin: readJson(root, PIN_FILES[0]).mcpServers.platform.args,
      },
      "Update the committed marketplace name and the claude plugin engine pin to the fork identity.",
    );
    const r = run(root, CHECK);
    check(
      "unmodified copy: exit status",
      "The repository as committed must satisfy its own manifest check",
      0,
      r.status,
      `Bring the manifests and the check into agreement on the fork identity. Output was: ${r.output.slice(0, 300)}`,
    );
  });

  it("(a2) exits 0 on a fixture-normalised valid copy", () => {
    expectCheckPasses(makeValidCopy(), "normalised copy");
  });

  const cases: Array<{
    name: string;
    offender: string;
    mutate: (root: string) => void;
  }> = [
    {
      name: "(b1) rejects an unpinned fork spec in the claude plugin.json",
      offender: "plugin/.claude-plugin/plugin.json",
      mutate: (root) => {
        const rel = "plugin/.claude-plugin/plugin.json";
        const j = readJson(root, rel);
        j.mcpServers.platform.args = argsWithSpec(V, `github:${FORK}`);
        writeJson(root, rel, j);
      },
    },
    {
      name: "(b2) rejects a pin whose version is #v0.0.1",
      offender: "plugin/.claude-plugin/plugin.json",
      mutate: (root) => {
        const rel = "plugin/.claude-plugin/plugin.json";
        const j = readJson(root, rel);
        j.mcpServers.platform.args = pinArgs("0.0.1");
        writeJson(root, rel, j);
      },
    },
    {
      name: "(b3) rejects a pin to the previous fork owner",
      offender: "plugin/.claude-plugin/plugin.json",
      mutate: (root) => {
        const rel = "plugin/.claude-plugin/plugin.json";
        const j = readJson(root, rel);
        j.mcpServers.platform.args = argsWithSpec(
          V,
          `github:pb-crackers/cognigy-plugin#v${V}`,
        );
        writeJson(root, rel, j);
      },
    },
    {
      name: "(b4) rejects the npm alias spec in plugin/mcp.json",
      offender: "plugin/mcp.json",
      mutate: (root) => {
        const rel = "plugin/mcp.json";
        const j = readJson(root, rel);
        j.mcpServers.platform.args = argsWithSpec(
          V,
          "cognigy-engine@npm:@cognigy/plugin-engine@1.22.0",
        );
        writeJson(root, rel, j);
      },
    },
    ...PIN_FILES.flatMap((rel) => [
      {
        name: `(b7) rejects ${rel} when --allow-git=root is missing`,
        offender: rel,
        mutate: (root: string) => {
          const j = readJson(root, rel);
          j.mcpServers.platform.args = pinArgs(V).slice(1);
          writeJson(root, rel, j);
        },
      },
      {
        name: `(b8) rejects ${rel} when --allow-git=root comes after -y instead of first`,
        offender: rel,
        mutate: (root: string) => {
          const j = readJson(root, rel);
          j.mcpServers.platform.args = [
            "-y",
            FLAG,
            "-p",
            pin(V),
            "cognigy-mcp",
          ];
          writeJson(root, rel, j);
        },
      },
      {
        name: `(b9) rejects ${rel} when the flag is last instead of first`,
        offender: rel,
        mutate: (root: string) => {
          const j = readJson(root, rel);
          j.mcpServers.platform.args = [
            "-y",
            "-p",
            pin(V),
            "cognigy-mcp",
            FLAG,
          ];
          writeJson(root, rel, j);
        },
      },
      {
        name: `(b10) rejects ${rel} when the flag value is --allow-git=all`,
        offender: rel,
        mutate: (root: string) => {
          const j = readJson(root, rel);
          const args = pinArgs(V);
          args[0] = "--allow-git=all";
          j.mcpServers.platform.args = args;
          writeJson(root, rel, j);
        },
      },
    ]),
    {
      name: "(b5) rejects marketplace name cognigy-plugin-pb",
      offender: MARKETPLACE,
      mutate: (root) => {
        const j = readJson(root, MARKETPLACE);
        j.name = "cognigy-plugin-pb";
        writeJson(root, MARKETPLACE, j);
      },
    },
    {
      name: "(b6) rejects marketplace name cognigy-plugin",
      offender: MARKETPLACE,
      mutate: (root) => {
        const j = readJson(root, MARKETPLACE);
        j.name = "cognigy-plugin";
        writeJson(root, MARKETPLACE, j);
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const root = makeValidCopy();
      expectCheckPasses(root, "baseline before mutation");
      c.mutate(root);
      const r = run(root, CHECK);
      check(
        `${c.name}: exit is non-zero`,
        "The check must reject a manifest that deviates from the fork identity",
        true,
        r.status !== 0 && r.status !== null,
        "Fail the check (non-zero exit) whenever this manifest deviates from the exact expected fork identity.",
      );
      check(
        `${c.name}: output names ${c.offender}`,
        "The failure message must identify the offending manifest",
        true,
        r.output.includes(c.offender),
        `Print the path ${c.offender} in the error output for the manifest that failed. Output was: ${r.output.slice(0, 300)}`,
      );
    });
  }
});

describe("fork-version.mjs", () => {
  it("(c1) with a base version sets <base>-esc.1 everywhere and leaves the check passing", () => {
    const root = makeValidCopy();
    const r = run(root, "fork-version.mjs", "1.23.0");
    check(
      "fork-version 1.23.0 exit status",
      "fork-version must accept a plain upstream base version",
      0,
      r.status,
      `Accept an upstream base version argument and apply it. Output was: ${r.output.slice(0, 300)}`,
    );
    check(
      "package.json version",
      "The fork release version is the base version with an esc.1 suffix",
      "1.23.0-esc.1",
      readJson(root, "package.json").version,
      "Write <base>-esc.1 into package.json when given a new base version.",
    );
    for (const rel of PIN_FILES) {
      check(
        `${rel} args`,
        "Every pin file must follow the new release version",
        pinArgs("1.23.0-esc.1"),
        readJson(root, rel).mcpServers.platform.args,
        "Rewrite the engine pin in every pin file to the new fork tag.",
      );
    }
    expectCheckPasses(root, "after fork-version 1.23.0");
  });

  it("(c2) with no argument on a legacy pb version restarts the counter as 1.22.0-esc.1", () => {
    const root = makeValidCopy("1.22.0-pb.1");
    const r = run(root, "fork-version.mjs");
    check(
      "fork-version (no args) exit status",
      "fork-version with no argument must bump the fork counter",
      0,
      r.status,
      `Support running with no argument. Output was: ${r.output.slice(0, 300)}`,
    );
    check(
      "package.json version",
      "A pb version is read, but the bump is written with the esc suffix and a restarted counter, base unchanged",
      "1.22.0-esc.1",
      readJson(root, "package.json").version,
      "Switch the suffix to esc, restart the counter at 1 and keep the base version.",
    );
    for (const rel of PIN_FILES) {
      check(
        `${rel} args`,
        "Every pin file must follow the bumped version",
        pinArgs("1.22.0-esc.1"),
        readJson(root, rel).mcpServers.platform.args,
        "Rewrite the engine pin in every pin file to the bumped fork tag.",
      );
    }
  });
});

/** True when `path` appears in output as a whole path, not as the tail of a longer one. */
function namesPath(output: string, path: string): boolean {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.-])${esc}`).test(output);
}

describe("check-plugin-manifest.mjs: pin and version gaps", () => {
  it.each([
    "plugin/.codex-plugin/mcp.json",
    "plugin/.cursor-plugin/plugin.json",
  ])(
    "rejects a stale #v0.0.1 pin in %s and names only that pin file",
    (offender) => {
      const root = makeValidCopy();
      expectCheckPasses(root, "baseline before mutation");
      const j = readJson(root, offender);
      j.mcpServers.platform.args = pinArgs("0.0.1");
      writeJson(root, offender, j);
      const r = run(root, CHECK);
      check(
        `stale pin in ${offender}: exit is non-zero`,
        "A stale pin in any pin file must fail the check",
        true,
        r.status !== 0 && r.status !== null,
        "Fail the check (non-zero exit) whenever any pin file holds a pin that is not the current version's tag.",
      );
      check(
        `stale pin in ${offender}: output names it`,
        "The failure message must identify the offending pin file",
        true,
        namesPath(r.output, offender),
        `Print the path ${offender}. Output was: ${r.output.slice(0, 300)}`,
      );
      for (const other of PIN_FILES.filter((f) => f !== offender)) {
        check(
          `stale pin in ${offender}: output must not name ${other}`,
          "Only the failing file is reported; healthy pin files must not be listed",
          false,
          namesPath(r.output, other),
          `Report only files that fail, not every pin file. Output was: ${r.output.slice(0, 300)}`,
        );
      }
    },
  );

  it.each(["plugin/.codex-plugin/plugin.json", "plugin/plugin.json"])(
    "rejects a manifest version of 0.0.1 in %s and names it",
    (offender) => {
      const root = makeValidCopy();
      expectCheckPasses(root, "baseline before mutation");
      const j = readJson(root, offender);
      j.version = "0.0.1";
      writeJson(root, offender, j);
      const r = run(root, CHECK);
      check(
        `version mismatch in ${offender}: exit is non-zero`,
        "A manifest version that differs from package.json must fail the check",
        true,
        r.status !== 0 && r.status !== null,
        "Compare every manifest version field with package.json and exit non-zero on a mismatch.",
      );
      check(
        `version mismatch in ${offender}: output names it`,
        "The failure message must identify the manifest with the wrong version",
        true,
        namesPath(r.output, offender),
        `Print the path ${offender}. Output was: ${r.output.slice(0, 300)}`,
      );
    },
  );
});

describe("fork-version.mjs: counter and base arguments", () => {
  function expectAllAt(root: string, version: string): void {
    check(
      "package.json version",
      "package.json carries the new fork version",
      version,
      readJson(root, "package.json").version,
      "Write the new fork version into package.json.",
    );
    for (const rel of PIN_FILES) {
      check(
        `${rel} args`,
        "Every pin file follows the new fork version",
        pinArgs(version),
        readJson(root, rel).mcpServers.platform.args,
        "Rewrite the engine pin in every pin file to the new fork tag.",
      );
    }
  }

  it.each([
    ["1.22.0-esc.4", "1.22.0-esc.5"],
    ["1.22.0-esc.9", "1.22.0-esc.10"],
    ["1.22.0-pb.4", "1.22.0-esc.1"],
    ["1.22.0-pb.9", "1.22.0-esc.1"],
  ])("no argument bumps %s to %s numerically", (from, to) => {
    const root = makeValidCopy(from);
    const r = run(root, "fork-version.mjs");
    check(
      `fork-version (no args) from ${from}: exit status`,
      "No-argument fork-version bumps the counter",
      0,
      r.status,
      `Output was: ${r.output.slice(0, 300)}`,
    );
    expectAllAt(root, to);
    expectCheckPasses(root, `after bump to ${to}`);
  });

  it.each(PIN_FILES)(
    "fork-version keeps --allow-git=root first and rewrites only the spec token in %s",
    (rel) => {
      const root = makeValidCopy("1.22.0-pb.1");
      const r = run(root, "fork-version.mjs");
      check(
        "fork-version exit status",
        "Bumping the version must succeed on manifests that carry the git-allow flag",
        0,
        r.status,
        `Accept flag-bearing args and bump. Output was: ${r.output.slice(0, 300)}`,
      );
      check(
        `${rel} args after fork-version`,
        "Version stamping rewrites the spec only; the flag stays first and nothing else moves",
        [FLAG, "-y", "-p", pin("1.22.0-esc.1"), "cognigy-mcp"],
        readJson(root, rel).mcpServers.platform.args,
        "Do not drop, move or duplicate --allow-git=root when the pin is rewritten; only the github spec token changes.",
      );
    },
  );

  it("a base and a counter argument set <base>-esc.<counter> exactly", () => {
    const root = makeValidCopy();
    const r = run(root, "fork-version.mjs", "1.20.0", "3");
    check(
      "fork-version 1.20.0 3 exit status",
      "A base plus counter argument is accepted",
      0,
      r.status,
      `Output was: ${r.output.slice(0, 300)}`,
    );
    expectAllAt(root, "1.20.0-esc.3");
    expectCheckPasses(root, "after fork-version 1.20.0 3");
  });

  it("the same base as a legacy pb version switches to esc and restarts the counter", () => {
    const root = makeValidCopy("1.22.0-pb.3");
    const r = run(root, "fork-version.mjs", "1.22.0");
    check(
      "fork-version 1.22.0 on 1.22.0-pb.3 exit status",
      "Re-running with the current base is accepted",
      0,
      r.status,
      `Output was: ${r.output.slice(0, 300)}`,
    );
    expectAllAt(root, "1.22.0-esc.1");
  });
});

describe("fork-version.mjs: esc suffix rules (pb is read, never written)", () => {
  // Killing mutation per row: keeping the pb suffix on a bump; not restarting the
  // counter on a suffix switch; restarting the counter when the base is unchanged
  // on an esc version; ignoring an explicit counter; stamping any file with a
  // stale version (expectAllAt-style checks cover package.json, manifests, lock, pins).
  it.each([
    ["1.22.0-pb.3", [], "1.22.0-esc.1"],
    ["1.22.0-esc.1", [], "1.22.0-esc.2"],
    ["1.22.0-pb.3", ["1.22.2"], "1.22.2-esc.1"],
    ["1.22.0-pb.3", ["1.22.0"], "1.22.0-esc.1"],
    ["1.22.0-esc.2", ["1.22.0"], "1.22.0-esc.3"],
    ["1.22.0-esc.2", ["1.22.5"], "1.22.5-esc.1"],
    ["1.22.0-pb.3", ["1.22.2", "5"], "1.22.2-esc.5"],
    ["1.22.0-esc.2", ["1.22.2", "5"], "1.22.2-esc.5"],
  ] as Array<[string, string[], string]>)(
    "from %s with args %j the result is %s everywhere and the check passes",
    (from, args, to) => {
      const root = makeValidCopy(from);
      const r = run(root, "fork-version.mjs", ...args);
      check(
        `fork-version ${args.join(" ")} on ${from}: exit status`,
        "The bump must succeed",
        0,
        r.status,
        `Output was: ${r.output.slice(0, 300)}`,
      );
      const pkgVersion = readJson(root, "package.json").version;
      check(
        `package.json version after ${from} + ${JSON.stringify(args)}`,
        "The exact new version, always with the esc suffix",
        to,
        pkgVersion,
        "Write <base>-esc.<n> per the bump rules.",
      );
      check(
        "no generated version contains -pb.",
        "Nothing may ever generate a pb version again",
        false,
        pkgVersion.includes("-pb."),
        "Never write the legacy suffix.",
      );
      for (const rel of PIN_FILES) {
        check(
          `${rel} args`,
          "Every pin file follows the new version",
          JSON.stringify(pinArgs(to)),
          JSON.stringify(readJson(root, rel).mcpServers.platform.args),
          "Rewrite the engine pin in every pin file.",
        );
      }
      for (const rel of manifestFiles(root)) {
        const j = readJson(root, rel);
        if ("version" in j) {
          check(
            `${rel} version`,
            "Every manifest version follows the new version",
            to,
            j.version,
            "Stamp every manifest that carries a version.",
          );
        }
      }
      const lock = JSON.parse(readFileSync(join(root, LOCK), "utf8"));
      check(
        "lockfile root version",
        "Lockfile follows",
        to,
        lock.version,
        "Stamp the lockfile.",
      );
      check(
        'lockfile packages[""].version',
        "Lockfile root entry follows",
        to,
        lock.packages[""].version,
        "Stamp the lockfile.",
      );
      expectCheckPasses(
        root,
        `after fork-version ${args.join(" ")} on ${from}`,
      );
    },
  );
});

describe("check-plugin-manifest.mjs: esc and legacy pb versions", () => {
  // Killing mutation: the check accepts only pb (esc fails), or only esc (pb fails).
  it.each(["1.22.2-esc.1", "1.22.0-esc.7", "1.22.0-pb.3"])(
    "accepts a fully consistent copy at %s",
    (version) => {
      expectCheckPasses(makeValidCopy(version), `consistent ${version}`);
    },
  );

  // Killing mutation: the check compares versions only for one suffix, or skips
  // the file for esc; the offender must be named and healthy files must not be.
  describe.each(["1.22.2-esc.1", "1.22.0-pb.3"])("at %s", (version) => {
    it.each(["plugin/.codex-plugin/plugin.json", "plugin/plugin.json"])(
      "rejects a manifest version mismatch in %s and names it",
      (offender) => {
        const root = makeValidCopy(version);
        expectCheckPasses(root, "baseline before mutation");
        const j = readJson(root, offender);
        j.version = "0.0.1";
        writeJson(root, offender, j);
        const r = run(root, CHECK);
        check(
          `${version}: mismatch in ${offender}: exit is non-zero`,
          "A manifest version that differs from package.json fails for either suffix",
          true,
          r.status !== 0 && r.status !== null,
          `Output was: ${r.output.slice(0, 300)}`,
        );
        check(
          `${version}: output names ${offender}`,
          "The failure identifies the manifest",
          true,
          namesPath(r.output, offender),
          `Output was: ${r.output.slice(0, 300)}`,
        );
      },
    );

    it.each(PIN_FILES)("rejects a stale pin in %s and names it", (offender) => {
      const root = makeValidCopy(version);
      expectCheckPasses(root, "baseline before mutation");
      const j = readJson(root, offender);
      j.mcpServers.platform.args = pinArgs("0.0.1");
      writeJson(root, offender, j);
      const r = run(root, CHECK);
      check(
        `${version}: stale pin in ${offender}: exit is non-zero`,
        "A pin that is not the package version's tag fails for either suffix",
        true,
        r.status !== 0 && r.status !== null,
        `Output was: ${r.output.slice(0, 300)}`,
      );
      check(
        `${version}: output names ${offender}`,
        "The failure identifies the pin file",
        true,
        namesPath(r.output, offender),
        `Output was: ${r.output.slice(0, 300)}`,
      );
    });
  });

  // Killing mutation: error text still says only <x.y.z>-pb.<n>; or the version
  // is accepted. Each fixture mutates only package.json's version; manifests,
  // pins and lock are rewritten by the fixture to carry the same non-fork value.
  it.each(["1.22.0", "1.22.0-beta.1"])(
    "rejects the non-fork package version %s and the message names both forms",
    (version) => {
      const root = makeValidCopy(version);
      const r = run(root, CHECK);
      check(
        `${version}: exit is non-zero`,
        "A version that is neither -esc.<n> nor legacy -pb.<n> is not a fork version",
        true,
        r.status !== 0 && r.status !== null,
        `Output was: ${r.output.slice(0, 300)}`,
      );
      check(
        `${version}: message mentions the esc form and the legacy pb form`,
        "The error must tell the maintainer the expected form <x.y.z>-esc.<n> and that pb is legacy",
        { esc: true, pb: true },
        {
          esc: r.output.includes("<x.y.z>-esc.<n>"),
          pb: r.output.includes("pb") && /legacy/i.test(r.output),
        },
        `Print the expected form <x.y.z>-esc.<n> and mention the legacy -pb.<n> form. Output was: ${r.output.slice(0, 400)}`,
      );
    },
  );
});

describe("sync-plugin-version.mjs", () => {
  const NEW = "1.23.0-pb.2";

  it("(d1) writes the pin and every manifest version field for the given version", () => {
    const root = makeValidCopy();
    const files = manifestFiles(root);
    const withVersion = files.filter((f) => "version" in readJson(root, f));
    check(
      "fixture: manifests with a version field",
      "The fixture must contain at least the four plugin manifests with versions",
      true,
      withVersion.length >= 4,
      "Fixture should find plugin.json files with a version field.",
    );
    const r = run(root, "sync-plugin-version.mjs", NEW);
    check(
      "sync-plugin-version exit status",
      "Syncing a fork prerelease version must succeed",
      0,
      r.status,
      `Accept a prerelease version and apply it. Output was: ${r.output.slice(0, 300)}`,
    );
    for (const rel of PIN_FILES) {
      check(
        `${rel} args`,
        "Every pin file must carry the synced version",
        pinArgs(NEW),
        readJson(root, rel).mcpServers.platform.args,
        "Rewrite the engine pin in every pin file to the fork github spec at the synced version tag.",
      );
    }
    for (const rel of withVersion) {
      check(
        `${rel} version`,
        "Every manifest version field must equal the synced version",
        NEW,
        readJson(root, rel).version,
        "Update the version field in every manifest that has one.",
      );
    }
  });

  it.each(PIN_FILES)(
    "(d3) keeps --allow-git=root first and rewrites only the spec token in %s",
    (rel) => {
      const root = makeValidCopy();
      const r = run(root, "sync-plugin-version.mjs", NEW);
      check(
        "sync-plugin-version exit status",
        "Syncing a version must succeed on manifests that carry the git-allow flag",
        0,
        r.status,
        `Accept flag-bearing args and apply the version. Output was: ${r.output.slice(0, 300)}`,
      );
      const args = readJson(root, rel).mcpServers.platform.args;
      check(
        `${rel} args after sync`,
        "Version stamping rewrites the spec only; the flag stays first and nothing else moves",
        [FLAG, "-y", "-p", pin(NEW), "cognigy-mcp"],
        args,
        "Do not drop, move or duplicate --allow-git=root when the pin is rewritten; only the github spec token changes.",
      );
    },
  );

  it("(d2) exits 1 when a pin file still holds an npm engine spec", () => {
    const root = makeValidCopy();
    const rel = "plugin/mcp.json";
    const j = readJson(root, rel);
    j.mcpServers.platform.args = argsWithSpec(
      V,
      "cognigy-engine@npm:@cognigy/plugin-engine@1.22.0",
    );
    writeJson(root, rel, j);
    const r = run(root, "sync-plugin-version.mjs", NEW);
    check(
      "sync-plugin-version exit status with npm engine spec present",
      "A pin file that still references the npm engine package must abort the sync",
      1,
      r.status,
      `Exit with status 1 when any pin file contains the npm engine package spec instead of silently rewriting it. Output was: ${r.output.slice(0, 300)}`,
    );
    check(
      "sync-plugin-version output names the offending pin file",
      "The abort message must identify which pin file holds the npm engine spec",
      true,
      r.output.includes(rel),
      `Print the path ${rel} in the error output. Output was: ${r.output.slice(0, 300)}`,
    );
  });
});

describe("package-lock.json: real repo", () => {
  const lock = readJson(REAL_ROOT, LOCK);

  it("root version equals package.json version", () => {
    check(
      "package-lock.json root version",
      "The tracked lockfile must carry the same version as package.json",
      V,
      lock.version,
      "Run npm run version:fork (or sync the lockfile) so the lockfile's top-level version equals package.json's version.",
    );
  });

  it('packages[""].version equals package.json version', () => {
    check(
      'package-lock.json packages[""].version',
      "The tracked lockfile's root package entry must carry the same version as package.json",
      V,
      lock.packages[""].version,
      'Set packages[""].version in package-lock.json to package.json\'s version.',
    );
  });
});

describe("fork-version.mjs: package-lock.json", () => {
  const OLD = "1.22.0-pb.1";

  /** Lock bytes after stamping: only the two fields move; the decoy keeps OLD. */
  function expectLock(root: string, version: string, nl = "\n"): void {
    check(
      `package-lock.json after stamping ${version}`,
      "Only the root version and packages[''].version change; every other byte (decoy dependency, formatting, line endings) is preserved",
      lockText(version, OLD, nl),
      readFileSync(join(root, LOCK), "utf8"),
      "Rewrite exactly the two version fields of the lockfile to the new version. Do not replace the old version text elsewhere and do not reformat or change line endings.",
    );
  }

  it("no argument: bumps both lockfile versions and leaves everything else byte-identical", () => {
    const root = makeValidCopy(OLD);
    const r = run(root, "fork-version.mjs");
    check(
      "fork-version (no args) exit status",
      "Stamping with a lockfile present must succeed",
      0,
      r.status,
      `Output was: ${r.output.slice(0, 300)}`,
    );
    expectLock(root, "1.22.0-esc.1");
    expectCheckPasses(root, "after no-arg bump with lockfile");
  });

  it("<base>: sets both lockfile versions to <base>-esc.1", () => {
    const root = makeValidCopy(OLD);
    const r = run(root, "fork-version.mjs", "1.23.0");
    check(
      "fork-version 1.23.0 exit status",
      "Stamping with a lockfile present must succeed",
      0,
      r.status,
      `Output was: ${r.output.slice(0, 300)}`,
    );
    expectLock(root, "1.23.0-esc.1");
    expectCheckPasses(root, "after base stamp with lockfile");
  });

  it("<base> <n>: sets both lockfile versions to <base>-esc.<n>", () => {
    const root = makeValidCopy(OLD);
    const r = run(root, "fork-version.mjs", "1.20.0", "3");
    check(
      "fork-version 1.20.0 3 exit status",
      "Stamping with a lockfile present must succeed",
      0,
      r.status,
      `Output was: ${r.output.slice(0, 300)}`,
    );
    expectLock(root, "1.20.0-esc.3");
    expectCheckPasses(root, "after base+counter stamp with lockfile");
  });

  it("preserves CRLF line endings in the lockfile", () => {
    const root = makeValidCopy(OLD, { lockNewline: "\r\n" });
    const r = run(root, "fork-version.mjs");
    check(
      "fork-version exit status with CRLF lockfile",
      "Stamping must succeed on a CRLF lockfile",
      0,
      r.status,
      `Output was: ${r.output.slice(0, 300)}`,
    );
    expectLock(root, "1.22.0-esc.1", "\r\n");
  });

  it("does not crash and creates no lockfile when package-lock.json is absent", () => {
    const root = makeValidCopy(OLD, { lock: false });
    const r = run(root, "fork-version.mjs");
    check(
      "fork-version exit status without lockfile",
      "A target with no lockfile must still be stamped",
      0,
      r.status,
      `Treat a missing package-lock.json as nothing to do. Output was: ${r.output.slice(0, 300)}`,
    );
    check(
      "package.json version without lockfile",
      "Everything else is still stamped",
      "1.22.0-esc.1",
      readJson(root, "package.json").version,
      "Continue stamping package.json and the manifests when there is no lockfile.",
    );
    check(
      "lockfile not created",
      "Stamping never invents a lockfile",
      false,
      existsSync(join(root, LOCK)),
      "Only rewrite a lockfile that already exists.",
    );
  });
});

describe("check-plugin-manifest.mjs: package-lock.json", () => {
  const BAD = "0.0.1";

  function mutateLock(root: string, mutate: (lock: any) => void): void {
    const lock = JSON.parse(readFileSync(join(root, LOCK), "utf8"));
    mutate(lock);
    writeFileSync(join(root, LOCK), JSON.stringify(lock, null, 2) + "\n");
  }

  it("passes when both lockfile versions equal package.json", () => {
    expectCheckPasses(makeValidCopy(), "lockfile in sync");
  });

  it("passes when there is no lockfile at all", () => {
    expectCheckPasses(makeValidCopy(V, { lock: false }), "no lockfile");
  });

  it.each([
    ["root version", (l: any) => (l.version = BAD)],
    ['packages[""].version', (l: any) => (l.packages[""].version = BAD)],
  ])("rejects a stale lockfile %s and names package-lock.json", (field, fn) => {
    const root = makeValidCopy();
    expectCheckPasses(root, "baseline before mutation");
    mutateLock(root, fn);
    const r = run(root, CHECK);
    check(
      `stale lockfile ${field}: exit is non-zero`,
      "A lockfile version that differs from package.json must fail the check",
      true,
      r.status !== 0 && r.status !== null,
      `Compare both lockfile version fields with package.json and exit non-zero on a mismatch. Output was: ${r.output.slice(0, 300)}`,
    );
    check(
      `stale lockfile ${field}: output names package-lock.json`,
      "The failure message must identify the lockfile",
      true,
      namesPath(r.output, LOCK),
      `Print the path ${LOCK}. Output was: ${r.output.slice(0, 300)}`,
    );
    for (const other of PIN_FILES) {
      check(
        `stale lockfile ${field}: output must not name ${other}`,
        "Only the lockfile defect is reported",
        false,
        namesPath(r.output, other),
        `Report only failing files. Output was: ${r.output.slice(0, 300)}`,
      );
    }
  });

  // Killing mutation: letting JSON.parse throw uncaught (status 1 but stack trace,
  // no "not valid JSON" text); or reporting a pin file instead of the lockfile.
  it.each([
    ["merge-conflict markers", "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> main\n"],
    ["a truncated file", '{"version":'],
  ])(
    "reports a lockfile that is %s as not valid JSON, without a stack trace",
    (label, text) => {
      const root = makeValidCopy();
      expectCheckPasses(root, "baseline before mutation");
      writeFileSync(join(root, LOCK), text);
      const r = run(root, CHECK);
      check(
        `invalid lockfile (${label}): exit is non-zero`,
        "An unparseable lockfile must fail the check",
        true,
        r.status !== 0 && r.status !== null,
        `Exit non-zero. Output was: ${r.output.slice(0, 300)}`,
      );
      check(
        `invalid lockfile (${label}): output names package-lock.json`,
        "The failure message must identify the lockfile",
        true,
        namesPath(r.output, LOCK),
        `Print the path ${LOCK}. Output was: ${r.output.slice(0, 300)}`,
      );
      check(
        `invalid lockfile (${label}): output says not valid JSON`,
        "The failure message must say why",
        true,
        r.output.includes("not valid JSON"),
        `Catch the JSON.parse error and print "${LOCK} is not valid JSON". Output was: ${r.output.slice(0, 300)}`,
      );
      check(
        `invalid lockfile (${label}): no stack trace`,
        "A parse failure is a reported problem, not an uncaught exception",
        { stackFrames: false, syntaxError: false },
        {
          stackFrames: r.output.includes("    at "),
          syntaxError: r.output.includes("SyntaxError:"),
        },
        `Wrap the lockfile JSON.parse in try/catch and report a one-line problem. Output was: ${r.output.slice(0, 300)}`,
      );
      for (const other of PIN_FILES) {
        check(
          `invalid lockfile (${label}): output must not name ${other}`,
          "Only the lockfile defect is reported",
          false,
          namesPath(r.output, other),
          `Report only the lockfile. Output was: ${r.output.slice(0, 300)}`,
        );
      }
    },
  );
});
