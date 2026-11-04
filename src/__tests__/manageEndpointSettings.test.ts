import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { manageEndpointTransformer } from "../tools/endpointTransformer.js";
import { ToolHandlers } from "../tools/handlers.js";

const ENDPOINT = "60d5ec49f1a2c8b1a4e0f003";

const CODE =
  "createRestTransformer({ handleOutput: async ({ output }) => output });";

const baseTransformer = () => ({
  transformer: CODE,
  transpiledTransformer: CODE,
  abortOnError: false,
  inputTransformerEnabled: false,
  outputTransformerEnabled: false,
  finalPingTransformerEnabled: false,
});

describe("manage_endpoint_settings transformer", () => {
  let stored: any;
  let api: { get: jest.Mock<any>; patch: jest.Mock<any> };
  let dir: string;
  const prevRoot = process.env.COGNIGY_FILE_ROOT;

  beforeEach(() => {
    stored = {
      _id: ENDPOINT,
      name: "REST",
      channel: "rest",
      transformer: baseTransformer(),
    };
    api = {
      get: jest.fn(async () => structuredClone(stored)),
      // The platform merges a partial transformer block and recompiles when
      // the source is sent (both observed live on the EU trial).
      patch: jest.fn(async (_path: string, body: any) => {
        const next = { ...stored.transformer, ...body.transformer };
        if (body.transformer?.transformer !== undefined) {
          next.transpiledTransformer = body.transformer.transformer;
        }
        stored = { ...stored, transformer: next };
        return {};
      }),
    };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "endpoint-transformer-"));
    process.env.COGNIGY_FILE_ROOT = dir;
  });

  afterAll(() => {
    if (prevRoot === undefined) delete process.env.COGNIGY_FILE_ROOT;
    else process.env.COGNIGY_FILE_ROOT = prevRoot;
  });

  const run = (args: any) => manageEndpointTransformer(api, args);

  it("get returns switches, size and hash but not the code", async () => {
    const r: any = await run({ operation: "get", endpointId: ENDPOINT });
    expect(r.inputTransformerEnabled).toBe(false);
    expect(r.codeBytes).toBe(Buffer.byteLength(CODE));
    expect(JSON.stringify(r)).not.toContain("createRestTransformer");
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("get with saveCodeTo writes the code to a file", async () => {
    const r: any = await run({
      operation: "get",
      endpointId: ENDPOINT,
      saveCodeTo: "code.js",
    });
    expect(r.codeSavedTo.bytes).toBe(Buffer.byteLength(CODE));
    expect(fs.readFileSync(path.join(dir, "code.js"), "utf8")).toBe(CODE);
  });

  it("switches a transformer on and verifies it", async () => {
    const r: any = await run({
      operation: "update",
      endpointId: ENDPOINT,
      inputTransformerEnabled: true,
    });
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0][0]).toBe(`/v2.0/endpoints/${ENDPOINT}`);
    expect(
      (api.patch.mock.calls[0][1] as any).transformer.inputTransformerEnabled,
    ).toBe(true);
    // only the changed field goes out: a concurrent edit of the code survives
    expect((api.patch.mock.calls[0][1] as any).transformer).toEqual({
      inputTransformerEnabled: true,
    });
    expect(r.verified).toBe(true);
    expect(r.changed).toEqual(["inputTransformerEnabled"]);
    expect(r.after.inputTransformerEnabled).toBe(true);
  });

  it("refuses a code change without backupTo and sends nothing", async () => {
    const r: any = await run({
      operation: "update",
      endpointId: ENDPOINT,
      code: "x = 1;",
    });
    expect(r.error).toMatch(/backupTo/);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("puts the previous block back when the platform refuses (it stores refused code anyway)", async () => {
    api.patch.mockImplementation(async (_path: string, body: any) => {
      if (body.transformer.transformer?.includes("BROKEN")) {
        // the platform stores the refused source and empties the executed code
        stored.transformer = {
          ...stored.transformer,
          ...body.transformer,
          transpiledTransformer: "",
        };
        throw new Error("Failed to compile the transformer code");
      }
      stored.transformer = { ...stored.transformer, ...body.transformer };
      return {};
    });
    const r: any = await run({
      operation: "update",
      endpointId: ENDPOINT,
      code: "BROKEN",
      backupTo: "backup.json",
    });
    expect(r.error).toMatch(/platform refused/);
    expect(r.changed).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.backup.path).toBe("backup.json");
    expect(stored.transformer.transformer).toBe(CODE);
    expect(stored.transformer.transpiledTransformer).toBe(CODE);
    expect(api.patch).toHaveBeenCalledTimes(2);
  });

  it("warns loudly when the rollback fails too", async () => {
    api.patch.mockImplementation(async () => {
      throw new Error("down");
    });
    const r: any = await run({
      operation: "update",
      endpointId: ENDPOINT,
      code: "x = 1;",
      backupTo: "backup.json",
    });
    expect(r.rolledBack).toBe(false);
    expect(r._hints.warning).toMatch(/Restore now/);
    expect(r._hints.warning).toContain("backup.code.js");
  });

  it("writes the backup first, then changes the code and keeps the other fields", async () => {
    const newCode =
      "createRestTransformer({ handleOutput: async ({ output }) => ({ ...output, seen: true }) });";
    fs.writeFileSync(path.join(dir, "new.js"), newCode);
    const r: any = await run({
      operation: "update",
      endpointId: ENDPOINT,
      codeFromFile: "new.js",
      backupTo: "backup.json",
      outputTransformerEnabled: true,
    });
    const backup = JSON.parse(
      fs.readFileSync(path.join(dir, "backup.json"), "utf8"),
    );
    expect(backup.transformer.transformer).toBe(CODE);
    // the plain code sits next to the JSON, so it can go back with codeFromFile
    expect(fs.readFileSync(path.join(dir, "backup.code.js"), "utf8")).toBe(
      CODE,
    );
    expect(r.backup.codeFile).toBe("backup.code.js");
    // only the changed fields are sent: no stale executed code, no unrelated switches
    expect((api.patch.mock.calls[0][1] as any).transformer).toEqual({
      transformer: newCode,
      outputTransformerEnabled: true,
    });
    expect(r.verified).toBe(true);
    expect(r.changed).toEqual([
      "outputTransformerEnabled",
      "transformer",
      "transpiledTransformer",
    ]);
  });

  it("restores from the backup's code file with codeFromFile", async () => {
    const newCode =
      "createRestTransformer({ handleOutput: async ({ output }) => ({ ...output, seen: true }) });";
    await run({
      operation: "update",
      endpointId: ENDPOINT,
      code: newCode,
      backupTo: "backup.json",
    });
    expect(stored.transformer.transformer).toBe(newCode);
    const r: any = await run({
      operation: "update",
      endpointId: ENDPOINT,
      codeFromFile: "backup.code.js",
      backupTo: "backup2.json",
    });
    expect(r.verified).toBe(true);
    expect(stored.transformer.transformer).toBe(CODE);
    expect(stored.transformer.transpiledTransformer).toBe(CODE);
  });

  it("names the backup code file next to a backup without .json too", async () => {
    await run({
      operation: "update",
      endpointId: ENDPOINT,
      code: "x = 1;",
      backupTo: "saved",
    });
    expect(fs.existsSync(path.join(dir, "saved.code.js"))).toBe(true);
  });

  it("reports a mismatch when the platform keeps other values", async () => {
    api.patch.mockImplementation(async () => ({}));
    const r: any = await run({
      operation: "update",
      endpointId: ENDPOINT,
      abortOnError: true,
    });
    expect(r.verified).toBe(false);
    expect(r.mismatches).toEqual(["abortOnError"]);
  });

  it("says so when the endpoint has no transformer block", async () => {
    api.get.mockImplementation(async () => ({
      _id: ENDPOINT,
      channel: "a2aServer",
    }));
    const r: any = await run({ operation: "get", endpointId: ENDPOINT });
    expect(r.error).toMatch(/no transformer settings/);
  });

  it("rejects code and codeFromFile together and nothing to change", async () => {
    const both: any = await run({
      operation: "update",
      endpointId: ENDPOINT,
      code: "a",
      codeFromFile: "b",
    });
    expect(both.error).toMatch(/not both/);
    const none: any = await run({ operation: "update", endpointId: ENDPOINT });
    expect(none.error).toMatch(/Nothing to change/);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("is reachable as manage_endpoint_settings", async () => {
    const h = new ToolHandlers(
      api as any,
      "https://endpoint-trial.cognigy.ai",
      "https://webchat-trial.cognigy.ai",
    );
    const r: any = await h.handleToolCall("manage_endpoint_settings", {
      operation: "update_transformer",
      endpointId: ENDPOINT,
      inputTransformerEnabled: true,
    } as any);
    const body: any = r?.content ? JSON.parse(r.content[0].text) : r;
    expect(body.verified).toBe(true);
    expect(
      (api.patch.mock.calls[0][1] as any).transformer.inputTransformerEnabled,
    ).toBe(true);
  });
});
