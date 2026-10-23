/**
 * B3: invalid profile URLs say where the bad value came from.
 * Covers the legacy "default" profile (env and config file), env profiles
 * (exact variable spelling), saved profiles, and the CLI `profile add` path
 * (no origin, old text). Everything is injected; HOME points at a temp dir so a
 * real ~/.cognigy-plugin/config.json can never be read.
 */
import { join } from "path";
import { describe, it } from "@jest/globals";
import { ProfileConfigError, loadProfiles } from "../profiles/profiles.js";
import { upsertProfile } from "../profiles/profilesStore.js";
import { eq, ok, raises } from "./helpers/specAssert.js";
import {
  BAD_VALUE,
  FAKE_KEY,
  FILE_ORIGIN,
  GOOD_URL,
  envOrigin,
  expectOriginProblem,
  withOrigin,
  useTempHome,
} from "./helpers/originAssert.js";

const getHome = useTempHome("origin-home-");

type Field =
  | "apiBaseUrl"
  | "endpointBaseUrl"
  | "webchatBaseUrl"
  | "staticFilesBaseUrl";

/** legacy variable name and profile field for each URL setting */
const LEGACY: Array<[Field, string]> = [
  ["apiBaseUrl", "COGNIGY_API_BASE_URL"],
  ["endpointBaseUrl", "COGNIGY_ENDPOINT_BASE_URL"],
  ["webchatBaseUrl", "COGNIGY_WEBCHAT_BASE_URL"],
  ["staticFilesBaseUrl", "COGNIGY_STATIC_FILES_BASE_URL"],
];

describe("B3 legacy default profile, value from environment variables", () => {
  it.each(LEGACY)("%s from %s names the variable", (field, variable) => {
    const env: Record<string, string> = {
      COGNIGY_API_BASE_URL: GOOD_URL,
      COGNIGY_API_KEY: FAKE_KEY,
      [variable]: BAD_VALUE,
    };
    const set = loadProfiles({ env, legacyFile: {} });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", field, envOrigin(variable)),
      `loadProfiles(legacy env ${variable} invalid)`,
    );
  });
});

describe("B3 legacy default profile, value from the user config file", () => {
  it.each(LEGACY)("%s from %s names the file", (field, variable) => {
    const legacyFile: Record<string, string> = {
      COGNIGY_API_BASE_URL: GOOD_URL,
      COGNIGY_API_KEY: FAKE_KEY,
      [variable]: BAD_VALUE,
    };
    const set = loadProfiles({ env: {}, legacyFile });
    expectOriginProblem(
      set,
      "default",
      withOrigin("default", field, `${variable} in ${FILE_ORIGIN}`),
      `loadProfiles(legacy file ${variable} invalid)`,
    );
  });
});

describe("B3 env profiles name the exact variable, in its original spelling", () => {
  it.each([
    ["COGNIGY_PROFILE_PROD_API_BASE_URL", "prod", "apiBaseUrl", {}],
    [
      "COGNIGY_PROFILE_PROD_ENDPOINT_BASE_URL",
      "prod",
      "endpointBaseUrl",
      { COGNIGY_PROFILE_PROD_API_BASE_URL: GOOD_URL },
    ],
    [
      "COGNIGY_PROFILE_PROD_WEBCHAT_BASE_URL",
      "prod",
      "webchatBaseUrl",
      { COGNIGY_PROFILE_PROD_API_BASE_URL: GOOD_URL },
    ],
    [
      "COGNIGY_PROFILE_PROD_STATIC_FILES_BASE_URL",
      "prod",
      "staticFilesBaseUrl",
      { COGNIGY_PROFILE_PROD_API_BASE_URL: GOOD_URL },
    ],
    ["Cognigy_Profile_Y_Api_Base_Url", "y", "apiBaseUrl", {}],
    [
      "Cognigy_Profile_Y_Webchat_Base_Url",
      "y",
      "webchatBaseUrl",
      { Cognigy_Profile_Y_Api_Base_Url: GOOD_URL },
    ],
  ] as Array<[string, string, Field, Record<string, string>]>)(
    "%s",
    (variable, name, field, extra) => {
      const prefix = variable.slice(0, "COGNIGY_PROFILE_".length);
      const env: Record<string, string> = {
        ...extra,
        [`${prefix}${name.toUpperCase()}_API_KEY`]: FAKE_KEY,
        [variable]: BAD_VALUE,
      };
      const set = loadProfiles({ env });
      expectOriginProblem(
        set,
        name,
        withOrigin(name, field, `the environment variable ${variable}`),
        `loadProfiles(env profile ${variable} invalid)`,
      );
    },
  );
});

describe("B3 saved profiles in config.json", () => {
  it.each([
    ["apiBaseUrl", {}],
    ["endpointBaseUrl", {}],
    ["webchatBaseUrl", {}],
    ["staticFilesBaseUrl", {}],
  ] as Array<[Field, Record<string, string>]>)(
    "%s names the saved profile",
    (field) => {
      const profile: Record<string, string> = {
        apiBaseUrl: GOOD_URL,
        apiKey: FAKE_KEY,
        [field]: BAD_VALUE,
      };
      const set = loadProfiles({
        env: {},
        fileProfiles: { profiles: { staging: profile }, problems: [] } as never,
      });
      expectOriginProblem(
        set,
        "staging",
        withOrigin(
          "staging",
          field,
          `the saved profile "staging" in ${FILE_ORIGIN}`,
        ),
        `loadProfiles(saved profile ${field} invalid)`,
      );
    },
  );
});

describe("B3 `profile add` (upsertProfile) has no origin and keeps the old text", () => {
  it.each([
    "apiBaseUrl",
    "endpointBaseUrl",
    "webchatBaseUrl",
    "staticFilesBaseUrl",
  ])("%s", (field) => {
    const path = join(getHome(), "config.json");
    const err = raises(
      () =>
        upsertProfile(
          "dev",
          { apiBaseUrl: GOOD_URL, apiKey: FAKE_KEY, [field]: BAD_VALUE },
          { path },
        ),
      ProfileConfigError,
      `upsertProfile(invalid ${field})`,
      "B3: the CLI path has no origin to report",
      "Reject the profile with the unchanged message.",
    );
    const old = `Profile "dev": ${field} is not a valid http(s) URL.`;
    ok(
      err.message.includes(old) && !err.message.includes("value from"),
      `upsertProfile(invalid ${field}) message`,
      "B3: without an origin the message is exactly today's text",
      `message containing exactly: ${old} and no "value from"`,
      JSON.stringify(err.message),
      "Only add the origin clause when an origin is supplied.",
    );
    eq(
      err.message.includes(FAKE_KEY) || err.message.includes("secret-token"),
      false,
      `upsertProfile(invalid ${field}) secrecy`,
      "B3: never quote the value or the key",
      "Leave the value and key out of the message.",
    );
  });
});
