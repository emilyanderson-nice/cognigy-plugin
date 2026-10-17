/**
 * G2 (ambiguous hint for a legacy `default`) and the G5 remedy wording of the
 * "broken" error produced from a configuration load failure.
 */
import { describe, it, jest } from "@jest/globals";
import {
  EnvironmentError,
  createEnvironmentRegistry,
  type EnvironmentRuntime,
} from "../environments/registry.js";
import { createDispatcher } from "../server/dispatch.js";
import {
  loadProfiles,
  type Profile,
  type ProfileSet,
} from "../profiles/profiles.js";
import {
  KEY_A,
  KEY_B,
  LIST_ENV_TOOL,
  idTask,
  parse,
  tool,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok, raises, show } from "./helpers/specAssert.js";

const KEY_D = "fake-key-DEFAULT-distinct-6";
const LEGACY_ENV = {
  COGNIGY_API_BASE_URL: "https://api-legacy.cognigy.ai",
  COGNIGY_API_KEY: KEY_D,
};
const SENTENCE = "COGNIGY_API_*";

const legacyEnvSet = (): ProfileSet =>
  loadProfiles({ env: { ...LEGACY_ENV, ...usable("B", KEY_B) } });
const legacyFileSet = (): ProfileSet =>
  loadProfiles({
    env: usable("B", KEY_B),
    legacyFile: {
      COGNIGY_API_BASE_URL: "https://api-legacy.cognigy.ai",
      COGNIGY_API_KEY: KEY_D,
    },
  });
const fileDefaultSet = (): ProfileSet =>
  loadProfiles({
    env: usable("B", KEY_B),
    fileProfiles: {
      profiles: {
        default: {
          apiBaseUrl: "https://api-saved.cognigy.ai",
          apiKey: KEY_D,
        },
      },
      problems: [],
    },
  } as never);
const noDefaultSet = (): ProfileSet =>
  loadProfiles({ env: { ...usable("A", KEY_A), ...usable("B", KEY_B) } });

function registryFor(load: () => ProfileSet) {
  return createEnvironmentRegistry({
    loadProfiles: load,
    createRuntime: (profile: Profile): EnvironmentRuntime => ({
      profile,
      client: {},
      handlers: { handleToolCall: async () => "ok" },
    }),
  });
}

function dispatcherFor(load: () => ProfileSet) {
  return createDispatcher({
    registry: registryFor(load),
    tools: [tool("alpha")],
    rateLimiter: { check: () => true },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    runWithTask: idTask,
    listEnvironments: async () => ({}),
    listEnvironmentsTool: LIST_ENV_TOOL,
  });
}

describe("G2: ambiguous hint for a legacy default", () => {
  it.each([
    ["legacy-env", legacyEnvSet],
    ["legacy-file", legacyFileSet],
  ])(
    "default from %s: the ambiguous message names the original COGNIGY_API_* setup",
    async (source, make) => {
      const set = make();
      eq(
        set.profiles.find((p) => p.name === "default")?.source,
        source,
        `fixture sanity (${source})`,
        "G2: fixture holds a default of that source",
        "Fixture must contain the legacy default.",
      );
      const e = raises(
        () => registryFor(make).resolve(),
        EnvironmentError,
        `registry ambiguous (${source})`,
        "G2: no name with two environments is ambiguous",
        "Refuse to guess.",
      );
      eq(e.code, "ambiguous", `code (${source})`, "G2: code", "Keep code.");
      ok(
        e.message.includes(`"default" is your original ${SENTENCE} setup.`),
        `registry hint (${source})`,
        'G2: message contains the sentence `"default" is your original COGNIGY_API_* setup.`',
        "message containing that sentence",
        show(e.message),
        "Explain what the environment called default is.",
      );
      const r = await dispatcherFor(make).callTool("alpha", {});
      const body = parse(r);
      ok(
        r.isError === true &&
          body.code === "ambiguous" &&
          String(body.error) === e.message,
        `dispatcher hint (${source})`,
        "G2: the dispatcher's JSON error carries the same message",
        "isError, code ambiguous, error equal to the registry message",
        show(body),
        "Forward the registry message unchanged.",
      );
    },
  );

  it.each([
    ["a file-profile named default", fileDefaultSet],
    ["no default at all", noDefaultSet],
  ])("%s: the legacy sentence is absent", async (_l, make) => {
    const e = raises(
      () => registryFor(make).resolve(),
      EnvironmentError,
      `registry ambiguous (${_l})`,
      "G2: still ambiguous",
      "Refuse to guess.",
    );
    ok(
      !e.message.includes(SENTENCE),
      `no hint (${_l})`,
      "G2: sentence only when the default is a legacy definition",
      "message without COGNIGY_API_*",
      show(e.message),
      "Do not mention the legacy setup for other defaults.",
    );
    const body = parse(await dispatcherFor(make).callTool("alpha", {}));
    ok(
      !String(body.error).includes(SENTENCE),
      `dispatcher no hint (${_l})`,
      "G2: dispatcher message also without the sentence",
      "no COGNIGY_API_*",
      show(body),
      "Forward the registry message unchanged.",
    );
  });
});

describe("G5: remedy wording of the broken load error", () => {
  const failing = (): ProfileSet => {
    throw new Error("config.json is not valid JSON");
  };

  it("registry message keeps the cause and adds fix-or-remove and the .bak backup", () => {
    const e = raises(
      () => registryFor(failing).resolve("a"),
      EnvironmentError,
      "registry broken",
      "G5: loader failure is a broken EnvironmentError",
      "Fail closed on unreadable configuration.",
    );
    ok(
      e.code === "broken" &&
        e.message.includes("config.json is not valid JSON") &&
        /fix or remove/i.test(e.message) &&
        e.message.includes("config.json.bak"),
      "broken remedy",
      "G5: message holds the cause, 'fix or remove' and 'config.json.bak'",
      "all three present",
      show(e.message),
      "Tell the user how to recover and where the backup lives.",
    );
  });

  it("dispatcher forwards the same remedy text", async () => {
    const r = await dispatcherFor(failing).callTool("alpha", {
      environment: "a",
    });
    const body = parse(r);
    ok(
      r.isError === true &&
        body.code === "broken" &&
        /fix or remove/i.test(String(body.error)) &&
        String(body.error).includes("config.json.bak"),
      "dispatcher broken remedy",
      "G5: dispatcher error carries the remedy words",
      "code broken with fix or remove + config.json.bak",
      show(body),
      "Forward the registry message unchanged.",
    );
  });
});
