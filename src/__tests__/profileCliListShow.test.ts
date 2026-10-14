import { describe, it } from "@jest/globals";
import {
  KEY,
  makeHarness,
  mkProfile,
  mkSet,
} from "./helpers/profileCliHarness.js";
import {
  mustContain,
  mustNotContain,
  runExpect,
} from "./helpers/profileCliAsserts.js";
import { eq, ok } from "./helpers/specAssert.js";

const DEV = mkProfile("dev", "file-profile", {
  versionHint: "2026.21",
  endpointBaseUrl: "https://endpoint-dev.cognigy.ai/v1/private-path",
});
const STG = mkProfile("stg", "env-profile");
const OLD = mkProfile("old", "legacy-file");
const SET = mkSet([DEV, OLD, STG], "dev", [
  { name: "broken", reason: "missing API key" },
]);

function lineWith(text: string, needle: string): string {
  const line = text.split(/\r?\n/).find((l) => l.includes(needle));
  return line ?? "";
}

describe("profile list (spec 2)", () => {
  it("human output: one line per profile with host, source, default marker, hint, editability", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["list"],
      0,
      "profile list exits 0",
      "Spec 2",
      "Succeed",
    );
    const text = h.outText();
    const dev = lineWith(text, "api-dev.cognigy.ai");
    const stg = lineWith(text, "api-stg.cognigy.ai");
    const old = lineWith(text, "api-old.cognigy.ai");
    mustContain(
      dev,
      ["dev", "api-dev.cognigy.ai", "file-profile", "2026.21"],
      "profile list line for dev",
      "Spec 2: name, API host, source, versionHint on one line",
      "Print every field on the profile's line",
    );
    mustContain(
      stg,
      ["stg", "api-stg.cognigy.ai", "env-profile"],
      "profile list line for stg",
      "Spec 2",
      "Print name, host, source",
    );
    ok(
      /default/i.test(dev) && !/default/i.test(stg) && !/default/i.test(old),
      "profile list default marker",
      "Spec 2: a marker for the default profile only",
      "marker only on dev's line",
      JSON.stringify({ dev, stg, old }),
      "Mark exactly the default profile",
    );
    const strip = (s: string): string => s.replace(/not\s+editable/gi, "");
    ok(
      /editable/i.test(strip(dev)) &&
        !/editable/i.test(strip(stg)) &&
        !/editable/i.test(strip(old)),
      "profile list editability",
      "Spec 2: only file-profile is editable here",
      "dev editable; stg and old not",
      JSON.stringify({ dev, stg, old }),
      "Show editability per profile",
    );
    mustContain(
      text,
      ["Problems:", "broken: missing API key"],
      "profile list problems section",
      "Spec 2: `Problems:` then `<name>: <reason>`",
      "List each problem",
    );
    mustNotContain(
      text,
      ["https://", "private-path"],
      "profile list shows hostnames only",
      "Spec 2: never full URLs",
      "Print hostnames only",
    );
  });

  it("human output without problems has no Problems section", async () => {
    const h = makeHarness({ set: mkSet([DEV], "dev") });
    await runExpect(
      h,
      ["list"],
      0,
      "profile list exits 0",
      "Spec 2",
      "Succeed",
    );
    mustNotContain(
      h.outText(),
      ["Problems:"],
      "profile list without problems",
      "Spec 2: Problems only when set.problems is non-empty",
      "Omit the section",
    );
  });

  it("empty set: says nothing is configured and how to add one, exit 0", async () => {
    const h = makeHarness({ set: mkSet([]) });
    await runExpect(
      h,
      ["list"],
      0,
      "empty profile list exits 0",
      "Spec 2",
      "Succeed",
    );
    mustContain(
      h.outText(),
      ["no environments", "cognigy-setup profile add"],
      "empty profile list message",
      "Spec 2",
      "Explain how to add an environment",
      true,
    );
  });

  it("--json: one document with exact shape, hosts only", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["list", "--json"],
      0,
      "profile list --json exits 0",
      "Spec 2",
      "Succeed",
    );
    let doc: unknown;
    try {
      doc = JSON.parse(h.outText());
    } catch {
      doc = "NOT JSON";
    }
    eq(
      doc,
      {
        default: "dev",
        profiles: [
          {
            name: "dev",
            apiHost: "api-dev.cognigy.ai",
            endpointHost: "endpoint-dev.cognigy.ai",
            source: "file-profile",
            versionHint: "2026.21",
            isDefault: true,
            editable: true,
          },
          {
            name: "old",
            apiHost: "api-old.cognigy.ai",
            endpointHost: "endpoint-old.cognigy.ai",
            source: "legacy-file",
            isDefault: false,
            editable: false,
          },
          {
            name: "stg",
            apiHost: "api-stg.cognigy.ai",
            endpointHost: "endpoint-stg.cognigy.ai",
            source: "env-profile",
            isDefault: false,
            editable: false,
          },
        ],
        problems: [{ name: "broken", reason: "missing API key" }],
      },
      "profile list --json document",
      "Spec 2: { default, profiles[{name,apiHost,endpointHost,source,versionHint?,isDefault,editable}], problems }",
      "Emit exactly the specified JSON (hosts only, no keys)",
    );
    mustNotContain(
      h.outText(),
      ["https://", "private-path", "apiKey"],
      "profile list --json hides urls and keys",
      "Spec 2",
      "Only hostnames",
    );
  });

  it("--json with no default and no profiles: default null, empty arrays", async () => {
    const h = makeHarness({ set: mkSet([]) });
    await runExpect(
      h,
      ["list", "--json"],
      0,
      "empty list --json exits 0",
      "Spec 2",
      "Succeed",
    );
    eq(
      JSON.parse(h.outText()),
      { default: null, profiles: [], problems: [] },
      "empty profile list --json",
      "Spec 2: default is string|null",
      "Use null when no default",
    );
  });
});

describe("profile show (spec 3)", () => {
  it("prints identity, hosts only, version hint and key length only", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["show", "DEV"],
      0,
      "profile show DEV exits 0",
      "Spec 3: name is normalised",
      "Succeed",
    );
    const t = h.outText();
    mustContain(
      t,
      [
        "dev",
        "file-profile",
        "api-dev.cognigy.ai",
        "endpoint-dev.cognigy.ai",
        "webchat-dev.cognigy.ai",
        "static-dev.cognigy.ai",
        "2026.21",
        `API key: set (${KEY.length} characters)`,
      ],
      "profile show dev output",
      "Spec 3: all listed fields; key length only",
      "Print each field",
    );
    ok(
      /default/i.test(t),
      "profile show default marker",
      "Spec 3: default marker for the default profile",
      "text mentioning default",
      JSON.stringify(t),
      "Mark default",
    );
    mustNotContain(
      t,
      ["https://", "private-path"],
      "profile show hostnames only",
      "Spec 3",
      "No full URLs",
    );
  });

  it("non-default profile has no default marker", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["show", "stg"],
      0,
      "profile show stg exits 0",
      "Spec 3",
      "Succeed",
    );
    ok(
      !/default/i.test(h.outText()),
      "profile show non-default marker",
      "Spec 3: marker only for the default",
      "no 'default' text",
      JSON.stringify(h.outText()),
      "Omit the marker",
    );
  });

  it("unknown name exits 1 listing available names", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["show", "nope"],
      1,
      "profile show nope exits 1",
      "Spec 3",
      "Fail",
    );
    mustContain(
      h.errText(),
      ["dev", "old", "stg"],
      "profile show unknown message",
      "Spec 3: lists available names",
      "List the known environment names",
    );
  });
});
