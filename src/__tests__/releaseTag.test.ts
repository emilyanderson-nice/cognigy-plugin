import { describe, it, expect, afterAll, jest } from "@jest/globals";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { spawnSync } from "child_process";

jest.setTimeout(180000);

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
// Read from the real package.json: the sandbox copies the real plugin/
// manifests, so a hard-coded version breaks on every `version:fork` bump.
const VERSION: string = (
  JSON.parse(readFileSync(join(REAL_ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const TAG = `v${VERSION}`;
// check:manifest requires scripts.prepare to be exactly this, so the sandbox
// package.json must carry it or release-tag refuses inside the sandbox.
const SANDBOX_PREPARE_SCRIPT = "node scripts/prepare.mjs";
const SCRIPT_URL = pathToFileURL(
  join(REAL_ROOT, "scripts", "release-tag.mjs"),
).href;

// ------------------------------------------------------------ pure API

interface Plan {
  tag: string;
  ok: boolean;
  problems: string[];
}

const GOOD_STATE = {
  version: VERSION,
  dirty: false,
  localTags: [] as string[],
  remoteTags: [] as string[],
  pinMatches: true,
  headOnRemote: true,
};

function planTag(state: Record<string, unknown>): Plan {
  const code = `
    const m = await import(${JSON.stringify(SCRIPT_URL)});
    process.stdout.write(JSON.stringify(m.planTag(${JSON.stringify(state)})));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      [
        "1. WHAT FAILED: loading planTag from scripts/release-tag.mjs",
        "2. REQUIREMENT VIOLATED: the module must export planTag(state)",
        "3. EXPECTED: JSON plan on stdout, exit 0",
        `4. ACTUAL: exit ${r.status}: ${(r.stderr || "").split("\n")[0]}`,
        "5. GUIDANCE: Create scripts/release-tag.mjs exporting planTag, and make importing the module free of side effects.",
      ].join("\n"),
    );
  }
  return JSON.parse(r.stdout);
}

const hasPhrase = (p: Plan, phrase: string) =>
  p.problems.some((x) => x.includes(phrase));

describe("release-tag planTag (pure)", () => {
  it("a fully good state is ok with no problems and the v-prefixed tag", () => {
    const p = planTag(GOOD_STATE);
    check(
      "good state plan",
      "A clean, pushed, pinned, unused fork version is releasable",
      { tag: TAG, ok: true, problems: [] },
      p,
      "Return tag v<version>, ok true and an empty problems list when no rule is violated.",
    );
  });

  const rules: Array<[string, Record<string, unknown>, string]> = [
    ["dirty working tree", { dirty: true }, "uncommitted changes"],
    ["tag exists locally", { localTags: [TAG] }, "already exists locally"],
    ["tag exists on origin", { remoteTags: [TAG] }, "already exists on origin"],
    ["manifest pin mismatch", { pinMatches: false }, "manifest pin"],
    ["HEAD not on remote", { headOnRemote: false }, "not pushed"],
    ["non fork version", { version: "1.22.0" }, "not a fork version"],
  ];

  for (const [name, patch, phrase] of rules) {
    it(`rule alone: ${name} -> "${phrase}" and nothing else`, () => {
      const state = { ...GOOD_STATE, ...patch };
      const p = planTag(state);
      check(
        `${name} plan`,
        `Violation must be reported with the phrase "${phrase}" and block the release`,
        { ok: false, count: 1, phrase: true, tag: `v${state.version}` },
        {
          ok: p.ok,
          count: p.problems.length,
          phrase: hasPhrase(p, phrase),
          tag: p.tag,
        },
        "Add exactly one problem containing the phrase for this rule, set ok to problems.length === 0, and compute tag as v plus version regardless of problems.",
      );
    });
  }

  it("unrelated tags in local and remote lists do not block", () => {
    const p = planTag({
      ...GOOD_STATE,
      localTags: ["v0.0.1-pb.1", `${TAG}0`],
      remoteTags: [`x${TAG}`],
    });
    check(
      "unrelated tags plan",
      "Only an exact match of the tag name counts as already existing",
      { ok: true, problems: [] },
      { ok: p.ok, problems: p.problems },
      "Compare tag names for equality, not by prefix or substring.",
    );
  });

  it("rejects fork-version look-alikes", () => {
    const bad = [
      "1.22.0-pb",
      "1.22.0-pb.",
      "1.22-pb.1",
      "v1.22.0-pb.1",
      "1.22.0-pb.1x",
      "1.22.0-rc.1",
    ];
    const got = bad.map((version) =>
      hasPhrase(planTag({ ...GOOD_STATE, version }), "not a fork version"),
    );
    check(
      "fork version regex",
      "Version must match ^\\d+\\.\\d+\\.\\d+-pb\\.\\d+$ exactly",
      bad.map(() => true),
      got,
      "Anchor the pattern at both ends and require three numeric parts, then -pb. and a number.",
    );
  });

  it("accepts multi digit fork versions", () => {
    const p = planTag({ ...GOOD_STATE, version: "10.200.3-pb.45" });
    check(
      "multi digit version",
      "Any numeric parts are valid",
      { tag: "v10.200.3-pb.45", ok: true, problems: [] },
      p,
      "Use \\d+ for every numeric part.",
    );
  });

  // Killing mutation: planTag still validates against the pb-only pattern, so an
  // esc version is flagged "not a fork version" and ok is false; or the tag is
  // rewritten (e.g. suffix changed) instead of v plus version.
  it.each(["1.22.2-esc.1", "10.200.3-esc.45"])(
    "an esc version %s plans tag v<version> and is ready",
    (version) => {
      check(
        `esc plan for ${version}`,
        "An esc fork version is releasable and tagged v plus the version",
        { tag: `v${version}`, ok: true, problems: [] },
        planTag({ ...GOOD_STATE, version }),
        "Validate with the shared FORK_VERSION_RE (esc or legacy pb) and compute the tag as v plus the version.",
      );
    },
  );

  // Killing mutation: pb dropped from the accepted forms (legacy versions and their tags break).
  it("a legacy pb version still plans its tag and is ready", () => {
    check(
      "legacy pb plan",
      "pb versions stay valid for existing tags and history",
      { tag: "v1.22.0-pb.3", ok: true, problems: [] },
      planTag({ ...GOOD_STATE, version: "1.22.0-pb.3" }),
      "Keep accepting <x.y.z>-pb.<n>.",
    );
  });

  // Killing mutation: an unanchored or case-insensitive pattern, or a loose suffix.
  it("rejects esc look-alikes and other suffixes as not a fork version", () => {
    const bad = [
      "1.22.2-esc",
      "1.22.2-esc.",
      "1.22.2-ESC.1",
      "1.22.2-esx.1",
      "v1.22.2-esc.1",
      "1.22.2-esc.1x",
      "1.22.2-pb.1-esc.1",
    ];
    check(
      "esc look-alikes",
      "Only digits.digits.digits-(esc|pb).digits is a fork version",
      bad.map(() => true),
      bad.map((version) =>
        hasPhrase(planTag({ ...GOOD_STATE, version }), "not a fork version"),
      ),
      "Use the shared anchored FORK_VERSION_RE without the i flag.",
    );
  });

  it("combined bad state accumulates every problem and still computes the tag", () => {
    const p = planTag({
      version: "2.0.0",
      dirty: true,
      localTags: ["v2.0.0"],
      remoteTags: ["v2.0.0"],
      pinMatches: false,
      headOnRemote: false,
    });
    check(
      "combined plan",
      "All violated rules are reported together",
      {
        tag: "v2.0.0",
        ok: false,
        count: 6,
        phrases: [true, true, true, true, true, true],
      },
      {
        tag: p.tag,
        ok: p.ok,
        count: p.problems.length,
        phrases: [
          "uncommitted changes",
          "already exists locally",
          "already exists on origin",
          "manifest pin",
          "not pushed",
          "not a fork version",
        ].map((ph) => hasPhrase(p, ph)),
      },
      "Do not stop at the first problem; collect one entry per violated rule.",
    );
  });

  it("remoteReadable false -> exactly one 'Could not read tags from origin' problem, tag still computed", () => {
    const p = planTag({ ...GOOD_STATE, remoteReadable: false });
    check(
      "remoteReadable false plan",
      "An unreadable origin means tag existence on origin is unknown, so the release is blocked",
      { ok: false, count: 1, phrase: true, tag: TAG },
      {
        ok: p.ok,
        count: p.problems.length,
        phrase: hasPhrase(p, "Could not read tags from origin"),
        tag: p.tag,
      },
      "When state.remoteReadable === false add exactly one problem containing 'Could not read tags from origin'; compute tag regardless.",
    );
  });

  it("tagAtHead false -> exactly one 'does not point at HEAD' problem, tag still computed", () => {
    const p = planTag({ ...GOOD_STATE, tagAtHead: false });
    check(
      "tagAtHead false plan",
      "A tag that is not at HEAD must not be published",
      { ok: false, count: 1, phrase: true, tag: TAG },
      {
        ok: p.ok,
        count: p.problems.length,
        phrase: hasPhrase(p, "does not point at HEAD"),
        tag: p.tag,
      },
      "When state.tagAtHead === false add exactly one problem containing 'does not point at HEAD'; compute tag regardless.",
    );
  });

  it("state without remoteReadable and tagAtHead is healthy (undefined is not false)", () => {
    const p = planTag(GOOD_STATE);
    check(
      "optional fields omitted",
      "Omitted remoteReadable/tagAtHead mean healthy; only an explicit false is a problem",
      { ok: true, problems: [], hasReadPhrase: false, hasHeadPhrase: false },
      {
        ok: p.ok,
        problems: p.problems,
        hasReadPhrase: hasPhrase(p, "Could not read tags"),
        hasHeadPhrase: hasPhrase(p, "does not point at HEAD"),
      },
      "Test strictly === false for both fields, never falsy.",
    );
  });

  it("explicit true for remoteReadable and tagAtHead is healthy", () => {
    const p = planTag({ ...GOOD_STATE, remoteReadable: true, tagAtHead: true });
    check(
      "optional fields true",
      "True values report nothing",
      { ok: true, problems: [] },
      { ok: p.ok, problems: p.problems },
      "Only add the problems when the field is explicitly false.",
    );
  });

  it("originIsFork false -> exactly one 'origin remote is not' problem, tag still computed", () => {
    const p = planTag({ ...GOOD_STATE, originIsFork: false });
    check(
      "originIsFork false plan",
      "An origin that is not this fork must block the release",
      { ok: false, count: 1, phrase: true, tag: TAG },
      {
        ok: p.ok,
        count: p.problems.length,
        phrase: hasPhrase(p, "origin remote is not"),
        tag: p.tag,
      },
      "When state.originIsFork === false add exactly one problem containing 'origin remote is not'; compute tag regardless.",
    );
  });

  it("originIsFork omitted or true is healthy (undefined is not false)", () => {
    const omitted = planTag(GOOD_STATE);
    const yes = planTag({ ...GOOD_STATE, originIsFork: true });
    check(
      "originIsFork healthy",
      "Only an explicit false is a problem",
      {
        omitted: { ok: true, problems: [] },
        yes: { ok: true, problems: [] },
      },
      {
        omitted: { ok: omitted.ok, problems: omitted.problems },
        yes: { ok: yes.ok, problems: yes.problems },
      },
      "Test strictly === false for originIsFork, never falsy.",
    );
  });

  it("originIsFork false accumulates with other problems", () => {
    const p = planTag({
      ...GOOD_STATE,
      originIsFork: false,
      dirty: true,
      headOnRemote: false,
    });
    check(
      "originIsFork accumulates",
      "The origin problem is reported alongside every other violated rule",
      { ok: false, count: 3, origin: true, dirty: true, pushed: true },
      {
        ok: p.ok,
        count: p.problems.length,
        origin: hasPhrase(p, "origin remote is not"),
        dirty: hasPhrase(p, "uncommitted changes"),
        pushed: hasPhrase(p, "not pushed"),
      },
      "Collect one problem per violated rule; do not short-circuit.",
    );
  });

  it("remoteReadable false and tagAtHead false accumulate two problems", () => {
    const p = planTag({
      ...GOOD_STATE,
      remoteReadable: false,
      tagAtHead: false,
    });
    check(
      "both new fields false",
      "Both violations are reported together",
      { ok: false, count: 2, read: true, head: true, tag: TAG },
      {
        ok: p.ok,
        count: p.problems.length,
        read: hasPhrase(p, "Could not read tags from origin"),
        head: hasPhrase(p, "does not point at HEAD"),
        tag: p.tag,
      },
      "Collect one problem per violated rule; do not short-circuit.",
    );
  });
});

// --------------------------------------------------------- package.json

describe("release-tag npm script", () => {
  it("package.json exposes release:tag", () => {
    const pkg = JSON.parse(
      readFileSync(join(REAL_ROOT, "package.json"), "utf8"),
    );
    check(
      "package.json scripts.release:tag",
      "The release flow is run via npm run release:tag",
      "node scripts/release-tag.mjs",
      pkg.scripts["release:tag"],
      "Add scripts['release:tag'] with exactly: node scripts/release-tag.mjs",
    );
  });
});

// ------------------------------------------------------------ CLI sandbox

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && !args.includes("--allow-fail")) {
    throw new Error(`git ${args.join(" ")} failed in sandbox: ${r.stderr}`);
  }
  return (r.stdout || "").trim();
}

interface Sandbox {
  origin: string;
  clone: string;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "release-tag-"));
  roots.push(root);
  // The script requires origin to name this fork, so the path must end in it.
  const origin = join(root, "emilyanderson-nice", "cognigy-plugin.git");
  const clone = join(root, "clone");
  mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--bare", "--initial-branch=main"]);
  git(root, ["clone", origin, "clone"]);
  git(clone, ["config", "user.name", "Sandbox"]);
  git(clone, ["config", "user.email", "sandbox@example.invalid"]);
  git(clone, ["config", "commit.gpgsign", "false"]);
  git(clone, ["config", "tag.gpgsign", "false"]);
  git(clone, ["config", "core.autocrlf", "false"]);
  git(clone, ["checkout", "-B", "main"]);
  writeFileSync(
    join(clone, "package.json"),
    JSON.stringify(
      {
        name: "sandbox",
        version: VERSION,
        scripts: { prepare: SANDBOX_PREPARE_SCRIPT },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(clone, "notes.txt"), "one\n");
  cpSync(join(REAL_ROOT, "scripts"), join(clone, "scripts"), {
    recursive: true,
  });
  cpSync(join(REAL_ROOT, "plugin"), join(clone, "plugin"), { recursive: true });
  if (existsSync(join(REAL_ROOT, ".claude-plugin"))) {
    cpSync(join(REAL_ROOT, ".claude-plugin"), join(clone, ".claude-plugin"), {
      recursive: true,
    });
  }
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "-m", "initial"]);
  git(clone, ["push", "-u", "origin", "main"]);
  return { origin, clone };
}

function run(
  sb: Sandbox,
  flags: string[],
  where: { cwd?: string; script?: string } = {},
) {
  const r = spawnSync(
    process.execPath,
    [where.script ?? "scripts/release-tag.mjs", ...flags],
    { cwd: where.cwd ?? sb.clone, encoding: "utf8" },
  );
  return {
    status: r.status,
    out: `${r.stdout || ""}\n${r.stderr || ""}`,
  };
}

const localTags = (sb: Sandbox) =>
  git(sb.clone, ["tag", "--list"]).split(/\r?\n/).filter(Boolean);
const remoteTags = (sb: Sandbox) =>
  git(sb.clone, ["ls-remote", "--refs", "--tags", sb.origin])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[1]);

describe("release-tag CLI (throwaway git sandbox)", () => {
  it("dry run by default: reports the tag and creates nothing", () => {
    const sb = makeSandbox();
    const r = run(sb, []);
    check(
      "dry run",
      "Without flags the script only reports; no tag locally or on origin",
      { status: 0, mentions: true, local: [], remote: [] },
      {
        status: r.status,
        mentions: r.out.includes(TAG),
        local: localTags(sb),
        remote: remoteTags(sb),
      },
      "Print the planned tag name and exit 0; only touch git refs when --create or --push is passed.",
    );
  });

  it("--create makes a local annotated tag at HEAD and does not push", () => {
    const sb = makeSandbox();
    const r = run(sb, ["--create"]);
    const head = git(sb.clone, ["rev-parse", "HEAD"]);
    const exists = localTags(sb).includes(TAG);
    check(
      "--create",
      "An annotated tag v<version> must point at HEAD, locally only",
      {
        status: 0,
        exists: true,
        type: "tag",
        target: head,
        remote: [],
      },
      {
        status: r.status,
        exists,
        type: exists ? git(sb.clone, ["cat-file", "-t", TAG]) : null,
        target: exists ? git(sb.clone, ["rev-list", "-n1", TAG]) : null,
        remote: remoteTags(sb),
      },
      "Create the tag with an annotation (not lightweight) at HEAD and do not push unless --push is given.",
    );
  });

  it("--create --push pushes only the new tag to origin", () => {
    const sb = makeSandbox();
    git(sb.clone, ["tag", "v0.0.9-decoy"]);
    const r = run(sb, ["--create", "--push"]);
    check(
      "--create --push",
      "Exactly the release tag reaches origin; unrelated local tags stay local",
      { status: 0, remote: [`refs/tags/${TAG}`], localHas: true },
      {
        status: r.status,
        remote: remoteTags(sb),
        localHas: localTags(sb).includes(TAG),
      },
      "Push the single tag ref by name; never use --tags or push all tags.",
    );
  });

  it("refuses a dirty working tree", () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.clone, "notes.txt"), "one\nchanged\n");
    const r = run(sb, ["--create"]);
    check(
      "dirty tree",
      "Uncommitted changes block tag creation",
      { nonZero: true, mentions: true, local: [], remote: [] },
      {
        nonZero: r.status !== 0,
        mentions: r.out.includes("uncommitted changes"),
        local: localTags(sb),
        remote: remoteTags(sb),
      },
      "Check git status for tracked modifications, report 'uncommitted changes' and exit non-zero before creating anything.",
    );
  });

  it("refuses when the tag already exists locally", () => {
    const sb = makeSandbox();
    git(sb.clone, ["tag", "-a", TAG, "-m", "pre-existing"]);
    const r = run(sb, ["--create"]);
    check(
      "tag exists locally",
      "An existing local tag must not be overwritten",
      { nonZero: true, mentions: true },
      {
        nonZero: r.status !== 0,
        mentions: r.out.includes("already exists locally"),
      },
      "Detect the local tag, report 'already exists locally' and exit non-zero.",
    );
  });

  it("refuses when the tag already exists on origin only", () => {
    const sb = makeSandbox();
    git(sb.clone, ["tag", "-a", TAG, "-m", "published"]);
    git(sb.clone, ["push", "origin", `refs/tags/${TAG}`]);
    git(sb.clone, ["tag", "-d", TAG]);
    const r = run(sb, ["--create"]);
    check(
      "tag exists on origin",
      "A tag published on origin must not be recreated",
      { nonZero: true, mentions: true, local: [] },
      {
        nonZero: r.status !== 0,
        mentions: r.out.includes("already exists on origin"),
        local: localTags(sb),
      },
      "Query origin for tags, report 'already exists on origin' and exit non-zero without creating a local tag.",
    );
  });

  it("refuses when HEAD has not been pushed", () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.clone, "notes.txt"), "one\nunpushed\n");
    git(sb.clone, ["commit", "-am", "local only"]);
    const r = run(sb, ["--create"]);
    check(
      "HEAD not pushed",
      "A tag must not point at a commit origin lacks",
      { nonZero: true, mentions: true, local: [] },
      {
        nonZero: r.status !== 0,
        mentions: r.out.includes("not pushed"),
        local: localTags(sb),
      },
      "Verify HEAD is reachable on origin; otherwise report 'not pushed' and exit non-zero.",
    );
  });

  it("refuses when the manifest pin does not match the version", () => {
    const sb = makeSandbox();
    const f = join(sb.clone, "plugin", "mcp.json");
    const text = readFileSync(f, "utf8");
    writeFileSync(f, text.split(`#${TAG}`).join("#v0.0.1"));
    git(sb.clone, ["commit", "-am", "wrong pin"]);
    git(sb.clone, ["push", "origin", "main"]);
    const r = run(sb, ["--create"]);
    check(
      "pin mismatch",
      "The manifests must pin the tag being created",
      { changed: true, nonZero: true, mentions: true, local: [] },
      {
        changed: text.includes(`#${TAG}`),
        nonZero: r.status !== 0,
        mentions: r.out.includes("manifest pin"),
        local: localTags(sb),
      },
      "Run the manifest pin check against package.json version; report 'manifest pin' and exit non-zero on mismatch.",
    );
  });

  it("--push alone publishes an existing local tag", () => {
    const sb = makeSandbox();
    git(sb.clone, ["tag", "-a", TAG, "-m", "local"]);
    const r = run(sb, ["--push"]);
    check(
      "--push alone",
      "--push publishes the already-created local tag",
      { status: 0, remote: [`refs/tags/${TAG}`] },
      { status: r.status, remote: remoteTags(sb) },
      "With --push and no --create, push the existing local tag by name.",
    );
  });

  it("unreachable origin: dry run and --create fail with 'Could not read tags from origin' and create no tag", () => {
    const sb = makeSandbox();
    const missing = join(dirname(sb.origin), "does-not-exist.git");
    git(sb.clone, ["remote", "set-url", "origin", missing]);
    const dry = run(sb, []);
    const create = run(sb, ["--create"]);
    check(
      "unreachable origin",
      "If origin tags cannot be read, existence on origin is unknown: block, never assume absent",
      {
        dryNonZero: true,
        dryMentions: true,
        createNonZero: true,
        createMentions: true,
        local: [],
      },
      {
        dryNonZero: dry.status !== 0,
        dryMentions: dry.out.includes("Could not read tags from origin"),
        createNonZero: create.status !== 0,
        createMentions: create.out.includes("Could not read tags from origin"),
        local: localTags(sb),
      },
      "Treat a failing ls-remote against origin as remoteReadable false, report 'Could not read tags from origin' and exit non-zero before creating anything.",
    );
  });

  it("HEAD present only on another remote does not count as pushed", () => {
    const sb = makeSandbox();
    const other = join(dirname(sb.origin), "other.git");
    mkdirSync(other);
    git(other, ["init", "--bare", "--initial-branch=main"]);
    git(sb.clone, ["remote", "add", "other", other]);
    writeFileSync(join(sb.clone, "notes.txt"), "one\nonly on other\n");
    git(sb.clone, ["commit", "-am", "pushed to other only"]);
    git(sb.clone, ["push", "other", "main"]);
    git(sb.clone, ["fetch", "other"]);
    const head = git(sb.clone, ["rev-parse", "HEAD"]);
    const r = run(sb, ["--create"]);
    check(
      "HEAD only on other remote",
      "Only origin counts: a commit on a different remote is not pushed",
      {
        otherHasHead: true,
        originHasHead: false,
        nonZero: true,
        mentions: true,
        local: [],
      },
      {
        otherHasHead:
          git(sb.clone, ["ls-remote", other, "refs/heads/main"]).split(
            /\s+/,
          )[0] === head,
        originHasHead:
          git(sb.clone, ["ls-remote", sb.origin, "refs/heads/main"]).split(
            /\s+/,
          )[0] === head,
        nonZero: r.status !== 0,
        mentions: r.out.includes("not pushed"),
        local: localTags(sb),
      },
      "Check reachability from origin's remote-tracking refs only (refs/remotes/origin/*), not any remote branch; report 'not pushed' and exit non-zero.",
    );
  });

  it("--push alone refuses a stale local tag that does not point at HEAD", () => {
    const sb = makeSandbox();
    const created = run(sb, ["--create"]);
    const tagTarget = git(sb.clone, ["rev-list", "-n1", TAG]);
    writeFileSync(join(sb.clone, "notes.txt"), "one\nnewer\n");
    git(sb.clone, ["commit", "-am", "newer commit"]);
    git(sb.clone, ["push", "origin", "main"]);
    const head = git(sb.clone, ["rev-parse", "HEAD"]);
    const r = run(sb, ["--push"]);
    check(
      "--push stale tag",
      "A local tag at an older commit must not be published as the release",
      {
        createdOk: true,
        tagIsStale: true,
        nonZero: true,
        mentions: true,
        remote: [],
      },
      {
        createdOk: created.status === 0,
        tagIsStale: tagTarget !== head,
        nonZero: r.status !== 0,
        mentions: r.out.includes("does not point at HEAD"),
        remote: remoteTags(sb),
      },
      "Before pushing, compare the local tag's commit to HEAD; report 'does not point at HEAD', exit non-zero and push nothing.",
    );
  });

  it("--push alone with no local tag fails", () => {
    const sb = makeSandbox();
    const r = run(sb, ["--push"]);
    check(
      "--push without tag",
      "Nothing to push means failure, and nothing is created",
      { nonZero: true, local: [], remote: [] },
      { nonZero: r.status !== 0, local: localTags(sb), remote: remoteTags(sb) },
      "Exit non-zero when the local tag is missing; do not create it implicitly.",
    );
  });

  /** A bare repo at <root>/<owner>/cognigy-plugin.git, seeded with main so only identity differs. */
  function makeOtherOrigin(sb: Sandbox, owner: string): string {
    const other = join(
      dirname(dirname(sb.origin)),
      owner,
      "cognigy-plugin.git",
    );
    mkdirSync(other, { recursive: true });
    git(other, ["init", "--bare", "--initial-branch=main"]);
    git(sb.clone, ["push", other, "main"]);
    return other;
  }

  it("origin pointing at another repo (Cognigy/cognigy-plugin.git): dry run and --create refuse, no tag", () => {
    const sb = makeSandbox();
    const other = makeOtherOrigin(sb, "Cognigy");
    git(sb.clone, ["remote", "set-url", "origin", other]);
    git(sb.clone, ["fetch", "origin"]);
    const dry = run(sb, []);
    const create = run(sb, ["--create"]);
    check(
      "origin is another repo",
      "A tag must only be created/published against this fork's origin",
      {
        dryNonZero: true,
        dryMentions: true,
        createNonZero: true,
        createMentions: true,
        local: [],
        remoteOnOther: [],
      },
      {
        dryNonZero: dry.status !== 0,
        dryMentions: dry.out.includes("origin remote is not"),
        createNonZero: create.status !== 0,
        createMentions: create.out.includes("origin remote is not"),
        local: localTags(sb),
        remoteOnOther: git(sb.clone, ["ls-remote", "--refs", "--tags", other])
          .split(/\r?\n/)
          .filter(Boolean),
      },
      "Read `git remote get-url origin`, normalise it (slashes, strip .git and trailing /, lower-case) and require it to end in /emilyanderson-nice/cognigy-plugin or :emilyanderson-nice/cognigy-plugin; otherwise report 'origin remote is not' and exit non-zero.",
    );
  });

  it("push URL pointing at another repo is refused even when the fetch URL is this fork", () => {
    const sb = makeSandbox();
    const other = makeOtherOrigin(sb, "pb-crackers");
    git(sb.clone, ["config", "remote.origin.pushurl", other]);
    const fetchUrl = git(sb.clone, ["remote", "get-url", "origin"]);
    const dry = run(sb, []);
    const create = run(sb, ["--create", "--push"]);
    check(
      "push URL is another repo",
      "Both the fetch URL and the push URL of origin must name this fork",
      {
        fetchIsFork: true,
        dryNonZero: true,
        dryMentions: true,
        createNonZero: true,
        createMentions: true,
        local: [],
      },
      {
        fetchIsFork: /emilyanderson-nice[\\/]cognigy-plugin\.git$/.test(
          fetchUrl,
        ),
        dryNonZero: dry.status !== 0,
        dryMentions: dry.out.includes("origin remote is not"),
        createNonZero: create.status !== 0,
        createMentions: create.out.includes("origin remote is not"),
        local: localTags(sb),
      },
      "Also check `git remote get-url --push origin` (it expands insteadOf/pushInsteadOf) against the same fork-suffix rule.",
    );
  });

  it("works from a subdirectory of the clone: dry run reports the tag, --create tags HEAD", () => {
    const sb = makeSandbox();
    const where = {
      cwd: join(sb.clone, "plugin"),
      script: join("..", "scripts", "release-tag.mjs"),
    };
    const dry = run(sb, [], where);
    const afterDry = localTags(sb);
    const create = run(sb, ["--create"], where);
    const head = git(sb.clone, ["rev-parse", "HEAD"]);
    const exists = localTags(sb).includes(TAG);
    check(
      "subdirectory run",
      "The script must resolve the repo root itself and behave the same from any subdirectory",
      {
        dryStatus: 0,
        dryMentionsTag: true,
        dryUndefined: false,
        afterDry: [],
        createStatus: 0,
        createUndefined: false,
        exists: true,
        target: head,
      },
      {
        dryStatus: dry.status,
        dryMentionsTag: dry.out.includes(TAG),
        dryUndefined: dry.out.includes("vundefined"),
        afterDry,
        createStatus: create.status,
        createUndefined: create.out.includes("vundefined"),
        exists,
        target: exists ? git(sb.clone, ["rev-list", "-n1", TAG]) : null,
      },
      "Find the repo root with `git rev-parse --show-toplevel` and read package.json / run checks there, not in process.cwd().",
    );
  });

  it("--create --push with a rejecting origin: fails, keeps the local tag and says to retry with --push", () => {
    const sb = makeSandbox();
    const hookPath = join(sb.origin, "hooks", "pre-receive");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    // Linux git silently ignores a hook that is not executable.
    chmodSync(hookPath, 0o755);
    if (process.platform !== "win32") {
      let executable = true;
      try {
        accessSync(hookPath, constants.X_OK);
      } catch {
        executable = false;
      }
      check(
        "precondition: rejecting hook is executable",
        "The pre-receive hook that makes origin reject pushes must be executable, or git ignores it and the push succeeds",
        { executable: true },
        { executable },
        "chmod the hook file to 0o755 right after writing it (fs.chmodSync) before running the script under test.",
      );
    }
    const r = run(sb, ["--create", "--push"]);
    const exists = localTags(sb).includes(TAG);
    check(
      "push rejected",
      "A failed push must be reported with the recovery step, not leave the user guessing",
      {
        nonZero: true,
        localType: "tag",
        remote: [],
        mentionsLocalTag: true,
        mentionsRetry: true,
      },
      {
        nonZero: r.status !== 0,
        localType: exists ? git(sb.clone, ["cat-file", "-t", TAG]) : null,
        remote: remoteTags(sb),
        mentionsLocalTag: /local tag/i.test(r.out),
        mentionsRetry: r.out.includes("--push"),
      },
      "When the push fails, exit non-zero, keep the local annotated tag, and print that the local tag exists and can be published later with `--push`.",
    );
  });

  describe("origin/<branch> remote-tracking ref freshness", () => {
    function pushWorkBranch(sb: Sandbox) {
      git(sb.clone, ["checkout", "-b", "work"]);
      writeFileSync(join(sb.clone, "notes.txt"), "one\nwork change\n");
      git(sb.clone, ["commit", "-am", "work change"]);
      git(sb.clone, ["push", "-u", "origin", "work"]);
    }

    it("control: HEAD on a pushed branch that still exists on origin is accepted", () => {
      const sb = makeSandbox();
      pushWorkBranch(sb);
      const head = git(sb.clone, ["rev-parse", "HEAD"]);
      const r = run(sb, ["--create"]);
      check(
        "pushed work branch",
        "A commit that origin really has is releasable",
        { status: 0, target: head },
        {
          status: r.status,
          target: localTags(sb).includes(TAG)
            ? git(sb.clone, ["rev-list", "-n1", TAG])
            : null,
        },
        "Fetch origin and accept HEAD when it is reachable from any origin branch.",
      );
    });

    it("a stale origin/work ref whose branch was deleted on origin does not count as pushed", () => {
      const sb = makeSandbox();
      pushWorkBranch(sb);
      git(sb.origin, ["branch", "-D", "work"]);
      const head = git(sb.clone, ["rev-parse", "HEAD"]);
      const staleStillContainsHead = git(sb.clone, [
        "branch",
        "-r",
        "--contains",
        head,
      ]).includes("origin/work");
      const r = run(sb, ["--create"]);
      check(
        "stale tracking ref",
        "Reachability must be judged against origin's current branches, not a stale local copy",
        {
          staleStillContainsHead: true,
          nonZero: true,
          mentions: true,
          local: [],
        },
        {
          staleStillContainsHead,
          nonZero: r.status !== 0,
          mentions: r.out.includes("not pushed"),
          local: localTags(sb),
        },
        "Run `git fetch --prune origin` before checking `git branch -r --contains HEAD`; if the branch is gone the commit is 'not pushed'.",
      );
    });
  });

  it("pin check is the full manifest check: a stale version in plugin/.codex-plugin/plugin.json blocks the tag", () => {
    const sb = makeSandbox();
    const f = join(sb.clone, "plugin", ".codex-plugin", "plugin.json");
    const before = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(
      f,
      JSON.stringify({ ...before, version: "0.0.1" }, null, 2) + "\n",
    );
    git(sb.clone, ["commit", "-am", "stale codex version"]);
    git(sb.clone, ["push", "origin", "main"]);
    const r = run(sb, ["--create"]);
    check(
      "codex manifest version",
      "Any manifest out of step with package.json version blocks the release, not only the pin files",
      {
        before: VERSION,
        nonZero: true,
        mentions: true,
        local: [],
      },
      {
        before: before.version,
        nonZero: r.status !== 0,
        mentions: r.out.includes("manifest pin"),
        local: localTags(sb),
      },
      "Derive pinMatches from the complete manifest check (the same logic as check-plugin-manifest) rather than only comparing the pin strings.",
    );
  });
});
