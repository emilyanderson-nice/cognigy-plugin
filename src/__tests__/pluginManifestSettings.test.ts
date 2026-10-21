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
});
