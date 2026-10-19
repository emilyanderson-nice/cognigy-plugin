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
const pinArgs = (version: string) => ["-y", "-p", pin(version), "cognigy-mcp"];

function readJson(root: string, rel: string): any {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}
function writeJson(root: string, rel: string, value: unknown): void {
  writeFileSync(join(root, rel), JSON.stringify(value, null, 2) + "\n");
}

const V: string = readJson(REAL_ROOT, "package.json").version;

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
        "Make the platform server args exactly: -y, -p, the fork github spec pinned to the release tag for the current package version, then the cognigy-mcp bin name.",
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
function makeValidCopy(version: string = V): string {
  const root = makeRawCopy();
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
        j.mcpServers.platform.args = [
          "-y",
          "-p",
          `github:${FORK}`,
          "cognigy-mcp",
        ];
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
        j.mcpServers.platform.args = [
          "-y",
          "-p",
          `github:pb-crackers/cognigy-plugin#v${V}`,
          "cognigy-mcp",
        ];
        writeJson(root, rel, j);
      },
    },
    {
      name: "(b4) rejects the npm alias spec in plugin/mcp.json",
      offender: "plugin/mcp.json",
      mutate: (root) => {
        const rel = "plugin/mcp.json";
        const j = readJson(root, rel);
        j.mcpServers.platform.args = [
          "-y",
          "-p",
          "cognigy-engine@npm:@cognigy/plugin-engine@1.22.0",
          "cognigy-mcp",
        ];
        writeJson(root, rel, j);
      },
    },
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
  it("(c1) with a base version sets <base>-pb.1 everywhere and leaves the check passing", () => {
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
      "The fork release version is the base version with a pb.1 suffix",
      "1.23.0-pb.1",
      readJson(root, "package.json").version,
      "Write <base>-pb.1 into package.json when given a new base version.",
    );
    for (const rel of PIN_FILES) {
      check(
        `${rel} args`,
        "Every pin file must follow the new release version",
        pinArgs("1.23.0-pb.1"),
        readJson(root, rel).mcpServers.platform.args,
        "Rewrite the engine pin in every pin file to the new fork tag.",
      );
    }
    expectCheckPasses(root, "after fork-version 1.23.0");
  });

  it("(c2) with no argument bumps the pb counter from 1.22.0-pb.1 to 1.22.0-pb.2", () => {
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
      "The pb counter increments by one, base version unchanged",
      "1.22.0-pb.2",
      readJson(root, "package.json").version,
      "Increment the numeric suffix after -pb. and keep the base version.",
    );
    for (const rel of PIN_FILES) {
      check(
        `${rel} args`,
        "Every pin file must follow the bumped version",
        pinArgs("1.22.0-pb.2"),
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
    ["1.22.0-pb.4", "1.22.0-pb.5"],
    ["1.22.0-pb.9", "1.22.0-pb.10"],
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

  it("a base and a counter argument set <base>-pb.<counter> exactly", () => {
    const root = makeValidCopy();
    const r = run(root, "fork-version.mjs", "1.20.0", "3");
    check(
      "fork-version 1.20.0 3 exit status",
      "A base plus counter argument is accepted",
      0,
      r.status,
      `Output was: ${r.output.slice(0, 300)}`,
    );
    expectAllAt(root, "1.20.0-pb.3");
    expectCheckPasses(root, "after fork-version 1.20.0 3");
  });

  it("the same base as the current version increments the counter", () => {
    const root = makeValidCopy("1.22.0-pb.3");
    const r = run(root, "fork-version.mjs", "1.22.0");
    check(
      "fork-version 1.22.0 on 1.22.0-pb.3 exit status",
      "Re-running with the current base is accepted",
      0,
      r.status,
      `Output was: ${r.output.slice(0, 300)}`,
    );
    expectAllAt(root, "1.22.0-pb.4");
  });
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

  it("(d2) exits 1 when a pin file still holds an npm engine spec", () => {
    const root = makeValidCopy();
    const rel = "plugin/mcp.json";
    const j = readJson(root, rel);
    j.mcpServers.platform.args = [
      "-y",
      "-p",
      "cognigy-engine@npm:@cognigy/plugin-engine@1.22.0",
      "cognigy-mcp",
    ];
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
