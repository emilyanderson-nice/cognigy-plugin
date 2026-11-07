/**
 * `voice_call` on list_resources / get_resource: schema rules, the handler wiring,
 * the per-environment client, and that a Voice Gateway key never leaves the
 * dispatcher in an error. Every client is a mock.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { getResourceSchema, listResourcesSchema } from "../schemas/tools.js";
import { ToolHandlers } from "../tools/handlers.js";
import { tools } from "../tools/definitions.js";
import { createRuntimeFactory } from "../server/runtimeFactory.js";
import { loadProfiles } from "../profiles/profiles.js";
import { harness, parse, usable } from "./helpers/dispatchHarness.js";

const SID = "11111111-2222-3333-4444-555555555555";
const TRACE = "0123456789abcdef0123456789abcdef";
const VG_KEY = "vg-account-key-SURFACE-5555";
const P = "COGNIGY_PROFILE_";

describe("list_resources schema: voice_call", () => {
  it("accepts the type with its own filters and needs no projectId", () => {
    const r = listResourcesSchema.safeParse({
      resourceType: "voice_call",
      days: 7,
      direction: "inbound",
      answered: true,
      sipCallId: "abc123@sbc.example.test",
      limit: 10,
      skip: 20,
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ["days 0", { days: 0 }],
    ["days 31", { days: 31 }],
    ["days 1.5", { days: 1.5 }],
    ["direction sideways", { direction: "sideways" }],
    ["answered as text", { answered: "yes" }],
    ["sipCallId with markup", { sipCallId: "<script>" }],
    ["sipCallId too long", { sipCallId: "a".repeat(129) }],
    ["empty sipCallId", { sipCallId: "" }],
  ])("rejects %s", (_label, extra) => {
    expect(
      listResourcesSchema.safeParse({ resourceType: "voice_call", ...extra })
        .success,
    ).toBe(false);
  });

  it.each(["days", "direction", "answered", "sipCallId"])(
    "refuses %s for any other resource type",
    (key) => {
      const value =
        key === "days"
          ? 3
          : key === "answered"
            ? true
            : key === "direction"
              ? "inbound"
              : "abc";
      const r = listResourcesSchema.safeParse({
        resourceType: "project",
        [key]: value,
      });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain(
        `${key} applies only to resourceType 'voice_call'.`,
      );
    },
  );

  it.each(["startDate", "endDate", "sort", "channel", "flowName"])(
    "refuses %s with voice_call instead of ignoring it silently",
    (key) => {
      const value =
        key === "sort" ? "attemptedAt:desc" : "2026-11-01T00:00:00Z";
      const r = listResourcesSchema.safeParse({
        resourceType: "voice_call",
        [key]: value,
      });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain(
        `${key} does not apply to resourceType 'voice_call'; use days.`,
      );
    },
  );
});

describe("get_resource schema: voice_call", () => {
  it("accepts a traceId as the id", () => {
    expect(
      getResourceSchema.safeParse({ resourceType: "voice_call", id: TRACE })
        .success,
    ).toBe(true);
  });

  it("refuses raw: true, because the trace is summarised on purpose", () => {
    const r = getResourceSchema.safeParse({
      resourceType: "voice_call",
      id: TRACE,
      raw: true,
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      "raw does not apply to resourceType 'voice_call'",
    );
  });

  it("refuses the conversation-only options", () => {
    const r = getResourceSchema.safeParse({
      resourceType: "voice_call",
      id: TRACE,
      view: "text",
    });
    expect(r.success).toBe(false);
  });
});

describe("ToolHandlers: voice_call", () => {
  const traceDoc = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: "tts-generation",
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "1200000000",
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  };
  const make = (withVg: boolean) => {
    const apiGet = jest.fn(async (url: string) => {
      if (url === "/v2.0/organisations/voicegateway/account") {
        return { voiceGatewayAccount: SID };
      }
      throw new Error(`unexpected platform call ${url}`);
    });
    const vgGet = jest.fn(async (path: string) =>
      path.includes("/trace/")
        ? traceDoc
        : { total: 1, page_size: "100", page: "1", data: [] },
    );
    const handlers = new ToolHandlers(
      { get: apiGet } as never,
      "https://endpoint.example.test",
      "",
      "",
      withVg ? { get: vgGet } : undefined,
    );
    return { handlers, apiGet, vgGet };
  };

  it("lists calls without a projectId, through the Voice Gateway client", async () => {
    const { handlers, vgGet } = make(true);
    const r = await handlers.handleListResources({
      resourceType: "voice_call",
    });
    expect(r.items).toStrictEqual([]);
    expect(vgGet).toHaveBeenCalledWith(`/Accounts/${SID}/RecentCalls`, {
      page: 1,
      count: 100,
    });
    expect(r._hints?.action).toContain("sipCallId");
  });

  it("reads a call's trace summary by traceId", async () => {
    const { handlers } = make(true);
    const r = await handlers.handleGetResource({
      resourceType: "voice_call",
      id: TRACE,
    });
    expect(r.traceId).toBe(TRACE);
    expect(r.speech.count).toBe(1);
  });

  it("an environment without credentials answers with how to add them, and calls nothing", async () => {
    const { handlers, apiGet, vgGet } = make(false);
    const r = await handlers.handleListResources({
      resourceType: "voice_call",
    });
    expect(r.error).toBe(
      "Voice Gateway is not configured for this environment.",
    );
    expect(r._hints?.action).toContain("--voice-gateway-url");
    expect(apiGet).not.toHaveBeenCalled();
    expect(vgGet).not.toHaveBeenCalled();
  });
});

describe("createRuntimeFactory: the Voice Gateway client", () => {
  const file = (extra: Record<string, string> = {}) =>
    loadProfiles({
      fileProfiles: {
        profiles: {
          dev: {
            apiBaseUrl: "https://api-dev.cognigy.ai",
            apiKey: "cognigy-key-FACTORY-1",
            ...extra,
          },
        },
        problems: [],
      },
    }).profiles[0];

  it("hands the handlers a client when the profile has Voice Gateway credentials", () => {
    const createHandlers = jest.fn(() => ({
      handleToolCall: async () => ({}),
    }));
    createRuntimeFactory({
      auditAttribution: true,
      createClient: () => ({}),
      createHandlers,
      logProxy: () => undefined,
    })(
      file({
        voiceGatewayBaseUrl: "https://api-vg-dev.example.test",
        voiceGatewayApiKey: VG_KEY,
      }),
    );
    const calls = createHandlers.mock.calls as unknown[][];
    expect(calls[0]).toHaveLength(5);
    expect(typeof (calls[0][4] as { get: unknown }).get).toBe("function");
  });

  it("passes no fifth argument without credentials", () => {
    const createHandlers = jest.fn(() => ({
      handleToolCall: async () => ({}),
    }));
    createRuntimeFactory({
      auditAttribution: true,
      createClient: () => ({}),
      createHandlers,
      logProxy: () => undefined,
    })(file());
    expect((createHandlers.mock.calls as unknown[][])[0]).toHaveLength(4);
  });
});

describe("dispatcher: the Voice Gateway key in an error", () => {
  it("is removed from the message, the logs and the result", async () => {
    const set = loadProfiles({
      env: {
        ...usable("DEV", "cognigy-key-DISPATCH-1"),
        [`${P}DEV_VOICE_GATEWAY_BASE_URL`]: "https://api-vg-dev.example.test",
        [`${P}DEV_VOICE_GATEWAY_API_KEY`]: VG_KEY,
      },
    });
    const h = harness({
      set,
      impl: {
        dev: async () => {
          throw Object.assign(new Error(`upstream said ${VG_KEY} is invalid`), {
            code: VG_KEY,
          });
        },
      },
    });
    const result = await h.dispatcher.callTool("alpha", {});
    const text = result.content[0].text;
    expect(text).not.toContain(VG_KEY);
    expect(parse(result).error).toContain("upstream said");
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain(VG_KEY);
  });
});

describe("tool definitions: voice_call", () => {
  const def = (name: string) => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`${name} missing`);
    return found;
  };
  const props = (name: string) =>
    (def(name).inputSchema as { properties: Record<string, any> }).properties;

  it("list_resources offers voice_call and documents its four filters as voice_call only", () => {
    const list = props("list_resources");
    expect(list.resourceType.enum).toContain("voice_call");
    for (const key of ["days", "direction", "answered", "sipCallId"]) {
      expect(list[key]).toBeDefined();
      expect(list[key].description).toMatch(/^voice_call only/);
    }
    expect(def("list_resources").description).toContain("voice_call");
  });

  it("get_resource offers voice_call and says the id is a traceId", () => {
    const get = props("get_resource");
    expect(get.resourceType.enum).toContain("voice_call");
    expect(get.id.description).toContain("traceId");
    expect(def("get_resource").description).toContain("voice_call");
  });

  it("the definition enums and the schema enums agree on voice_call", () => {
    const listEnum: string[] = props("list_resources").resourceType.enum;
    const getEnum: string[] = props("get_resource").resourceType.enum;
    expect(listEnum.includes("voice_call")).toBe(
      listResourcesSchema.safeParse({ resourceType: "voice_call" }).success,
    );
    expect(getEnum.includes("voice_call")).toBe(
      getResourceSchema.safeParse({ resourceType: "voice_call", id: "x" })
        .success,
    );
  });
});
