import { describe, it, expect } from "@jest/globals";
import { spawnSync } from "child_process";
import { join } from "path";
import { pathToFileURL } from "url";

const MODULE_URL = pathToFileURL(
  join(process.cwd(), "scripts", "merge-resolution.mjs"),
).href;

const FORK = "github:emilyanderson-nice/cognigy-plugin";
const OLD = "github:pb-crackers/cognigy-plugin";
const UPSTREAM = "github:Cognigy/cognigy-plugin";
const aliasFor = (version: string) =>
  `cognigy-engine@npm:@cognigy/plugin-engine@${version}`;
const FLAG = "--allow-git=root";
const ALIAS_VERSIONS = ["1.23.0", "1.22.0-pb.1", "2.0.0", "latest"];

interface Outcome {
  ok: boolean;
  value?: unknown;
  message?: string;
}

/** Run `expr` (using m = module, a = args) in a child node; capture value or thrown message. */
function callModule(expr: string, args: unknown): Outcome {
  const code =
    `import(${JSON.stringify(MODULE_URL)}).then(m=>{` +
    `const a=JSON.parse(process.env.CALL_ARGS);let o;` +
    `try{o={ok:true,value:${expr}}}catch(e){o={ok:false,message:String(e&&e.message)}}` +
    `console.log(JSON.stringify(o))})`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, CALL_ARGS: JSON.stringify(args) },
  });
  if (r.status !== 0) {
    throw new Error(
      [
        "1. WHAT FAILED: loading scripts/merge-resolution.mjs in a child process",
        "2. REQUIREMENT VIOLATED: the module must import cleanly and export the called function",
        "3. EXPECTED: exit status 0",
        `4. ACTUAL: status ${r.status}; stderr first line: ${(r.stderr ?? "").split("\n")[0]}`,
        "5. GUIDANCE: Export resolveManifestText(file, src) and countHunks(src) from scripts/merge-resolution.mjs; importing must have no side effects.",
      ].join("\n"),
    );
  }
  return JSON.parse(r.stdout.trim());
}

/** resolveManifestText that reports a throw instead of failing the harness. */
const tryResolve = (file: string, src: string): Outcome =>
  callModule("m.resolveManifestText(a.file,a.src)", { file, src });

/** countHunks(src); a thrown error is reported as null. */
function countHunks(src: string): unknown {
  const o = callModule("m.countHunks(a.src)", { src });
  return o.ok ? o.value : `THREW: ${o.message}`;
}

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

/** Call resolveManifestText(file, src) in a child node; args travel as JSON via env. */
function resolveManifestText(file: string, src: string): string {
  const code =
    `import(${JSON.stringify(MODULE_URL)}).then(m=>{` +
    `const a=JSON.parse(process.env.RESOLVE_ARGS);` +
    `console.log(JSON.stringify(m.resolveManifestText(a.file,a.src)))})`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, RESOLVE_ARGS: JSON.stringify({ file, src }) },
  });
  if (r.status !== 0) {
    throw new Error(
      [
        "1. WHAT FAILED: loading/calling resolveManifestText from scripts/merge-resolution.mjs",
        "2. REQUIREMENT VIOLATED: scripts/merge-resolution.mjs must be an importable ES module exporting resolveManifestText(file, src)",
        `3. EXPECTED: exit status 0 for file ${file}`,
        `4. ACTUAL: status ${r.status}; stderr first line: ${(r.stderr ?? "").split("\n")[0]}`,
        "5. GUIDANCE: Create scripts/merge-resolution.mjs exporting a pure function resolveManifestText(file, src) returning a string.",
      ].join("\n"),
    );
  }
  return JSON.parse(r.stdout.trim());
}

const hunk = (ours: string, theirs: string, nl = "\n") =>
  `<<<<<<< HEAD${nl}${ours}${nl}=======${nl}${theirs}${nl}>>>>>>> upstream/main${nl}`;

describe("resolveManifestText: conflict hunks in ordinary files", () => {
  it("replaces a hunk with the THEIRS side and preserves surrounding text exactly", () => {
    const src = `before\n  keep  \n${hunk("OURS-LINE", "THEIRS-LINE")}after\n`;
    check(
      "single hunk resolves to theirs",
      "In non-marketplace files the upstream (theirs) side wins; markers and ours vanish",
      "before\n  keep  \nTHEIRS-LINE\nafter\n",
      resolveManifestText("plugin/mcp.json", src),
      "Replace each conflict block with only the lines between ======= and >>>>>>>; leave all other bytes untouched.",
    );
  });

  it("keeps every line of a multi-line theirs side", () => {
    const src = hunk("o1\no2", "t1\n  t2\nt3");
    check(
      "multi-line theirs side",
      "The whole theirs side is kept, indentation included",
      "t1\n  t2\nt3\n",
      resolveManifestText("plugin/plugin.json", src),
      "Keep every line between the ======= and >>>>>>> markers verbatim.",
    );
  });

  it("resolves two hunks in one file independently", () => {
    const src = `a\n${hunk("o1", "t1")}b\n${hunk("o2", "t2")}c\n`;
    check(
      "two hunks",
      "Every hunk in the file is resolved, not just the first",
      "a\nt1\nb\nt2\nc\n",
      resolveManifestText("plugin/mcp.json", src),
      "Resolve hunks in a loop/global replace; each hunk keeps only its own theirs side.",
    );
  });

  it("resolves CRLF markers and keeps CRLF inside the kept side", () => {
    const src = `a\r\n${hunk("o1\r\no2", "t1\r\nt2", "\r\n")}b\r\n`;
    check(
      "CRLF hunk",
      "Windows line endings do not stop hunks from resolving and are preserved in kept text",
      "a\r\nt1\r\nt2\r\nb\r\n",
      resolveManifestText("plugin/mcp.json", src),
      "Treat \\r\\n as a line break when recognising markers; do not normalise the kept text to \\n.",
    );
  });

  it("resolves a hunk whose theirs side is empty to nothing", () => {
    const src = `a\n<<<<<<< HEAD\nOURS\n=======\n>>>>>>> upstream/main\nb\n`;
    check(
      "empty theirs side",
      "An empty theirs side removes the hunk entirely",
      "a\nb\n",
      resolveManifestText("plugin/mcp.json", src),
      "When there are no lines between ======= and >>>>>>>, the hunk contributes nothing.",
    );
  });

  it("returns text without markers unchanged", () => {
    const src = `line one\r\nline two\n\ttabbed \n`;
    check(
      "no markers",
      "Text with no conflicts and no spec strings passes through byte-for-byte",
      src,
      resolveManifestText("plugin/mcp.json", src),
      "Do not alter, trim or re-wrap text outside hunks.",
    );
  });
});

describe("resolveManifestText: engine spec normalisation", () => {
  it.each(ALIAS_VERSIONS)(
    "turns the npm alias spec (version %s) into the unpinned fork spec",
    (version) => {
      const src = `{"args":["-y","-p","${aliasFor(version)}","cognigy-mcp"]}`;
      check(
        `npm alias spec ${version}`,
        "The fork installs its engine from GitHub; whatever version the alias carries is dropped",
        `{"args":["${FLAG}","-y","-p","${FORK}","cognigy-mcp"]}`,
        resolveManifestText("plugin/mcp.json", src),
        "Rewrite cognigy-engine@npm:@cognigy/plugin-engine@<any version text> to the unpinned fork github: spec (do not hard-code a version) and make --allow-git=root the first element of that args array.",
      );
    },
  );

  it.each(ALIAS_VERSIONS)(
    "normalises an alias (version %s) arriving through the theirs side of a hunk",
    (version) => {
      const alias = aliasFor(version);
      const src = `x\n${hunk(`"${FORK}"`, `"${alias}"`)}y\n`;
      check(
        `alias inside theirs side ${version}`,
        "Normalisation applies after the theirs side is chosen, for any alias version",
        `x\n"${FORK}"\ny\n`,
        resolveManifestText("plugin/mcp.json", src),
        "Resolve hunks first, then normalise engine specs in the resulting text.",
      );
    },
  );

  it.each(ALIAS_VERSIONS)(
    "rewrites every occurrence of mixed spec forms including alias version %s",
    (version) => {
      check(
        `multiple specs ${version}`,
        "All occurrences are normalised",
        `{"a":"${FORK}","b":"${FORK}","c":"${FORK}"}`,
        resolveManifestText(
          "plugin/mcp.json",
          `{"a":"${OLD}#v1.0.0-pb.1","b":"${aliasFor(version)}","c":"${FORK}#v2.0.0"}`,
        ),
        "Use a global replacement for each spec form.",
      );
    },
  );

  it.each([
    ["previous-fork pinned spec", `${OLD}#v1.23.0-pb.3`],
    ["previous-fork unpinned spec", OLD],
    ["current-fork pinned spec", `${FORK}#v1.22.0-pb.1`],
  ])("%s becomes the unpinned fork spec", (_label, spec) => {
    check(
      `normalise ${spec}`,
      "Every fork or legacy-fork spec ends up as the unpinned current fork spec",
      `{"a":"${FORK}","b":1}`,
      resolveManifestText("plugin/mcp.json", `{"a":"${spec}","b":1}`),
      "Strip any '#v...' pin and map the legacy owner to the current fork owner.",
    );
  });

  it("leaves Cognigy's own upstream spec untouched, pinned or not", () => {
    const src = `{"a":"${UPSTREAM}","b":"${UPSTREAM}#v1.0.0"}`;
    check(
      "upstream spec untouched",
      "Only fork and legacy-fork specs are rewritten",
      src,
      resolveManifestText("plugin/mcp.json", src),
      "Match only the fork and legacy-fork github: specs, never github:Cognigy/cognigy-plugin.",
    );
  });

  it("collapses two adjacent identical spec array entries into one", () => {
    const src = `["-y",\n    "-p",\n    "${FORK}",\n    "${FORK}",\n    "cognigy-mcp"]`;
    check(
      "adjacent duplicate entries",
      "Merging must not leave the same spec twice in an args array",
      `["${FLAG}",\n    "-y",\n    "-p",\n    "${FORK}",\n    "cognigy-mcp"]`,
      resolveManifestText("plugin/mcp.json", src),
      "Drop an array entry that repeats the previous entry (separated only by a comma and whitespace); the array holds the engine spec, so it also gains --allow-git=root as its first element, reusing the separator that follows the first element.",
    );
  });

  it("collapses entries that only become identical after normalisation", () => {
    const src = `["-p",\n  "${FORK}#v1.22.0-pb.1",\n  "${OLD}",\n  "tail"]`;
    check(
      "duplicates after normalisation",
      "Deduplication happens on the normalised spec",
      `["${FLAG}",\n  "-p",\n  "${FORK}",\n  "tail"]`,
      resolveManifestText("plugin/mcp.json", src),
      "Normalise specs first, then collapse adjacent identical entries.",
    );
  });

  it("does not collapse non-adjacent or non-spec duplicates", () => {
    const src = `["-p",\n  "${FORK}",\n  "other",\n  "${FORK}",\n  "x",\n  "x"]`;
    check(
      "non-adjacent duplicates kept",
      "Only adjacent identical spec entries collapse",
      `["${FLAG}",\n  "-p",\n  "${FORK}",\n  "other",\n  "${FORK}",\n  "x",\n  "x"]`,
      resolveManifestText("plugin/mcp.json", src),
      "Limit deduplication to immediately adjacent entries that are fork specs.",
    );
  });

  it("is idempotent on a clean plain manifest with only the unpinned fork spec and the flag", () => {
    const src = `{\n  "command": "npx",\n  "args": ["${FLAG}", "-y", "${FORK}", "cognigy-mcp"]\n}\n`;
    const once = resolveManifestText("plugin/mcp.json", src);
    check(
      "clean text unchanged",
      "Resolving already-clean text (flag first, unpinned fork spec) is a no-op",
      src,
      once,
      "Do not modify text that has no markers, the unpinned fork spec and --allow-git=root already first.",
    );
    check(
      "second pass equals first",
      "Re-running resolution gives the same result",
      once,
      resolveManifestText("plugin/mcp.json", once),
      "Normalisation output must itself be a fixed point.",
    );
  });
});

describe("resolveManifestText: --allow-git=root in engine args arrays", () => {
  const ALIAS = aliasFor("1.23.0");
  const FLAG_GUIDANCE =
    "After normalising the engine spec, ensure the args array that holds it has --allow-git=root as its FIRST element exactly once, keeping the array's existing separators and indentation.";

  it("(a) inserts the flag once, before -y, when the array lacks it", () => {
    const out = resolveManifestText(
      "plugin/mcp.json",
      `{"args":["-y","-p","${ALIAS}","cognigy-mcp"]}`,
    );
    check(
      "flag inserted first",
      "Upstream's args array has no flag; the merge result must launch with --allow-git=root first",
      [FLAG, "-y", "-p", FORK, "cognigy-mcp"],
      JSON.parse(out).args,
      FLAG_GUIDANCE,
    );
  });

  it("(a2) inserts the flag when the array arrives through the theirs side of a hunk", () => {
    const src = `{\n${hunk(
      `  "args": ["${FLAG}", "-y", "-p", "${FORK}#v1.0.0", "cognigy-mcp"]`,
      `  "args": ["-y", "-p", "${ALIAS}", "cognigy-mcp"]`,
    )}}\n`;
    check(
      "flag inserted after hunk resolution",
      "The theirs side is chosen first, then the array is normalised including the flag; the single-line ', ' separator style is kept",
      `{\n  "args": ["${FLAG}", "-y", "-p", "${FORK}", "cognigy-mcp"]\n}\n`,
      resolveManifestText("plugin/mcp.json", src),
      FLAG_GUIDANCE,
    );
  });

  it("(b) does not double the flag when the array already has it", () => {
    const src = `{"args":["${FLAG}","-y","-p","${ALIAS}","cognigy-mcp"]}`;
    check(
      "flag not doubled",
      "An array that already starts with the flag keeps exactly one",
      `{"args":["${FLAG}","-y","-p","${FORK}","cognigy-mcp"]}`,
      resolveManifestText("plugin/mcp.json", src),
      FLAG_GUIDANCE,
    );
  });

  it("(b2) is idempotent: resolving the output again changes nothing", () => {
    const src = `{"args":["-y","-p","${ALIAS}","cognigy-mcp"]}`;
    const once = resolveManifestText("plugin/mcp.json", src);
    check(
      "second pass equals first",
      "Re-running the merge resolution must be a fixed point and never add a second flag",
      once,
      resolveManifestText("plugin/mcp.json", once),
      FLAG_GUIDANCE,
    );
    check(
      "exactly one flag after two passes",
      "The flag appears once in the args",
      1,
      JSON.parse(resolveManifestText("plugin/mcp.json", once)).args.filter(
        (a: string) => a === FLAG,
      ).length,
      FLAG_GUIDANCE,
    );
  });

  it("(c) keeps a multi-line array's indentation and inserts the flag once as the first element", () => {
    const src = `{\n  "args": [\n    "-y",\n    "-p",\n    "${ALIAS}",\n    "cognigy-mcp"\n  ]\n}\n`;
    check(
      "multi-line array",
      "The new first element sits on its own line at the same indent as its siblings",
      `{\n  "args": [\n    "${FLAG}",\n    "-y",\n    "-p",\n    "${FORK}",\n    "cognigy-mcp"\n  ]\n}\n`,
      resolveManifestText("plugin/mcp.json", src),
      FLAG_GUIDANCE,
    );
  });

  it("(c2) preserves CRLF line endings in a multi-line array", () => {
    const src = `{\r\n  "args": [\r\n    "-y",\r\n    "-p",\r\n    "${ALIAS}",\r\n    "cognigy-mcp"\r\n  ]\r\n}\r\n`;
    check(
      "multi-line array CRLF",
      "The inserted line uses the file's CRLF endings, not LF",
      `{\r\n  "args": [\r\n    "${FLAG}",\r\n    "-y",\r\n    "-p",\r\n    "${FORK}",\r\n    "cognigy-mcp"\r\n  ]\r\n}\r\n`,
      resolveManifestText("plugin/mcp.json", src),
      FLAG_GUIDANCE,
    );
  });

  it("(c3) a multi-line array that already has the flag is unchanged apart from the spec", () => {
    const src = `{\n  "args": [\n    "${FLAG}",\n    "-y",\n    "-p",\n    "${ALIAS}",\n    "cognigy-mcp"\n  ]\n}\n`;
    check(
      "multi-line array with flag",
      "No second flag line is added",
      `{\n  "args": [\n    "${FLAG}",\n    "-y",\n    "-p",\n    "${FORK}",\n    "cognigy-mcp"\n  ]\n}\n`,
      resolveManifestText("plugin/mcp.json", src),
      FLAG_GUIDANCE,
    );
  });

  it("(d) a resolved .json file with the inserted flag is valid JSON with the exact args", () => {
    const o = tryResolve(
      "plugin/.codex-plugin/mcp.json",
      `{\n  "mcpServers": {\n    "platform": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "-p",\n        "${ALIAS}",\n        "cognigy-mcp"\n      ]\n    }\n  }\n}\n`,
    );
    check(
      "json stays parseable",
      "Inserting the flag must not break JSON syntax (commas, quotes)",
      { ok: true, args: [FLAG, "-y", "-p", FORK, "cognigy-mcp"] },
      {
        ok: o.ok,
        args: o.ok
          ? JSON.parse(o.value as string).mcpServers.platform.args
          : null,
      },
      FLAG_GUIDANCE,
    );
  });

  it("(e) leaves an args array that does not contain the engine spec untouched", () => {
    const src = `{"args":["-y","some-other-package"]}`;
    check(
      "other server args untouched",
      "Only the engine's args array gets the flag",
      src,
      resolveManifestText("plugin/mcp.json", src),
      "Add the flag only to an args array that contains the fork engine spec.",
    );
  });

  it("(e2) in a file with two servers only the engine's array gains the flag", () => {
    const src = `{"mcpServers":{"other":{"args":["-y","some-other-package"]},"platform":{"args":["-y","-p","${ALIAS}","cognigy-mcp"]}}}`;
    check(
      "only the engine array changes",
      "A sibling server's args must not be modified",
      `{"mcpServers":{"other":{"args":["-y","some-other-package"]},"platform":{"args":["${FLAG}","-y","-p","${FORK}","cognigy-mcp"]}}}`,
      resolveManifestText("plugin/mcp.json", src),
      "Add the flag only to the array holding the fork engine spec.",
    );
  });

  it("(e3) leaves an array carrying Cognigy's own upstream github spec untouched", () => {
    const src = `{"args":["-y","-p","${UPSTREAM}#v1.0.0","cognigy-mcp"]}`;
    check(
      "upstream spec array untouched",
      "Only arrays with the fork engine spec are the fork's launch args",
      src,
      resolveManifestText("plugin/mcp.json", src),
      "Treat only the fork (and legacy fork / npm alias, which normalise to the fork) spec as the engine spec.",
    );
  });
});

describe("resolveManifestText: flag insertion is scoped to the engine launch array", () => {
  const SCOPE_GUIDANCE =
    'Only an array in which the element "-p" is immediately followed by the fork spec is the engine launch; insert --allow-git=root as its first element, and only there.';
  const resolve = (src: string) => resolveManifestText("plugin/mcp.json", src);

  it("(b) an array holding the spec with no -p before it is left unchanged", () => {
    const src = `{"sources":["${FORK}","x"]}`;
    check(
      "spec without -p",
      "An array that merely lists the fork spec is not an engine launch",
      src,
      resolve(src),
      SCOPE_GUIDANCE,
    );
  });

  it("(b2) a -p that is not immediately followed by the spec is not an engine launch", () => {
    const src = `{"args":["-y","-p","other","${FORK}","cognigy-mcp"]}`;
    check(
      "-p followed by something else",
      "The spec must directly follow -p",
      src,
      resolve(src),
      SCOPE_GUIDANCE,
    );
  });

  it("(c) a bracket inside a later string does not confuse the insertion point", () => {
    check(
      "bracket in trailing string",
      "Brackets inside JSON strings are not array delimiters",
      `["${FLAG}","-y","-p","${FORK}","cognigy-mcp","a]b"]`,
      resolve(`["-y","-p","${FORK}","cognigy-mcp","a]b"]`),
      SCOPE_GUIDANCE,
    );
  });

  it("(c2) a '[' inside an earlier string does not become the insertion point", () => {
    check(
      "bracket in leading string",
      "The flag goes at the start of the real array, not after a '[' inside a string",
      `["${FLAG}","-y","[x","-p","${FORK}","cognigy-mcp"]`,
      resolve(`["-y","[x","-p","${FORK}","cognigy-mcp"]`),
      SCOPE_GUIDANCE,
    );
  });

  it("(d) an engine array containing a nested array is never silently left without the flag", () => {
    const o = tryResolve(
      "plugin/mcp.json",
      `[["x"],"-y","-p","${FORK}","cognigy-mcp"]`,
    );
    check(
      "nested array refused",
      "A layout the resolver cannot handle must be reported, not skipped",
      { threw: true, phrases: [true, true] },
      refusal(o, "--allow-git", "args"),
      'Throw an Error mentioning "--allow-git" and "args" when the engine launch array cannot be located safely.',
    );
  });

  it("(e) the flag present but not first is refused", () => {
    const o = tryResolve(
      "plugin/mcp.json",
      `["-y","${FLAG}","-p","${FORK}","cognigy-mcp"]`,
    );
    check(
      "flag not first refused",
      "npm needs the flag first; a misplaced flag must not be silently accepted or duplicated",
      { threw: true, phrases: [true, true] },
      refusal(o, FLAG, "first"),
      `Throw an Error mentioning "${FLAG}" and "first" when the flag is present but not the first element.`,
    );
  });

  it("(f) the flag already first is unchanged", () => {
    const src = `["${FLAG}","-y","-p","${FORK}","cognigy-mcp"]`;
    check(
      "flag first idempotent",
      "A correct launch array is a fixed point",
      src,
      resolve(src),
      SCOPE_GUIDANCE,
    );
  });
});

describe("resolveManifestText: .claude-plugin/marketplace.json keeps OURS", () => {
  const MP = ".claude-plugin/marketplace.json";

  it("keeps the ours side of a hunk and drops theirs and markers", () => {
    const ours = `  "name": "cognigy-plugin-v2",`;
    const theirs = `  "name": "cognigy-plugin-pb",\n  "owner": "pb-crackers",`;
    const src = `{\n${hunk(ours, theirs)}  "plugins": []\n}\n`;
    const out = resolveManifestText(MP, src);
    check(
      "marketplace keeps ours",
      "The fork's marketplace identity must never be overwritten by upstream's",
      `{\n${ours}\n  "plugins": []\n}\n`,
      out,
      "For .claude-plugin/marketplace.json keep only the lines between <<<<<<< and =======.",
    );
    check(
      "no theirs identity leaks",
      "pb-crackers must not appear in the resolved marketplace",
      false,
      out.includes("pb-crackers"),
      "Discard the theirs side entirely for the marketplace file.",
    );
    check(
      "no legacy marketplace name leaks",
      "cognigy-plugin-pb must not appear in the resolved marketplace",
      false,
      out.includes("cognigy-plugin-pb"),
      "Discard the theirs side entirely for the marketplace file.",
    );
  });

  it("resolves two hunks to ours and preserves text between them", () => {
    const src = `a\n${hunk("o1", "t1")}b\n${hunk("o2", "t2")}c\n`;
    check(
      "marketplace two hunks",
      "Every marketplace hunk keeps ours",
      "a\no1\nb\no2\nc\n",
      resolveManifestText(MP, src),
      "Loop over all hunks; choose the ours side for each.",
    );
  });

  it("keeps ours with CRLF endings intact", () => {
    const src = `a\r\n${hunk("o1\r\no2", "t1", "\r\n")}b\r\n`;
    check(
      "marketplace CRLF",
      "CRLF hunks resolve to ours with CRLF preserved",
      "a\r\no1\r\no2\r\nb\r\n",
      resolveManifestText(MP, src),
      "Recognise \\r\\n markers; keep the ours lines verbatim.",
    );
  });
});

const MP_NAME = ".claude-plugin/marketplace.json";
const diff3 = (ours: string, base: string, theirs: string, nl = "\n") =>
  `<<<<<<< ours${nl}${ours}${nl}||||||| base${nl}${base}${nl}=======${nl}${theirs}${nl}>>>>>>> theirs${nl}`;

/** Summarise an Outcome for a refusal check: did it throw, and does the message have the phrases. */
const refusal = (o: Outcome, ...phrases: string[]) => ({
  threw: !o.ok,
  phrases: phrases.map((p) => (o.message ?? "").includes(p)),
});

describe("resolveManifestText: diff3 / zdiff3 markers", () => {
  const src = (nl: string) => `a${nl}${diff3("O", "B", "T", nl)}z${nl}`;

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])(
    "ordinary manifest keeps theirs and drops base and markers (%s)",
    (_l, nl) => {
      const out = resolveManifestText("plugin/mcp.json", src(nl));
      check(
        `diff3 theirs ${_l}`,
        "A diff3 hunk resolves to the theirs side only",
        `a${nl}T${nl}z${nl}`,
        out,
        "Recognise the optional ||||||| base section between ours and =======; discard it and ours, keep theirs.",
      );
      check(
        `diff3 leaves no base or marker ${_l}`,
        "Neither the base text nor any marker line may survive",
        { base: false, markers: false },
        {
          base: /(^|\n)B(\r?\n|$)/.test(out),
          markers: /(^|\n)(<{7}|\|{7}|={7}|>{7})/.test(out),
        },
        "Drop the ||||||| line, the base lines, and every marker line.",
      );
    },
  );

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("marketplace keeps ours for a diff3 hunk (%s)", (_l, nl) => {
    const out = resolveManifestText(MP_NAME, src(nl));
    check(
      `diff3 ours ${_l}`,
      "For marketplace.json a diff3 hunk resolves to ours only",
      `a${nl}O${nl}z${nl}`,
      out,
      "Keep the lines between <<<<<<< and ||||||| (or =======); discard base and theirs.",
    );
    check(
      `diff3 marketplace no base/marker ${_l}`,
      "Base text and markers never appear",
      { base: false, theirs: false, markers: false },
      {
        base: /(^|\n)B(\r?\n|$)/.test(out),
        theirs: /(^|\n)T(\r?\n|$)/.test(out),
        markers: /(^|\n)(<{7}|\|{7}|={7}|>{7})/.test(out),
      },
      "Drop the base section, theirs, and every marker line.",
    );
  });

  it("a multi-line base section is dropped in full", () => {
    check(
      "multi-line base",
      "Every base line is discarded, not just the first",
      "T1\nT2\n",
      resolveManifestText(
        "plugin/mcp.json",
        "<<<<<<< ours\nO1\nO2\n||||||| base\nB1\nB2\nB3\n=======\nT1\nT2\n>>>>>>> theirs\n",
      ),
      "Skip all lines from the ||||||| marker up to the ======= marker.",
    );
  });
});

describe("resolveManifestText: leftover markers are refused", () => {
  it.each([
    ["unterminated hunk", "x\n<<<<<<< ours\nO\n=======\nT\n"],
    [
      "unterminated diff3 hunk",
      "x\n<<<<<<< ours\nO\n||||||| base\nB\n=======\nT\n",
    ],
    ["start with no separator or end", "x\n<<<<<<< ours\nO\n"],
    ["stray separator", "x\n=======\ny\n"],
    ["stray end marker", "x\n>>>>>>> theirs\ny\n"],
    ["stray base marker", "x\n||||||| base\ny\n"],
    [
      "stray end marker after a complete hunk",
      `${hunk("o", "t")}>>>>>>> theirs\n`,
    ],
  ])("%s throws an error mentioning 'conflict marker'", (name, text) => {
    for (const file of ["plugin/mcp.json", MP_NAME]) {
      const o = tryResolve(file, text);
      check(
        `${name} (${file})`,
        "Text that still contains conflict markers must never be returned",
        { threw: true, phrases: [true], returned: null },
        { ...refusal(o, "conflict marker"), returned: o.ok ? o.value : null },
        'After resolving complete hunks, scan for leftover marker lines and throw new Error("... conflict marker ...").',
      );
    }
  });

  it("a complete hunk alone is not refused", () => {
    const o = tryResolve("plugin/mcp.json", hunk("o", "t"));
    check(
      "complete hunk accepted",
      "Well-formed hunks resolve rather than throw",
      { ok: true, value: "t\n" },
      { ok: o.ok, value: o.value },
      "Only leftover or unterminated markers are refused.",
    );
  });
});

describe("resolveManifestText: JSON validity of .json files", () => {
  it("throws 'not valid JSON' naming the file when the resolved .json text does not parse", () => {
    const o = tryResolve("plugin/mcp.json", "{ not json");
    check(
      "invalid json refused",
      "A resolved .json file that does not parse must be refused",
      { threw: true, phrases: [true, true] },
      refusal(o, "not valid JSON", "plugin/mcp.json"),
      "After resolving, JSON.parse the text for names ending in .json; on failure throw an Error containing 'not valid JSON' and the file name.",
    );
  });

  it("refuses JSON that only becomes invalid after the theirs side is chosen", () => {
    const o = tryResolve(
      "plugin/plugin.json",
      `{\n${hunk('"a": 1', '"a": 1,')}}\n`,
    );
    check(
      "invalid after resolution",
      "Validity is judged on the resolved text, not the raw input",
      { threw: true, phrases: [true, true] },
      refusal(o, "not valid JSON", "plugin/plugin.json"),
      "Parse the output of hunk resolution and normalisation.",
    );
  });

  it("valid JSON passes and is returned unchanged", () => {
    const text = `{\n  "a": [1, 2],\n  "b": "x"\n}\n`;
    const o = tryResolve("plugin/mcp.json", text);
    check(
      "valid json passes",
      "Valid JSON is returned as-is",
      { ok: true, value: text },
      { ok: o.ok, value: o.value },
      "Do not throw when JSON.parse succeeds.",
    );
  });

  it("valid JSON produced by resolving a hunk passes", () => {
    const o = tryResolve(
      "plugin/mcp.json",
      `{\n${hunk('"a": 1', '"a": 2')}}\n`,
    );
    check(
      "valid after resolution",
      "A resolution that yields valid JSON passes",
      { ok: true, value: `{\n"a": 2\n}\n` },
      { ok: o.ok, value: o.value },
      "Validate after resolving, not before.",
    );
  });

  it("non-.json names are not JSON-checked", () => {
    const o = tryResolve("README.md", "{ not json");
    check(
      "non-json file unchecked",
      "Only names ending in .json are JSON-validated",
      { ok: true, value: "{ not json" },
      { ok: o.ok, value: o.value },
      "Gate the JSON.parse on file name ending with .json.",
    );
  });

  it("a name that merely contains 'json' but does not end in .json is not checked", () => {
    const o = tryResolve("notes.json.txt", "{ not json");
    check(
      "json in the middle",
      "The check applies to the .json suffix only",
      { ok: true, value: "{ not json" },
      { ok: o.ok, value: o.value },
      "Use an end-of-name test, not a substring test.",
    );
  });
});

describe("resolveManifestText: Windows-style paths", () => {
  it("a backslash marketplace path keeps OURS like the forward-slash name", () => {
    const text = `a\n${hunk("OURS", "THEIRS")}z\n`;
    check(
      "backslash marketplace",
      "Path separators must not decide which side wins",
      "a\nOURS\nz\n",
      resolveManifestText(".claude-plugin\\marketplace.json", text),
      "Normalise backslashes to slashes before comparing the file name with .claude-plugin/marketplace.json.",
    );
  });

  it("a backslash path to another file still keeps THEIRS", () => {
    const text = `a\n${hunk("OURS", "THEIRS")}z\n`;
    check(
      "backslash ordinary",
      "Only the marketplace file keeps ours",
      "a\nTHEIRS\nz\n",
      resolveManifestText("plugin\\.claude-plugin\\plugin.json", text),
      "Match the marketplace path exactly after separator normalisation, not by suffix of another directory.",
    );
  });
});

describe("countHunks", () => {
  it.each([
    ["clean text", "just\ntext\n", 0],
    ["empty text", "", 0],
    ["one hunk", `a\n${hunk("o", "t")}b\n`, 1],
    ["two hunks", `${hunk("o1", "t1")}m\n${hunk("o2", "t2")}`, 2],
    ["three hunks", `${hunk("1", "1")}${hunk("2", "2")}${hunk("3", "3")}`, 3],
    ["one diff3 hunk counts once", diff3("o", "b", "t"), 1],
    ["diff3 and plain hunk", `${diff3("o", "b", "t")}${hunk("o", "t")}`, 2],
    ["CRLF hunk", hunk("o", "t", "\r\n"), 1],
    ["unterminated start does not count", "<<<<<<< ours\nO\n=======\nT\n", 0],
    [
      "complete hunk plus an unterminated start",
      `${hunk("o", "t")}<<<<<<< ours\nO\n`,
      1,
    ],
  ])("%s", (name, text, expected) => {
    check(
      `countHunks ${name}`,
      "countHunks returns the number of complete conflict hunks",
      expected,
      countHunks(text),
      "Count each <<<<<<< ... ======= ... >>>>>>> block once (a ||||||| base section is part of its hunk); ignore unterminated starts.",
    );
  });
});
