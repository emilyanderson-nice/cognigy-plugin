/**
 * The Claude Code manifest offers a "Default Cognigy profile" setting and
 * passes it to the server as COGNIGY_DEFAULT_PROFILE. Credentials are
 * optional there, because profiles can supply them.
 */
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const manifest = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "plugin",
      ".claude-plugin",
      "plugin.json",
    ),
    "utf8",
  ),
);

describe("Claude Code plugin settings", () => {
  it("declares cognigy_profile as an optional, non-sensitive string", () => {
    const spec = manifest.userConfig.cognigy_profile;
    expect(spec).toEqual({
      type: "string",
      title: "Default Cognigy profile",
      description:
        "Profile name to lock each session to (e.g. edj). Leave empty for none. `csp -p` / COGNIGY_ENVIRONMENT overrides it.",
      default: "",
      required: false,
      sensitive: false,
    });
  });

  it("credentials are no longer required", () => {
    expect(manifest.userConfig.cognigy_api_base_url.required).toBe(false);
    expect(manifest.userConfig.cognigy_api_key.required).toBe(false);
    expect(manifest.userConfig.cognigy_api_key.sensitive).toBe(true);
  });

  it("passes the setting to the platform server as COGNIGY_DEFAULT_PROFILE", () => {
    expect(manifest.mcpServers.platform.env.COGNIGY_DEFAULT_PROFILE).toBe(
      "${user_config.cognigy_profile}",
    );
  });

  // Changed 2026-10-21: a default trial URL made a blank key reuse the credentials-file key against the trial host
  // (the old manifest shipped default "https://api-trial.cognigy.ai"; no earlier assertion pinned it, the contract is now pinned explicitly).
  describe("API base URL has no default", () => {
    const urlSpec = manifest.userConfig.cognigy_api_base_url;

    it("has no default property at all (not empty, not null)", () => {
      expect(Object.prototype.hasOwnProperty.call(urlSpec, "default")).toBe(
        false,
      );
    });

    it("keeps its type, title and optional status", () => {
      expect(urlSpec.type).toBe("string");
      expect(urlSpec.title).toBe("Cognigy API base URL");
      expect(urlSpec.required).toBe(false);
    });

    it("tells the user that leaving it blank uses a saved profile or the credentials file", () => {
      expect(urlSpec.description).toContain("blank");
      expect(urlSpec.description).toMatch(/profile|credentials file/);
    });

    it("keeps the API key optional and sensitive", () => {
      expect(manifest.userConfig.cognigy_api_key.required).toBe(false);
      expect(manifest.userConfig.cognigy_api_key.sensitive).toBe(true);
    });
  });
});

const TRIAL_HOST = "api-trial.cognigy.ai";

/** Paths of every default/value field whose string contains the trial host. */
function trialDefaults(node: unknown, path = ""): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => trialDefaults(item, `${path}[${i}]`));
  }
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, child]) => {
      const here = path ? `${path}.${key}` : key;
      if (
        (key === "default" || key === "value") &&
        typeof child === "string" &&
        child.includes(TRIAL_HOST)
      ) {
        return [here];
      }
      return trialDefaults(child, here);
    });
  }
  return [];
}

describe("no tracked manifest defaults an API base URL to the trial host", () => {
  const pluginDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "plugin",
  );
  const files = [
    ".claude-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".codex-plugin/mcp.json",
    "plugin.json",
    "mcp.json",
  ];

  it("the scanner flags a trial host in default and value but not in description", () => {
    expect(
      trialDefaults({
        a: { default: `https://${TRIAL_HOST}` },
        b: [{ value: `https://${TRIAL_HOST}` }],
        c: { description: `Use https://${TRIAL_HOST} for trials` },
      }),
    ).toEqual(["a.default", "b[0].value"]);
  });

  it.each(files)("%s has no trial-host default", (file) => {
    const json = JSON.parse(readFileSync(join(pluginDir, file), "utf8"));
    expect({ file, trialDefaults: trialDefaults(json) }).toEqual({
      file,
      trialDefaults: [],
    });
  });
});
