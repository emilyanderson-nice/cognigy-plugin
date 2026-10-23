/**
 * B3, sources that compete or mix: env beats file per field and the origin
 * names the WINNER; an unexpanded placeholder falls through to the file; a
 * profile mixing sources reports only the offending field's origin; messages
 * that are out of scope stay unchanged; list_environments passes the reason on.
 */
import { describe, it } from "@jest/globals";
import { createListEnvironments } from "../environments/listEnvironments.js";
import { createEnvironmentRegistry } from "../environments/registry.js";
import { loadProfiles, type Profile } from "../profiles/profiles.js";
import { eq, ok } from "./helpers/specAssert.js";
import {
  BAD_VALUE,
  FAKE_KEY,
  FILE_ORIGIN,
  GOOD_URL,
  LEGACY_ENV_API_ORIGIN,
  expectOriginProblem,
  withOrigin,
  useTempHome,
} from "./helpers/originAssert.js";

useTempHome("origin-mixed-home-");

const OTHER_BAD = 'wget "y" https://example.test/other-secret';
const FILE_API = `COGNIGY_API_BASE_URL in ${FILE_ORIGIN}`;
const FILE_ENDPOINT = `COGNIGY_ENDPOINT_BASE_URL in ${FILE_ORIGIN}`;

describe("B3 env wins over the file, the origin names the winner", () => {
  it("both invalid: the message names the environment variable, not the file", () => {
    const set = loadProfiles({
      env: { COGNIGY_API_BASE_URL: BAD_VALUE, COGNIGY_API_KEY: FAKE_KEY },
      legacyFile: { COGNIGY_API_BASE_URL: OTHER_BAD },
    });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", "apiBaseUrl", LEGACY_ENV_API_ORIGIN),
      "loadProfiles(env and file both invalid)",
    );
    const reason = set.problems.find((p) => p.name === "default")?.reason ?? "";
    eq(
      reason.includes("config.json") || reason.includes("other-secret"),
      false,
      "loadProfiles(env and file both invalid) loser",
      "B3: only the winning source is named; the shadowed file value is not mentioned",
      "Do not mention the file when the environment variable supplied the value.",
    );
  });

  it("env invalid, file valid: still the environment variable (env wins)", () => {
    const set = loadProfiles({
      env: { COGNIGY_API_BASE_URL: BAD_VALUE, COGNIGY_API_KEY: FAKE_KEY },
      legacyFile: { COGNIGY_API_BASE_URL: GOOD_URL },
    });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", "apiBaseUrl", LEGACY_ENV_API_ORIGIN),
      "loadProfiles(env invalid, file valid)",
    );
  });

  it("env valid, file invalid: the file value is shadowed, so no problem at all", () => {
    const set = loadProfiles({
      env: { COGNIGY_API_BASE_URL: GOOD_URL, COGNIGY_API_KEY: FAKE_KEY },
      legacyFile: { COGNIGY_API_BASE_URL: BAD_VALUE },
    });
    eq(
      [set.problems, set.profiles.map((p) => p.name)],
      [[], ["default"]],
      "loadProfiles(env valid, file invalid)",
      "B3: the winning (env) value is valid, so nothing is reported",
      "Validate only the value that wins.",
    );
  });
});

describe("B3 an unexpanded placeholder falls through to the file value", () => {
  it("placeholder env URL, invalid file URL: the origin is the file", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: "${COGNIGY_API_BASE_URL}",
        COGNIGY_API_KEY: FAKE_KEY,
      },
      legacyFile: { COGNIGY_API_BASE_URL: BAD_VALUE },
    });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", "apiBaseUrl", FILE_API),
      "loadProfiles(placeholder env URL, invalid file URL)",
    );
  });

  it("placeholder env endpoint URL, invalid file endpoint URL: the origin is the file", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: GOOD_URL,
        COGNIGY_API_KEY: FAKE_KEY,
        COGNIGY_ENDPOINT_BASE_URL: "${COGNIGY_ENDPOINT_BASE_URL}",
      },
      legacyFile: { COGNIGY_ENDPOINT_BASE_URL: BAD_VALUE },
    });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", "endpointBaseUrl", FILE_ENDPOINT),
      "loadProfiles(placeholder env endpoint, invalid file endpoint)",
    );
  });
});

describe("B3 a whitespace-only env value is unusable and falls through to the file", () => {
  it("whitespace env API URL, invalid file URL: the origin is the file", () => {
    const set = loadProfiles({
      env: { COGNIGY_API_BASE_URL: "   ", COGNIGY_API_KEY: FAKE_KEY },
      legacyFile: { COGNIGY_API_BASE_URL: BAD_VALUE },
    });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", "apiBaseUrl", FILE_API),
      "loadProfiles(whitespace env URL, invalid file URL)",
    );
  });

  it("whitespace env endpoint URL, invalid file endpoint URL: the origin is the file", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: GOOD_URL,
        COGNIGY_API_KEY: FAKE_KEY,
        COGNIGY_ENDPOINT_BASE_URL: "   ",
      },
      legacyFile: { COGNIGY_ENDPOINT_BASE_URL: BAD_VALUE },
    });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", "endpointBaseUrl", FILE_ENDPOINT),
      "loadProfiles(whitespace env endpoint, invalid file endpoint)",
    );
  });

  it("whitespace env URLs with valid file values: no problem, file values used", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: "   ",
        COGNIGY_API_KEY: FAKE_KEY,
        COGNIGY_ENDPOINT_BASE_URL: "   ",
      },
      legacyFile: {
        COGNIGY_API_BASE_URL: GOOD_URL,
        COGNIGY_ENDPOINT_BASE_URL: "https://endpoint-good.cognigy.ai",
      },
    });
    const d = set.profiles.find((p) => p.name === "default");
    eq(
      [set.problems, d?.apiBaseUrl, d?.endpointBaseUrl],
      [[], GOOD_URL, "https://endpoint-good.cognigy.ai"],
      "loadProfiles(whitespace env URLs, valid file URLs)",
      "B3: a whitespace-only env value is treated as unset, so the file value wins",
      "Trim env values and fall through to the file when the result is empty.",
    );
  });
});

describe("B3 a profile mixing sources reports the offending field's origin only", () => {
  it("URL from the file (invalid), key from the environment: the file, not the environment", () => {
    const set = loadProfiles({
      env: { COGNIGY_API_KEY: FAKE_KEY },
      legacyFile: { COGNIGY_API_BASE_URL: BAD_VALUE },
    });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", "apiBaseUrl", FILE_API),
      "loadProfiles(file URL invalid, env key)",
    );
    const reason = set.problems.find((p) => p.name === "default")?.reason ?? "";
    eq(
      reason.includes("environment variable"),
      false,
      "loadProfiles(file URL invalid, env key) wording",
      "B3: the message names the origin of the bad field, not the profile's `source`",
      "Use the per-field origin; do not describe the environment-supplied key.",
    );
  });

  it("URL from the environment (valid), endpoint URL from the file (invalid): the file endpoint", () => {
    const set = loadProfiles({
      env: { COGNIGY_API_BASE_URL: GOOD_URL, COGNIGY_API_KEY: FAKE_KEY },
      legacyFile: { COGNIGY_ENDPOINT_BASE_URL: BAD_VALUE },
    });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", "endpointBaseUrl", FILE_ENDPOINT),
      "loadProfiles(env API URL, file endpoint invalid)",
    );
  });

  it("URL from the file (valid), endpoint from the environment (invalid): the environment variable", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_KEY: FAKE_KEY,
        COGNIGY_ENDPOINT_BASE_URL: BAD_VALUE,
      },
      legacyFile: { COGNIGY_API_BASE_URL: GOOD_URL },
    });
    expectOriginProblem(
      set,
      "default",
      withOrigin(
        "default",
        "endpointBaseUrl",
        "the environment variable COGNIGY_ENDPOINT_BASE_URL",
      ),
      "loadProfiles(file API URL, env endpoint invalid)",
    );
  });
});

describe("B3 out-of-scope messages are unchanged", () => {
  it("a missing API_BASE_URL or API_KEY never gets an origin clause", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_PROFILE_A_API_KEY: FAKE_KEY,
        COGNIGY_PROFILE_B_API_BASE_URL: GOOD_URL,
      },
    });
    const reasons = set.problems.map((p) => p.reason);
    ok(
      reasons.length === 2 && reasons.every((r) => !r.includes("value from")),
      "loadProfiles(missing URL, missing key)",
      "B3: only invalid-URL messages gain an origin",
      "two problems (a, b), neither containing 'value from'",
      JSON.stringify(reasons),
      "Leave the 'is missing' messages exactly as they are.",
    );
  });
});

describe("B3 list_environments passes the new reason through", () => {
  it("problems[].reason carries the origin text", async () => {
    const set = loadProfiles({
      env: {
        COGNIGY_PROFILE_OK_API_BASE_URL: GOOD_URL,
        COGNIGY_PROFILE_OK_API_KEY: FAKE_KEY,
        COGNIGY_PROFILE_BAD_API_BASE_URL: BAD_VALUE,
        COGNIGY_PROFILE_BAD_API_KEY: FAKE_KEY,
      },
    });
    const registry = createEnvironmentRegistry({
      loadProfiles: () => set,
      createRuntime: (profile: Profile) => ({
        profile,
        client: {},
        handlers: { handleToolCall: async () => ({}) },
      }),
    } as never);
    const out = (await createListEnvironments({
      registry,
      detectRelease: async () => {
        throw new Error("not expected");
      },
    })({})) as { problems: Array<{ name: string; reason: string }> };
    const reason = out.problems.find((p) => p.name === "bad")?.reason ?? "";
    eq(
      reason.includes(
        withOrigin(
          "bad",
          "apiBaseUrl",
          "the environment variable COGNIGY_PROFILE_BAD_API_BASE_URL",
        ),
      ) &&
        !reason.includes("secret-token") &&
        !reason.includes("://"),
      true,
      "list_environments problems",
      "B3: the problem text shown to the user names the source variable and no value",
      "Surface ProfileProblem.reason unchanged.",
    );
  });
});
