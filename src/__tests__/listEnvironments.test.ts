import { describe, it, jest } from "@jest/globals";
import {
  LIST_ENVIRONMENTS_TOOL,
  createListEnvironments,
} from "../environments/listEnvironments.js";
import {
  createEnvironmentRegistry,
  type EnvironmentRuntime,
} from "../environments/registry.js";
import { loadProfiles, type Profile } from "../profiles/profiles.js";
import { parseRelease, type ReleaseInfo } from "../profiles/release.js";
import {
  KEY_A,
  KEY_B,
  KEY_BROKEN,
  broken,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

const KEY_F = "fake-key-FFFF-distinct-5";
const ALL = [KEY_A, KEY_B, KEY_F, KEY_BROKEN];

function registryFor(
  env: Record<string, string>,
  withFile = true,
  load?: () => never,
) {
  const set = loadProfiles({
    env,
    ...(withFile
      ? {
          fileProfiles: {
            profiles: {
              f: {
                apiBaseUrl: "https://api-f.cognigy.ai",
                apiKey: KEY_F,
                endpointBaseUrl: "https://endpoint-f.cognigy.ai",
                versionHint: "v4",
              },
            },
            problems: [],
          },
        }
      : {}),
  });
  return createEnvironmentRegistry({
    loadProfiles: load ?? (() => set),
    createRuntime: (profile: Profile): EnvironmentRuntime => ({
      profile,
      client: {},
      handlers: { handleToolCall: async () => ({}) },
    }),
  });
}
const detected = (raw: string): ReleaseInfo => ({
  release: parseRelease(raw),
  source: "openapi",
});
const BASE_ENV = {
  ...usable("A", KEY_A),
  ...broken("Z"),
  COGNIGY_PROFILE: "a",
};

describe("LIST_ENVIRONMENTS_TOOL definition", () => {
  it("L-def: name, description, check boolean, additionalProperties false, readOnlyHint, no required", () => {
    const t = LIST_ENVIRONMENTS_TOOL;
    const props = t.inputSchema.properties as Record<string, { type: string }>;
    ok(
      t.name === "list_environments" &&
        t.description.length > 0 &&
        props.check.type === "boolean" &&
        Object.keys(props).join() === "check" &&
        t.inputSchema.additionalProperties === false &&
        t.annotations.readOnlyHint === true &&
        !("required" in t.inputSchema),
      "list_environments definition",
      "B: tool definition contract",
      "name list_environments, non-empty description, only a boolean check property, additionalProperties false, readOnlyHint true, no required",
      JSON.stringify(t),
      "Declare the definition exactly as specified.",
    );
  });
});

describe("createListEnvironments without check", () => {
  it("B1: exact output; detectRelease is never called; no release fields", async () => {
    const reg = registryFor(BASE_ENV);
    const detect = jest.fn<(p: Profile) => Promise<ReleaseInfo>>();
    const out = await createListEnvironments({
      registry: reg,
      detectRelease: detect,
    })({});
    eq(
      out,
      {
        environments: [
          {
            name: "a",
            apiHost: "api-a.cognigy.ai",
            endpointHost: "endpoint-a.cognigy.ai",
            source: "env-profile",
            editable: false,
            isDefault: true,
          },
          {
            name: "f",
            apiHost: "api-f.cognigy.ai",
            endpointHost: "endpoint-f.cognigy.ai",
            source: "file-profile",
            editable: true,
            isDefault: false,
            versionHint: "v4",
          },
        ],
        problems: reg.snapshot().problems,
        default: "a",
        configured: 3,
        environmentArgumentRequired: true,
      },
      "list_environments output",
      "B1: usable profiles sorted by name, problems, default, configured, environmentArgumentRequired",
      "Report usable environments sorted by name with host-only details.",
    );
    eq(
      reg.snapshot().problems.map((p) => p.name),
      ["z"],
      "fixture sanity",
      "B1: one broken profile",
      "n/a",
    );
    eq(
      detect.mock.calls.length,
      0,
      "release probing",
      "B1: no probing without check",
      "Only probe when check is true.",
    );
  });

  it.each([[false], ["true"], [1], [null], [undefined]])(
    "B1: check=%j (not boolean true) does not probe",
    async (check) => {
      const detect = jest.fn<(p: Profile) => Promise<ReleaseInfo>>();
      const out = await createListEnvironments({
        registry: registryFor(BASE_ENV),
        detectRelease: detect,
      })({ check });
      eq(
        [detect.mock.calls.length, JSON.stringify(out).includes("release")],
        [0, false],
        "non-true check",
        "B1: only boolean true triggers probing",
        "Treat anything but true as no check.",
      );
    },
  );

  it("B2: default mirrors the registry (null when none) and isDefault follows it", async () => {
    const reg = registryFor(
      { ...usable("A", KEY_A), ...usable("B", KEY_B) },
      false,
    );
    const out = await createListEnvironments({
      registry: reg,
      detectRelease: jest.fn<(p: Profile) => Promise<ReleaseInfo>>(),
    })({});
    const envs = out.environments as Array<Record<string, unknown>>;
    const def = reg.snapshot().defaultName ?? null;
    eq(
      [out.default, envs.map((e) => e.isDefault)],
      [def, envs.map((e) => e.name === def)],
      "default flags",
      "B2: default and isDefault mirror the registry default",
      "Report the registry default (null when none) and flag only that environment.",
    );
  });

  it("B2b: one configured environment does not require the argument", async () => {
    const out = await createListEnvironments({
      registry: registryFor(usable("A", KEY_A), false),
      detectRelease: jest.fn<(p: Profile) => Promise<ReleaseInfo>>(),
    })({});
    eq(
      [out.configured, out.environmentArgumentRequired],
      [1, false],
      "single environment output",
      "B2: environmentArgumentRequired is configured >= 2",
      "Require the argument only with two or more configured environments.",
    );
  });

  it("B3: nothing configured gives empty lists, configured 0, no argument required", async () => {
    const out = await createListEnvironments({
      registry: registryFor({}, false),
      detectRelease: jest.fn<(p: Profile) => Promise<ReleaseInfo>>(),
    })({});
    eq(
      out,
      {
        environments: [],
        problems: [],
        default: null,
        configured: 0,
        environmentArgumentRequired: false,
      },
      "empty output",
      "B3: exact empty shape",
      "Return empty lists and null default.",
    );
  });

  it("B4: a configuration load failure is reported as loadError", async () => {
    const reg = registryFor({}, false, () => {
      throw new Error("config unreadable");
    });
    const out = await createListEnvironments({
      registry: reg,
      detectRelease: jest.fn<(p: Profile) => Promise<ReleaseInfo>>(),
    })({});
    eq(
      [out.loadError, out.environments, out.configured],
      [reg.snapshot().loadError, [], 0],
      "loadError output",
      "B4: loadError carried from the registry snapshot",
      "Surface the load failure text.",
    );
    ok(
      typeof out.loadError === "string" &&
        out.loadError.includes("config unreadable"),
      "loadError content",
      "B4: loadError text present",
      "text including the failure message",
      String(out.loadError),
      "Include the load error.",
    );
  });

  it("B5: never emits an API key or full URL", async () => {
    const out = await createListEnvironments({
      registry: registryFor(BASE_ENV),
      detectRelease: jest.fn<(p: Profile) => Promise<ReleaseInfo>>(async () =>
        detected("2026.21.0"),
      ),
    })({ check: true });
    const text = JSON.stringify(out);
    for (const k of ALL)
      ok(
        !text.includes(k),
        "key in output",
        "B5: no API key",
        "no key text",
        `contains ${k.slice(0, 13)}...`,
        "Never output keys.",
      );
    ok(
      !text.includes("://"),
      "URL in output",
      "B5: hosts only, no full URL",
      "no scheme",
      text,
      "Report hosts, not URLs.",
    );
  });
});

describe("createListEnvironments with check: true", () => {
  const two = { ...usable("A", KEY_A), ...usable("B", KEY_B) };

  it("B6: detected releases carry raw text and status 'detected'; unknown carries status only", async () => {
    const detect = jest.fn<(p: Profile) => Promise<ReleaseInfo>>(async (p) =>
      p.name === "a"
        ? detected("2026.21.0")
        : { source: "unknown", error: "http 500 secret-detail" },
    );
    const out = await createListEnvironments({
      registry: registryFor(two, false),
      detectRelease: detect,
    })({ check: true });
    const [a, b] = out.environments as Array<Record<string, unknown>>;
    eq(
      [a.release, a.releaseStatus, b.releaseStatus, "release" in b],
      ["2026.21.0", "detected", "unknown", false],
      "release statuses",
      "B6: detected sets release+status, unknown sets status only",
      "Map each ReleaseInfo to release/releaseStatus fields.",
    );
    ok(
      !JSON.stringify(out).includes("secret-detail"),
      "unknown detail leak",
      "B6: detector error text not exposed",
      "no error text in output",
      JSON.stringify(out),
      "Do not surface detector error messages.",
    );
    eq(
      detect.mock.calls.map((c) => c[0].name).sort(),
      ["a", "b"],
      "probed profiles",
      "B6: every usable profile probed exactly once",
      "Probe each usable profile once.",
    );
  });

  it("B7: probes run in parallel (both started before either finishes)", async () => {
    const started: string[] = [];
    const resolvers: Array<(i: ReleaseInfo) => void> = [];
    const detect = jest.fn<(p: Profile) => Promise<ReleaseInfo>>(
      (p) =>
        new Promise((res) => {
          started.push(p.name);
          resolvers.push(res);
        }),
    );
    const pending = createListEnvironments({
      registry: registryFor(two, false),
      detectRelease: detect,
    })({ check: true });
    await new Promise((r) => setTimeout(r, 0));
    eq(
      started.sort(),
      ["a", "b"],
      "parallel probing",
      "B7: both probes in flight before either resolves",
      "Start all probes concurrently.",
    );
    resolvers.forEach((r) => r(detected("2026.1.0")));
    const out = await pending;
    eq(
      (out.environments as Array<Record<string, unknown>>).map(
        (e) => e.release,
      ),
      ["2026.1.0", "2026.1.0"],
      "parallel results",
      "B7: results collected",
      "Wait for all probes.",
    );
  });

  it("B8: a slow probe times out without waiting and does not affect others", async () => {
    const detect = jest.fn<(p: Profile) => Promise<ReleaseInfo>>((p) =>
      p.name === "a"
        ? new Promise<ReleaseInfo>(() => {})
        : Promise.resolve(detected("2026.9.2")),
    );
    const t0 = Date.now();
    const out = await createListEnvironments({
      registry: registryFor(two, false),
      detectRelease: detect,
      timeoutMs: 25,
    })({ check: true });
    const elapsed = Date.now() - t0;
    const [a, b] = out.environments as Array<Record<string, unknown>>;
    eq(
      [a.releaseStatus, "release" in a, b.releaseStatus, b.release],
      ["timed out", false, "detected", "2026.9.2"],
      "timeout isolation",
      "B8: only the slow environment times out",
      "Apply the timeout per environment.",
    );
    ok(
      elapsed < 2000,
      "timeout latency",
      "B8: does not wait for the slow probe",
      "returns shortly after timeoutMs (<2000ms)",
      `${elapsed}ms`,
      "Stop waiting at the timeout.",
    );
  });

  it("B9: a rejected probe is 'unknown' and its message is never included", async () => {
    const detect = jest.fn<(p: Profile) => Promise<ReleaseInfo>>(async (p) => {
      if (p.name === "a") throw new Error(`boom ${KEY_A} rejected-detail`);
      return detected("2026.2.0");
    });
    const out = await createListEnvironments({
      registry: registryFor(two, false),
      detectRelease: detect,
    })({ check: true });
    const [a, b] = out.environments as Array<Record<string, unknown>>;
    eq(
      [a.releaseStatus, "release" in a, b.releaseStatus],
      ["unknown", false, "detected"],
      "rejected probe",
      "B9: rejection maps to unknown",
      "Treat failed probes as unknown without failing the listing.",
    );
    const text = JSON.stringify(out);
    ok(
      !text.includes("rejected-detail") && !text.includes(KEY_A),
      "rejection leak",
      "B9: rejection message never included",
      "no error text or key",
      text,
      "Do not surface probe error text.",
    );
  });

  it("B10: broken profiles are listed as problems and never probed", async () => {
    const detect = jest.fn<(p: Profile) => Promise<ReleaseInfo>>(async () =>
      detected("2026.3.0"),
    );
    await createListEnvironments({
      registry: registryFor({ ...usable("A", KEY_A), ...broken("Z") }, false),
      detectRelease: detect,
    })({ check: true });
    eq(
      detect.mock.calls.map((c) => c[0].name),
      ["a"],
      "broken not probed",
      "B10: only usable profiles are probed",
      "Skip unusable profiles.",
    );
  });
});
