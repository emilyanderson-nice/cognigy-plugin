/**
 * Module C: the real MCP server (spawned over stdio) serves environments
 * through the registry + dispatcher. Hosts are unresolvable (.invalid) and
 * only resolution errors, tools/list and list_environments (no check) are
 * exercised, so no request is ever made. Each server runs with an isolated
 * temp HOME (see helpers/mcpStdio.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  BOOT_TIMEOUT_MS,
  makeTempHome,
  startMcpServer,
  type McpServer,
} from "./helpers/mcpStdio.js";
import { tools } from "../tools/definitions.js";
import { eq, ok, show } from "./helpers/specAssert.js";

const KEY_A = "mcp-e2e-key-AAAA-distinct-11";
const KEY_B = "mcp-e2e-key-BBBB-distinct-22";
const KEY_L = "mcp-e2e-key-LEGACY-distinct-33";
const KEY_F = "mcp-e2e-key-FILEPROF-distinct-44";
const KEY_C = "mcp-e2e-key-CORRUPT-distinct-55";
const CORRUPT_MARKER = "CORRUPT-FILE-CONTENT-MARKER-xyz";
const TIMEOUT = BOOT_TIMEOUT_MS + 30000;

const profileEnv = (n: string, host: string, key: string) => ({
  [`COGNIGY_PROFILE_${n}_API_BASE_URL`]: `https://${host}.invalid`,
  [`COGNIGY_PROFILE_${n}_API_KEY`]: key,
});

const servers: McpServer[] = [];
const boot = async (opts: Parameters<typeof startMcpServer>[0]) => {
  const s = await startMcpServer(opts);
  servers.push(s);
  return s;
};
afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("scenario 1: two environments via env vars", () => {
  let s: McpServer;
  beforeAll(async () => {
    s = await boot({
      env: {
        ...profileEnv("A", "api-a", KEY_A),
        ...profileEnv("B", "api-b", KEY_B),
      },
    });
  }, TIMEOUT);

  it("tools/list injects the environment enum and keeps required unchanged", async () => {
    const listed = await s.listTools();
    const names = listed.map((t) => t.name);
    ok(
      names.includes("list_environments"),
      "mcp::list_environments_listed",
      "Rule: list_environments is served",
      "list_environments in tools/list",
      show(names),
      "Serve the environment listing tool.",
    );
    eq(
      names.length,
      tools.length + 2,
      "mcp::tool_count",
      "Rule: real tools plus list_environments and use_environment",
      "Serve every real tool and exactly two extras.",
    );
    for (const def of tools) {
      const t = listed.find((x) => x.name === def.name);
      eq(
        [
          t?.inputSchema?.properties?.environment?.type,
          t?.inputSchema?.properties?.environment?.enum,
          t?.inputSchema?.required,
        ],
        ["string", ["a", "b"], def.inputSchema.required],
        `mcp::schema[${def.name}]`,
        "Rule: environment string enum [a,b]; required unchanged",
        "Advertise the environment argument on every real tool.",
      );
    }
  });

  it("list_environments returns a and b, no key anywhere", async () => {
    const { result, body } = await s.callToolJson("list_environments");
    eq(
      [
        body.environments.map((e: { name: string }) => e.name),
        body.configured,
        body.environmentArgumentRequired,
      ],
      [["a", "b"], 2, true],
      "mcp::list_two",
      "Rule: both environments listed, argument required",
      "List configured environments.",
    );
    const all = JSON.stringify(result) + s.stderr();
    ok(
      !all.includes(KEY_A) && !all.includes(KEY_B),
      "mcp::no_key_leak",
      "Rule: keys never appear in responses or stderr",
      "no key text",
      "key text found",
      "Keep credentials out of every channel.",
    );
  });

  it("a call without environment is refused as ambiguous", async () => {
    const { result, body } = await s.callToolJson("list_resources", {});
    eq(
      [result.isError, body.code],
      [true, "ambiguous"],
      "mcp::ambiguous",
      "Rule: two environments and no argument -> ambiguous",
      "Refuse rather than guess.",
    );
  });

  it("an unknown environment is refused, listing a and b", async () => {
    const { result, body } = await s.callToolJson("list_resources", {
      environment: "zzz",
    });
    eq(
      [result.isError, body.code, body.available],
      [true, "unknown", ["a", "b"]],
      "mcp::unknown",
      'Rule: unknown name -> code "unknown" with available a, b',
      "Name the environments that do exist.",
    );
  });

  it("stdout carries only JSON-RPC (no key, no stray text)", () => {
    const lines = s
      .stdout()
      .split("\n")
      .filter((l) => l.trim());
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
    ok(
      !s.stdout().includes(KEY_A),
      "mcp::stdout_clean",
      "Rule: stdout is protocol-only and key-free",
      "no key text on stdout",
      "key on stdout",
      "Never print credentials or logs to stdout.",
    );
  });
});

describe("scenario 1b: session pinned at launch with COGNIGY_ENVIRONMENT", () => {
  let s: McpServer;
  beforeAll(async () => {
    s = await boot({
      env: {
        ...profileEnv("A", "api-a", KEY_A),
        ...profileEnv("B", "api-b", KEY_B),
        COGNIGY_ENVIRONMENT: "B",
      },
    });
  }, TIMEOUT);

  it("list_environments reports the launch pin", async () => {
    const { body } = await s.callToolJson("list_environments");
    expect(body.pin).toEqual({ name: "b", source: "COGNIGY_ENVIRONMENT" });
    expect(body.environmentArgumentRequired).toBe(false);
  });

  it("use_environment switches the pin; clear restores the required argument", async () => {
    const pinned = await s.callToolJson("use_environment", { name: "a" });
    expect(pinned.body.pinned).toEqual({
      name: "a",
      host: "api-a.invalid",
      source: "use_environment",
    });
    const cleared = await s.callToolJson("use_environment", { clear: true });
    expect(cleared.body).toEqual({ pinned: null, cleared: "a" });
    const { result, body } = await s.callToolJson("list_resources", {});
    expect([result.isError, body.code]).toEqual([true, "ambiguous"]);
    const all = JSON.stringify([pinned, cleared]) + s.stderr();
    expect(all.includes(KEY_A) || all.includes(KEY_B)).toBe(false);
  });
});

describe("scenario 2: legacy single environment", () => {
  let s: McpServer;
  beforeAll(async () => {
    s = await boot({
      env: {
        COGNIGY_API_BASE_URL: "https://api-legacy.invalid",
        COGNIGY_API_KEY: KEY_L,
      },
    });
  }, TIMEOUT);

  it("serves environment without an enum and lists one environment named default", async () => {
    const listed = await s.listTools();
    const env = listed.find((t) => t.name === "list_resources")?.inputSchema
      ?.properties?.environment;
    ok(
      env?.type === "string" && !("enum" in env),
      "mcp::legacy_no_enum",
      "Rule: one environment -> environment property without enum",
      "string property, no enum",
      show(env),
      "Only enumerate when more than one environment exists.",
    );
    const { result, body } = await s.callToolJson("list_environments");
    eq(
      [
        body.environments.map((e: { name: string }) => e.name),
        body.environmentArgumentRequired,
      ],
      [["default"], false],
      "mcp::legacy_list",
      "Rule: legacy install is the environment `default`, argument optional",
      "Keep single-environment installs working unchanged.",
    );
    ok(
      !(JSON.stringify(result) + s.stderr()).includes(KEY_L),
      "mcp::legacy_no_leak",
      "Rule: legacy key never leaks",
      "no key text",
      "key found",
      "Keep credentials out of output.",
    );
  });
});

describe("scenario 3: zero environments", () => {
  let s: McpServer;
  beforeAll(async () => {
    s = await boot({ env: {} });
  }, TIMEOUT);

  it("starts, lists tools, and answers calls with the none error", async () => {
    const listed = await s.listTools();
    eq(
      listed.length,
      tools.length + 2,
      "mcp::zero_tools",
      "Rule: tools/list works with no credentials",
      "Serve tools without any configured environment.",
    );
    const { result, body } = await s.callToolJson("list_resources", {});
    ok(
      result.isError === true &&
        body.code === "none" &&
        String(body.error).includes("cognigy-setup profile add"),
      "mcp::zero_none",
      'Rule: code "none" pointing at `cognigy-setup profile add`',
      "isError, code none, hint present",
      show(body),
      "Tell the user how to add an environment.",
    );
  });
});

describe("scenario 4: profiles in the home config file", () => {
  let s: McpServer;
  beforeAll(async () => {
    const home = makeTempHome();
    mkdirSync(join(home, ".cognigy-plugin"), { recursive: true });
    writeFileSync(
      join(home, ".cognigy-plugin", "config.json"),
      JSON.stringify({
        profiles: {
          filep: {
            apiBaseUrl: "https://api-filep.invalid",
            apiKey: KEY_F,
          },
        },
      }),
    );
    s = await boot({ env: {}, home });
  }, TIMEOUT);
  afterAll(async () => {
    // home is caller-owned here; best-effort removal after the server stops
    await s?.close();
    const { rmSync } = await import("fs");
    if (s) rmSync(s.home, { recursive: true, force: true });
  });

  it("list_environments shows the file profile with source file-profile", async () => {
    const { result, body } = await s.callToolJson("list_environments");
    eq(
      body.environments.map((e: { name: string; source: string }) => [
        e.name,
        e.source,
      ]),
      [["filep", "file-profile"]],
      "mcp::file_profile",
      "Rule: the default loader reads profiles from ~/.cognigy-plugin/config.json",
      "Read the home config file when no env profiles exist.",
    );
    ok(
      !(JSON.stringify(result) + s.stderr()).includes(KEY_F),
      "mcp::file_no_leak",
      "Rule: file-profile key never leaks",
      "no key text",
      "key found",
      "Keep credentials out of output.",
    );
  });
});

describe("scenario 5: corrupt config file fails closed", () => {
  let s: McpServer;
  beforeAll(async () => {
    const home = makeTempHome();
    mkdirSync(join(home, ".cognigy-plugin"), { recursive: true });
    writeFileSync(
      join(home, ".cognigy-plugin", "config.json"),
      `{ this is not json ${CORRUPT_MARKER}`,
    );
    s = await boot({ env: profileEnv("C", "api-c", KEY_C), home });
  }, TIMEOUT);
  afterAll(async () => {
    await s?.close();
    const { rmSync } = await import("fs");
    if (s) rmSync(s.home, { recursive: true, force: true });
  });

  it("calls fail with code broken and never echo the file content", async () => {
    const { result, body } = await s.callToolJson("list_resources", {});
    eq(
      [result.isError, body.code],
      [true, "broken"],
      "mcp::corrupt_broken",
      'Rule: unreadable config -> code "broken", fail closed (env profile c not used)',
      "Do not silently ignore a corrupt config file.",
    );
    const all = JSON.stringify(result) + s.stderr();
    ok(
      !all.includes(CORRUPT_MARKER) && !all.includes(KEY_C),
      "mcp::corrupt_no_echo",
      "Rule: neither file content nor keys appear in responses or stderr",
      "no marker, no key",
      "leak found",
      "Describe the problem without quoting the file.",
    );
  });
});
