import { describe, it, expect, beforeEach } from "@jest/globals";
import { ToolHandlers } from "../tools/handlers.js";
import { manageSettingsSchema } from "../schemas/tools.js";
import { ID, check, mockApi } from "./helpers/endpointFixtures.js";

// K3: manage_settings { operation: "get_knowledge_ai" } reads Knowledge AI settings.
describe("manage_settings get_knowledge_ai (K3)", () => {
  let api: any;
  let h: InstanceType<typeof ToolHandlers>;
  const PATH = `/v2.0/projects/${ID.project}/settings`;

  beforeEach(() => {
    api = mockApi();
    h = new ToolHandlers(
      api,
      "https://endpoint-trial.cognigy.ai",
      "",
      "https://static-trial.cognigy.ai",
    );
    (h as any).backupDeclinedForProject.add(ID.project);
  });

  const read = () =>
    h.handleToolCall("manage_settings", {
      operation: "get_knowledge_ai",
      projectId: ID.project,
    });

  it("GETs the project settings once and returns the exact field-by-field shape", async () => {
    api.get.mockResolvedValueOnce({
      knowledgeAISettings: {
        fileExtractor: "azure",
        azureDIConnectionId: "conn-1",
      },
      generativeAISettings: {
        enabled: true,
        useCasesSettings: { knowledgeSearch: { modelId: "m1", on: false } },
      },
    });

    const result = await read();

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(PATH);
    expect(api.patch).not.toHaveBeenCalled();
    expect(result).toEqual({
      projectId: ID.project,
      knowledgeAI: { fileExtractor: "azure", azureDIConnectionId: "conn-1" },
      generativeAI: {
        enabled: true,
        useCasesSettings: { knowledgeSearch: { modelId: "m1", on: false } },
      },
    });
    expect(Object.keys(result)).toEqual([
      "projectId",
      "knowledgeAI",
      "generativeAI",
    ]);
    expect(Object.keys(result.knowledgeAI)).toEqual([
      "fileExtractor",
      "azureDIConnectionId",
    ]);
    expect(Object.keys(result.generativeAI)).toEqual([
      "enabled",
      "useCasesSettings",
    ]);
  });

  it("omits undefined values and keeps false", async () => {
    api.get.mockResolvedValueOnce({
      knowledgeAISettings: { fileExtractor: "default" },
      generativeAISettings: { enabled: false },
    });

    const result = await read();

    expect(result).toEqual({
      projectId: ID.project,
      knowledgeAI: { fileExtractor: "default" },
      generativeAI: { enabled: false },
    });
    expect("azureDIConnectionId" in result.knowledgeAI).toBe(false);
    expect("useCasesSettings" in result.generativeAI).toBe(false);
  });

  it("returns no settings values when the platform has none", async () => {
    api.get.mockResolvedValueOnce({});

    const result = await read();

    expect(result.projectId).toBe(ID.project);
    expect(result.knowledgeAI ?? {}).toEqual({});
    expect(result.generativeAI ?? {}).toEqual({});
  });

  it("returns no other settings keys (nothing leaks)", async () => {
    api.get.mockResolvedValueOnce({
      timezone: "Europe/Berlin",
      audioPreviewSettings: { provider: "microsoft", secretRef: "S3CR3T" },
      someToken: "LEAK_SENTINEL",
      knowledgeAISettings: {
        fileExtractor: "default",
        extraInner: "LEAK_INNER",
      },
      generativeAISettings: { enabled: true, extraGen: "LEAK_GEN" },
    });

    const result = await read();

    expect(Object.keys(result).sort()).toEqual([
      "generativeAI",
      "knowledgeAI",
      "projectId",
    ]);
    expect(Object.keys(result.knowledgeAI)).toEqual(["fileExtractor"]);
    expect(Object.keys(result.generativeAI)).toEqual(["enabled"]);
    const json = JSON.stringify(result);
    for (const leak of [
      "Europe/Berlin",
      "S3CR3T",
      "LEAK_SENTINEL",
      "LEAK_INNER",
      "LEAK_GEN",
    ]) {
      check(!json.includes(leak), {
        what: "get_knowledge_ai leaked a field outside the allowlist",
        why: "output is built field by field from the four documented fields only",
        expected: "no other settings values in the output",
        actual: `output contains an unlisted value (${leak.slice(0, 4)}...)`,
        guidance:
          "copy only the named fields; never spread the settings object",
      });
    }
  });

  describe("useCasesSettings is copied as a JSON-safe plain-object tree limited to depth 4", () => {
    const withUseCases = async (useCasesSettings: unknown) => {
      api.get.mockResolvedValueOnce({
        generativeAISettings: { enabled: true, useCasesSettings },
      });
      return read();
    };

    it("copies shallow trees (3 nested levels, arrays of primitives) by value into new objects", async () => {
      const upstream = { a: { b: { c: 1 }, list: [1, "x", true] } };

      const result = await withUseCases(upstream);

      expect(result.generativeAI.useCasesSettings).toEqual({
        a: { b: { c: 1 }, list: [1, "x", true] },
      });
      expect(result.generativeAI.useCasesSettings).not.toBe(upstream);
      expect(result.generativeAI.useCasesSettings.a).not.toBe(upstream.a);
    });

    it("drops functions and non-plain values but keeps plain siblings", async () => {
      class Weird {
        v = 1;
      }
      const result = await withUseCases({
        keep: "yes",
        fn: () => 1,
        inst: new Weird(),
        when: new Date(0),
        sym: Symbol("s"),
        inner: { keep: 2, fn: () => 2 },
      });

      const ucs = result.generativeAI.useCasesSettings;
      expect(ucs.keep).toBe("yes");
      expect("fn" in ucs).toBe(false);
      expect("inst" in ucs).toBe(false);
      expect("when" in ucs).toBe(false);
      expect("sym" in ucs).toBe(false);
      expect(ucs.inner).toEqual({ keep: 2 });
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("pins the depth boundary: useCasesSettings is depth 0, depth 4 survives, depth 5 is dropped", async () => {
      const result = await withUseCases({
        l1: {
          l2: {
            l3: { p4: "P4", l4: { p5: "DROP_P5", l5: { l6: "DROP_L6" } } },
          },
        },
      });

      const l3 = result.generativeAI.useCasesSettings.l1.l2.l3;
      expect(l3.p4).toBe("P4");
      expect(l3.l4 ?? {}).toEqual({});
      const json = JSON.stringify(result);
      check(!json.includes("DROP_"), {
        what: "a value deeper than depth 4 was copied",
        why: "useCasesSettings is depth 0; keys at depth 4 are kept, keys at depth 5 are dropped",
        expected:
          "l1.l2.l3.p4 kept (depth 4); l4.p5 and l4.l5 (depth 5) absent",
        actual: "a depth-5 value is present in the output",
        guidance: "stop copying below depth 4",
      });
    });
  });

  it("propagates API errors instead of returning settings", async () => {
    api.get.mockRejectedValueOnce(new Error("boom-settings"));

    let outcome: any;
    let thrown = "";
    try {
      outcome = await read();
    } catch (e: any) {
      thrown = String(e.message);
    }

    const surfaced =
      thrown.includes("boom-settings") ||
      String(outcome?.error ?? "").includes("boom-settings");
    check(surfaced && !outcome?.knowledgeAI, {
      what: "get_knowledge_ai swallowed an API error",
      why: "errors propagate as for the other manage_settings operations",
      expected:
        "a thrown error (or error body) mentioning the upstream message, no knowledgeAI",
      actual: "the error was not surfaced or settings were returned",
      guidance: "do not catch and blank the failure",
    });
  });
});

describe("manageSettingsSchema get_knowledge_ai (K3)", () => {
  it("accepts operation + projectId", () => {
    const parsed: any = manageSettingsSchema.parse({
      operation: "get_knowledge_ai",
      projectId: ID.project,
    });
    expect(parsed.operation).toBe("get_knowledge_ai");
    expect(parsed.projectId).toBe(ID.project);
  });

  it("requires projectId", () => {
    expect(() =>
      manageSettingsSchema.parse({ operation: "get_knowledge_ai" }),
    ).toThrow();
  });

  it("rejects a malformed projectId", () => {
    expect(() =>
      manageSettingsSchema.parse({
        operation: "get_knowledge_ai",
        projectId: "nope",
      }),
    ).toThrow();
  });
});
