/**
 * Voice Gateway credentials on a profile: a base URL and an account API key per
 * environment, next to the Cognigy.AI key. They arrive from a saved profile, from
 * COGNIGY_PROFILE_<NAME>_VOICE_GATEWAY_* variables, or from `profile add`; the key
 * is a second secret and must stay out of JSON, inspect output and messages.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inspect } from "util";
import {
  describeProfile,
  loadProfiles,
  type Profile,
} from "../profiles/profiles.js";
import {
  readUserProfilesFile,
  type RawFileProfile,
} from "../profiles/profilesFile.js";
import { upsertProfile } from "../profiles/profilesStore.js";
import { ProfileConfigError } from "../profiles/profiles.js";
import {
  KEY as CLI_API_KEY,
  makeHarness,
} from "./helpers/profileCliHarness.js";

const API_KEY = "cognigy-api-key-AAAA1111";
const VG_KEY = "vg-account-key-ZZZZ9999";
const API_URL = "https://api-dev.cognigy.ai";
const VG_URL = "https://api-vg-dev.example.test";
const P = "COGNIGY_PROFILE_";

const only = (profiles: Profile[], name: string): Profile => {
  const found = profiles.find((p) => p.name === name);
  if (!found) throw new Error(`profile ${name} missing`);
  return found;
};

describe("voice gateway fields: saved profile", () => {
  it("reads both fields from a saved profile and strips a trailing slash from the URL", () => {
    const set = loadProfiles({
      fileProfiles: {
        profiles: {
          dev: {
            apiBaseUrl: API_URL,
            apiKey: API_KEY,
            voiceGatewayBaseUrl: `${VG_URL}/v1/`,
            voiceGatewayApiKey: VG_KEY,
          },
        },
        problems: [],
      },
    });
    const dev = only(set.profiles, "dev");
    expect(dev.voiceGatewayBaseUrl).toBe(`${VG_URL}/v1`);
    expect(dev.voiceGatewayApiKey).toBe(VG_KEY);
    expect(dev.apiKey).toBe(API_KEY);
  });

  it("leaves both undefined when the profile has none", () => {
    const set = loadProfiles({
      fileProfiles: {
        profiles: { dev: { apiBaseUrl: API_URL, apiKey: API_KEY } },
        problems: [],
      },
    });
    const dev = only(set.profiles, "dev");
    expect(dev.voiceGatewayBaseUrl).toBeUndefined();
    expect(dev.voiceGatewayApiKey).toBeUndefined();
  });

  it("refuses a non-string Voice Gateway key without quoting it", () => {
    const bad = {
      apiBaseUrl: API_URL,
      apiKey: API_KEY,
      voiceGatewayApiKey: 12345,
    } as unknown as RawFileProfile;
    const result = loadProfiles({
      fileProfiles: { profiles: { dev: bad }, problems: [] },
    });
    const problem = result.problems.find((p) => p.name === "dev");
    expect(problem?.reason).toContain("voiceGatewayApiKey");
    expect(problem?.reason).not.toContain("12345");
  });
});

describe("voice gateway fields: environment variables", () => {
  const env = (extra: Record<string, string> = {}) => ({
    [`${P}NA1_API_BASE_URL`]: API_URL,
    [`${P}NA1_API_KEY`]: API_KEY,
    ...extra,
  });

  it("maps NAME_VOICE_GATEWAY_BASE_URL and _API_KEY onto the profile NAME, not a new profile", () => {
    const set = loadProfiles({
      env: env({
        [`${P}NA1_VOICE_GATEWAY_BASE_URL`]: VG_URL,
        [`${P}NA1_VOICE_GATEWAY_API_KEY`]: VG_KEY,
      }),
    });
    expect(set.profiles.map((p) => p.name)).toStrictEqual(["na1"]);
    expect(set.problems).toStrictEqual([]);
    const na1 = only(set.profiles, "na1");
    expect(na1.voiceGatewayBaseUrl).toBe(VG_URL);
    expect(na1.voiceGatewayApiKey).toBe(VG_KEY);
    // the Cognigy.AI key is untouched by the Voice Gateway key
    expect(na1.apiKey).toBe(API_KEY);
  });

  it("still reads an ordinary profile whose name ends in a setting-like word", () => {
    const set = loadProfiles({
      env: {
        [`${P}MY_API_KEY_API_BASE_URL`]: API_URL,
        [`${P}MY_API_KEY_API_KEY`]: API_KEY,
      },
    });
    expect(set.profiles.map((p) => p.name)).toStrictEqual(["my-api-key"]);
  });
});

describe("voice gateway fields: validation", () => {
  const withVg = (fields: Record<string, string | undefined>) =>
    loadProfiles({
      fileProfiles: {
        profiles: {
          dev: { apiBaseUrl: API_URL, apiKey: API_KEY, ...fields },
        },
        problems: [],
      },
    });

  it.each([
    ["http scheme", "http://api-vg-dev.example.test"],
    ["not a URL", "not a url"],
    ["ftp scheme", "ftp://api-vg-dev.example.test"],
  ])(
    "refuses a base URL that is not https (%s), naming the field and no value",
    (_l, url) => {
      const set = withVg({
        voiceGatewayBaseUrl: url,
        voiceGatewayApiKey: VG_KEY,
      });
      expect(set.profiles).toStrictEqual([]);
      const reason = set.problems.find((p) => p.name === "dev")?.reason ?? "";
      expect(reason).toContain("voiceGatewayBaseUrl must be an https URL");
      expect(reason).not.toContain(url);
      expect(reason).not.toContain(VG_KEY);
    },
  );

  it.each([
    ["URL without key", { voiceGatewayBaseUrl: VG_URL }],
    ["key without URL", { voiceGatewayApiKey: VG_KEY }],
  ])("refuses a half-defined pair (%s)", (_l, fields) => {
    const set = withVg(fields);
    expect(set.profiles).toStrictEqual([]);
    const reason = set.problems.find((p) => p.name === "dev")?.reason ?? "";
    expect(reason).toContain(
      "voiceGatewayBaseUrl and voiceGatewayApiKey must be set together",
    );
    expect(reason).not.toContain(VG_KEY);
  });
});

describe("voice gateway fields: secrecy", () => {
  it("the Voice Gateway key is readable as a property but absent from JSON, String and inspect", () => {
    const set = loadProfiles({
      fileProfiles: {
        profiles: {
          dev: {
            apiBaseUrl: API_URL,
            apiKey: API_KEY,
            voiceGatewayBaseUrl: VG_URL,
            voiceGatewayApiKey: VG_KEY,
          },
        },
        problems: [],
      },
    });
    const dev = only(set.profiles, "dev");
    expect(dev.voiceGatewayApiKey).toBe(VG_KEY);
    for (const text of [
      JSON.stringify(dev),
      JSON.stringify(set),
      String(dev),
      inspect(dev, { depth: null, showHidden: false }),
      inspect(set, { depth: null }),
    ]) {
      expect(text).not.toContain(VG_KEY);
      expect(text).not.toContain(API_KEY);
    }
  });

  it("the key is not an enumerable property, so a spread or Object.entries cannot copy it", () => {
    const set = loadProfiles({
      fileProfiles: {
        profiles: {
          dev: {
            apiBaseUrl: API_URL,
            apiKey: API_KEY,
            voiceGatewayBaseUrl: VG_URL,
            voiceGatewayApiKey: VG_KEY,
          },
        },
        problems: [],
      },
    });
    const dev = only(set.profiles, "dev");
    expect(Object.keys(dev)).not.toContain("voiceGatewayApiKey");
    expect(Object.keys(dev)).not.toContain("apiKey");
    expect(JSON.stringify({ ...dev })).not.toContain(VG_KEY);
    expect(JSON.stringify(Object.entries(dev))).not.toContain(VG_KEY);
    // the base URL stays visible: only the secret is hidden
    expect(Object.keys(dev)).toContain("voiceGatewayBaseUrl");
  });

  it("describeProfile adds only the Voice Gateway host, and nothing when it is not configured", () => {
    const set = loadProfiles({
      fileProfiles: {
        profiles: {
          dev: {
            apiBaseUrl: API_URL,
            apiKey: API_KEY,
            voiceGatewayBaseUrl: `${VG_URL}/v1`,
            voiceGatewayApiKey: VG_KEY,
          },
          plain: { apiBaseUrl: API_URL, apiKey: API_KEY },
        },
        problems: [],
      },
    });
    const described = describeProfile(only(set.profiles, "dev"));
    expect(described.voiceGatewayHost).toBe("api-vg-dev.example.test");
    expect(JSON.stringify(described)).not.toContain(VG_KEY);
    expect(JSON.stringify(described)).not.toContain("/v1");
    expect(describeProfile(only(set.profiles, "plain"))).not.toHaveProperty(
      "voiceGatewayHost",
    );
  });
});

describe("voice gateway fields: saved by the store", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const path = () => {
    dir = mkdtempSync(join(tmpdir(), "cognigy-vg-store-"));
    return join(dir, "config.json");
  };

  it("persists the two fields, trimmed, and reads them back", () => {
    const file = path();
    upsertProfile(
      "dev",
      {
        apiBaseUrl: API_URL,
        apiKey: API_KEY,
        voiceGatewayBaseUrl: `  ${VG_URL}/ `,
        voiceGatewayApiKey: ` ${VG_KEY} `,
      },
      { path: file },
    );
    const stored = readUserProfilesFile(file).profiles.dev;
    expect(stored.voiceGatewayBaseUrl).toBe(VG_URL);
    expect(stored.voiceGatewayApiKey).toBe(VG_KEY);
  });

  it("refuses an http Voice Gateway URL and a half-defined pair before writing", () => {
    const file = path();
    expect(() =>
      upsertProfile(
        "dev",
        {
          apiBaseUrl: API_URL,
          apiKey: API_KEY,
          voiceGatewayBaseUrl: "http://vg.example.test",
          voiceGatewayApiKey: VG_KEY,
        },
        { path: file },
      ),
    ).toThrow(ProfileConfigError);
    expect(() =>
      upsertProfile(
        "dev",
        { apiBaseUrl: API_URL, apiKey: API_KEY, voiceGatewayBaseUrl: VG_URL },
        { path: file },
      ),
    ).toThrow(/set together/);
    expect(readUserProfilesFile(file).profiles).toStrictEqual({});
  });
});

describe("voice gateway fields: profile add", () => {
  const ENV = { CGKEY: CLI_API_KEY, VGKEY: VG_KEY } as NodeJS.ProcessEnv;
  const BASE = [
    "--api-base-url",
    API_URL,
    "--api-key-env",
    "CGKEY",
    "--no-test",
  ];

  it("saves the URL and the key read from the named variable, and prints neither secret", async () => {
    const h = makeHarness({ env: ENV });
    const code = await h.run([
      "add",
      "dev",
      ...BASE,
      "--voice-gateway-url",
      `${VG_URL}/v1`,
      "--voice-gateway-key-env",
      "VGKEY",
    ]);
    expect(code).toBe(0);
    expect(h.upserts[0].profile).toMatchObject({
      voiceGatewayBaseUrl: `${VG_URL}/v1`,
      voiceGatewayApiKey: VG_KEY,
    });
    expect(h.outText()).toContain("api-vg-dev.example.test");
    expect(h.outText() + h.errText()).not.toContain(VG_KEY);
  });

  it("prompts for the key without echo when interactive and only the URL was given", async () => {
    const h = makeHarness({ env: ENV, isTTY: true, hiddenAsks: [VG_KEY] });
    const code = await h.run([
      "add",
      "dev",
      ...BASE,
      "--voice-gateway-url",
      VG_URL,
    ]);
    expect(code).toBe(0);
    expect(h.askedHidden).toStrictEqual(["Voice Gateway API key: "]);
    expect(h.upserts[0].profile.voiceGatewayApiKey).toBe(VG_KEY);
  });

  it("without a terminal, a URL without a key variable is refused and nothing is written", async () => {
    const h = makeHealthy();
    const code = await h.run([
      "add",
      "dev",
      ...BASE,
      "--voice-gateway-url",
      VG_URL,
    ]);
    expect(code).toBe(1);
    expect(h.errText()).toContain("--voice-gateway-key-env");
    expect(h.upserts).toStrictEqual([]);
  });

  it("a key variable without a URL is refused and nothing is written", async () => {
    const h = makeHealthy();
    const code = await h.run([
      "add",
      "dev",
      ...BASE,
      "--voice-gateway-key-env",
      "VGKEY",
    ]);
    expect(code).toBe(1);
    expect(h.errText()).toContain("--voice-gateway-url");
    expect(h.upserts).toStrictEqual([]);
  });

  it("an unset or empty key variable is refused and nothing is written", async () => {
    const h = makeHarness({ env: { CGKEY: CLI_API_KEY } as NodeJS.ProcessEnv });
    const code = await h.run([
      "add",
      "dev",
      ...BASE,
      "--voice-gateway-url",
      VG_URL,
      "--voice-gateway-key-env",
      "VGKEY",
    ]);
    expect(code).toBe(1);
    expect(h.errText()).toContain("VGKEY");
    expect(h.upserts).toStrictEqual([]);
  });

  it("without the flags the saved profile carries no Voice Gateway fields", async () => {
    const h = makeHarness({ env: ENV });
    await h.run(["add", "dev", ...BASE]);
    expect(h.upserts[0].profile).not.toHaveProperty("voiceGatewayBaseUrl");
    expect(h.upserts[0].profile).not.toHaveProperty("voiceGatewayApiKey");
  });

  function makeHealthy() {
    return makeHarness({ env: ENV });
  }
});
