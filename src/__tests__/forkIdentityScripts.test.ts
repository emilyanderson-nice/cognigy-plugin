import { describe, it, expect } from "@jest/globals";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { pathToFileURL } from "url";

const SCRIPT_PATH = join(process.cwd(), "scripts", "fork-identity.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT_PATH).href;

const FORK = "github:emilyanderson-nice/cognigy-plugin";
const OLD = "github:pb-crackers/cognigy-plugin";
const UPSTREAM = "github:Cognigy/cognigy-plugin";

const pkgVersion: string = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version;

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
): void {
  try {
    expect(actual).toBe(expected);
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

/**
 * Evaluate a JS expression (over module namespace `m`) inside a child node
 * process that imports scripts/fork-identity.mjs, and return its JSON result.
 * TypeScript never imports the .mjs file.
 */
function evalInScript(expression: string): unknown {
  const code = `import(${JSON.stringify(SCRIPT_URL)}).then(m=>console.log(JSON.stringify(${expression})))`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      [
        "1. WHAT FAILED: loading/evaluating scripts/fork-identity.mjs in a child node process",
        "2. REQUIREMENT VIOLATED: scripts/fork-identity.mjs must be an importable ES module exporting the fork identity API",
        `3. EXPECTED: exit status 0 for expression ${expression}`,
        `4. ACTUAL: status ${r.status}; stderr first line: ${(r.stderr ?? "").split("\n")[0]}`,
        "5. GUIDANCE: Create scripts/fork-identity.mjs exporting FORK_REPO, FORK_MARKETPLACE_NAME, UPSTREAM_REPO, enginePin and replaceEnginePin.",
      ].join("\n"),
    );
  }
  return JSON.parse(r.stdout.trim());
}

function replace(text: string, version: string): unknown {
  return evalInScript(
    `m.replaceEnginePin(${JSON.stringify(text)}, ${JSON.stringify(version)})`,
  );
}

describe("scripts/fork-identity.mjs", () => {
  it("the module file exists at scripts/fork-identity.mjs", () => {
    check(
      "scripts/fork-identity.mjs exists",
      "Release/sync scripts share one fork-identity module",
      true,
      existsSync(SCRIPT_PATH),
      "Create scripts/fork-identity.mjs as a plain ES module.",
    );
  });

  it("FORK_REPO is the fork's owner/repo", () => {
    check(
      "FORK_REPO",
      "Scripts must point at the fork repository",
      "emilyanderson-nice/cognigy-plugin",
      evalInScript("m.FORK_REPO"),
      "Export FORK_REPO = 'emilyanderson-nice/cognigy-plugin'.",
    );
  });

  it("FORK_MARKETPLACE_NAME is cognigy-plugin-v2", () => {
    check(
      "FORK_MARKETPLACE_NAME",
      "The fork's marketplace name must differ from upstream's",
      "cognigy-plugin-v2",
      evalInScript("m.FORK_MARKETPLACE_NAME"),
      "Export FORK_MARKETPLACE_NAME = 'cognigy-plugin-v2'.",
    );
  });

  it("UPSTREAM_REPO is Cognigy/cognigy-plugin", () => {
    check(
      "UPSTREAM_REPO",
      "Upstream slug must be recorded distinct from the fork's",
      "Cognigy/cognigy-plugin",
      evalInScript("m.UPSTREAM_REPO"),
      "Export UPSTREAM_REPO = 'Cognigy/cognigy-plugin'.",
    );
  });

  it.each(["1.22.0-pb.1", "1.23.0-pb.2"])(
    "enginePin(%s) is the fork github spec pinned to that tag",
    (version) => {
      check(
        `enginePin(${version})`,
        "The engine pin must be derived from the given version, not hard-coded",
        `${FORK}#v${version}`,
        evalInScript(`m.enginePin(${JSON.stringify(version)})`),
        "Return `github:${FORK_REPO}#v${version}`.",
      );
    },
  );

  it("enginePin(package.json version) matches the fork spec for the repo's version", () => {
    check(
      "enginePin(package.json version)",
      "The pin written by release scripts must track package.json's version",
      `github:emilyanderson-nice/cognigy-plugin#v${pkgVersion}`,
      evalInScript(`m.enginePin(${JSON.stringify(pkgVersion)})`),
      "Return `github:${FORK_REPO}#v${version}`.",
    );
  });

  describe("replaceEnginePin", () => {
    it("pins an unpinned fork spec", () => {
      check(
        "replaceEnginePin unpinned fork spec",
        "An unpinned fork spec gains the version pin",
        `"${FORK}#v1.23.0-pb.2"`,
        replace(`"${FORK}"`, "1.23.0-pb.2"),
        "Match the fork spec with an optional '#v...' suffix and substitute enginePin(version).",
      );
    });

    it("repins a spec pinned to another version, including dotted/hyphenated suffixes", () => {
      check(
        "replaceEnginePin other version (#v0.0.1)",
        "A stale pin is replaced, not appended to",
        `"${FORK}#v1.23.0-pb.2"`,
        replace(`"${FORK}#v0.0.1"`, "1.23.0-pb.2"),
        "Consume everything after '#v' up to a double quote or whitespace.",
      );
      check(
        "replaceEnginePin other version with prerelease (#v0.0.1-pb.9)",
        "The whole old tag, punctuation included, is consumed",
        `"${FORK}#v1.22.0-pb.1"`,
        replace(`"${FORK}#v0.0.1-pb.9"`, "1.22.0-pb.1"),
        "Consume '.', '-' and alphanumerics after '#v' up to a quote or whitespace.",
      );
    });

    it("rewrites the old pb-crackers spec to the fork spec", () => {
      check(
        "replaceEnginePin pb-crackers spec",
        "Legacy pb-crackers pins migrate to the fork",
        `"${FORK}#v1.22.0-pb.1"`,
        replace(`"${OLD}#v1.20.0"`, "1.22.0-pb.1"),
        "Treat github:pb-crackers/cognigy-plugin like the fork spec when matching.",
      );
      check(
        "replaceEnginePin unpinned pb-crackers spec",
        "Legacy pb-crackers spec without a pin also migrates",
        `"${FORK}#v1.22.0-pb.1"`,
        replace(`"${OLD}"`, "1.22.0-pb.1"),
        "The '#v...' suffix is optional for the pb-crackers spec too.",
      );
    });

    it("replaces EVERY occurrence, not just the first", () => {
      const input = `{"a":"${FORK}#v0.0.1","b":"${OLD}","c":"x ${FORK}#v9"}`;
      const expected = `{"a":"${FORK}#v1.23.0-pb.2","b":"${FORK}#v1.23.0-pb.2","c":"x ${FORK}#v1.23.0-pb.2"}`;
      check(
        "replaceEnginePin multiple occurrences",
        "Every pin in a file must move together",
        expected,
        replace(input, "1.23.0-pb.2"),
        "Use a global replace and do not let '#v...' consume past a double quote.",
      );
    });

    it("stops the old pin at whitespace and preserves everything around it byte-for-byte", () => {
      const input = `{\r\n\t"args": [ "-y", "${FORK}#v0.0.1" ,\t"--flag" ],\n  "spec": "${OLD}#v1.0.0-pb.3"  \r\n}\n`;
      const expected = `{\r\n\t"args": [ "-y", "${FORK}#v1.22.0-pb.1" ,\t"--flag" ],\n  "spec": "${FORK}#v1.22.0-pb.1"  \r\n}\n`;
      check(
        "replaceEnginePin preserves surrounding bytes",
        "Only the spec token changes; whitespace, CRLF and punctuation survive",
        expected,
        replace(input, "1.22.0-pb.1"),
        "Match [^\"\\s]* after '#v' so quotes and whitespace are never consumed.",
      );
    });

    it("stops the old pin at whitespace in unquoted text", () => {
      check(
        "replaceEnginePin unquoted spec ends at whitespace",
        "Whitespace terminates the old pin just like a double quote",
        `npx ${FORK}#v2.0.0 --yes tail`,
        replace(`npx ${FORK}#v0.0.1 --yes tail`, "2.0.0"),
        "Terminate the matched suffix at whitespace as well as at a double quote.",
      );
    });

    it.each([
      `${FORK}-extra#v1`,
      "github:pb-crackers/cognigy-plugin2",
      `${FORK}_old`,
    ])("leaves the longer repo name %s unchanged", (spec) => {
      const input = `{"a":"${spec}"}`;
      check(
        `replaceEnginePin look-alike ${spec}`,
        "The pattern must not match a longer repository name",
        input,
        replace(input, "9.9.9"),
        "Only match the exact repo name; a following name character means a different repository.",
      );
    });

    it("fully replaces a tag with prerelease and build metadata", () => {
      check(
        "replaceEnginePin tag with build metadata",
        "Nothing of the old tag survives, '+' build metadata included",
        `"${FORK}#v1.22.0-pb.1"`,
        replace(`"${FORK}#v1.2.3-pb.4+build.5"`, "1.22.0-pb.1"),
        "Consume everything after '#v' up to a double quote or whitespace, including '+'.",
      );
    });

    it("is idempotent: applying twice equals applying once", () => {
      const input = `{"a":"${FORK}#v0.0.1","b":"${OLD}","c":"${FORK}"}`;
      const once = replace(input, "1.23.0-pb.2") as string;
      check(
        "replaceEnginePin idempotent",
        "Re-running a release sync must not change the result",
        once,
        replace(once, "1.23.0-pb.2"),
        "The replacement output must itself match the pattern and map to the same string.",
      );
      check(
        "replaceEnginePin idempotent content",
        "The once-applied result is the exact expected text",
        `{"a":"${FORK}#v1.23.0-pb.2","b":"${FORK}#v1.23.0-pb.2","c":"${FORK}#v1.23.0-pb.2"}`,
        once,
        "Substitute enginePin(version) for each match.",
      );
    });

    it("returns text without an occurrence unchanged (incl. upstream spec and look-alikes)", () => {
      const input = `{"a":"${UPSTREAM}#v1.0.0","b":"github:emilyanderson-nice/other#v1","c":"plain text","d":"emilyanderson-nice/cognigy-plugin"}`;
      check(
        "replaceEnginePin no occurrence",
        "Only fork/pb-crackers github: specs are rewritten; upstream and look-alikes are not",
        input,
        replace(input, "9.9.9"),
        "Match only github:emilyanderson-nice/cognigy-plugin and github:pb-crackers/cognigy-plugin.",
      );
      check(
        "replaceEnginePin empty string",
        "Empty input stays empty",
        "",
        replace("", "9.9.9"),
        "Do not add content when nothing matches.",
      );
    });
  });
});
