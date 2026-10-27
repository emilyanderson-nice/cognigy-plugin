/**
 * Wiring tests for list_resources { resourceType: "log" }: schema, tool
 * definitions, handler delegation, dispatcher-wrapped output and always-on
 * instructions. The pure modules (logScrub, logSummary, logReader) have their
 * own tests; here the upstream client is mocked and only the wiring is checked.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { CognigyApiClient } from "../api/client.js";
import {
  listResourcesSchema,
  getResourceSchema,
  deleteResourceSchema,
  LOG_LEVELS,
} from "../schemas/tools.js";
import { tools } from "../tools/definitions.js";
import { ToolHandlers } from "../tools/handlers.js";
import { SERVER_INSTRUCTIONS } from "../instructions.js";
import { readRepo } from "./helpers/docText.js";
import {
  KEY_A,
  harness,
  parse,
  setOf,
  tool,
  usable,
} from "./helpers/dispatchHarness.js";

import {
  SENTINEL_TEXT,
  SENTINEL_TOKEN,
  SENTINEL_ERR,
  expectExact,
  clientError,
} from "./helpers/logFixtures.js";

const PROJECT_ID = "507f1f77bcf86cd799439011";
const SENTINEL_ERROR = "SENTINEL_UPSTREAM_DETAIL_7203";

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"];
const parseList = (o: Record<string, unknown>) =>
  listResourcesSchema.safeParse({
    resourceType: "log",
    projectId: PROJECT_ID,
    ...o,
  });

const upstreamItem = () => ({
  _id: "60d5ec49f1a2c8b1a4e0f0a1",
  timestamp: "2026-10-23T10:00:00.000Z",
  msg: "Something failed",
  type: "error",
  traceId: "trace-1",
  meta: {
    flowId: "60d5ec49f1a2c8b1a4e0f0b1",
    channel: "webchat",
    text: SENTINEL_TEXT,
    URLToken: SENTINEL_TOKEN,
    nested: { URLToken: SENTINEL_TOKEN, text: SENTINEL_TEXT },
  },
});

describe("log wiring: schema", () => {
  it("accepts resourceType log with every new filter", () => {
    const r = parseList({
      logLevel: ["error", "warn"],
      search: "timeout",
      flowName: "Main",
      sessionId: "session-1",
      view: "entries",
    });
    expect(r.success).toBe(true);
  });

  it.each(LEVELS)("accepts logLevel %s", (level) => {
    expect(parseList({ logLevel: [level] }).success).toBe(true);
  });

  it.each(["summary", "entries"])("accepts view %s", (view) => {
    expect(parseList({ view }).success).toBe(true);
  });

  it("rejects an empty logLevel array", () => {
    expect(parseList({ logLevel: [] }).success).toBe(false);
  });

  it("rejects an unknown log level", () => {
    expect(parseList({ logLevel: ["critical"] }).success).toBe(false);
  });

  it("rejects an unknown view", () => {
    expect(parseList({ view: "raw" }).success).toBe(false);
  });

  it.each([
    ["search", 200],
    ["flowName", 100],
    ["sessionId", 128],
  ])(
    "%s: empty rejected, max length %i accepted, one more rejected",
    (k, max) => {
      expect(parseList({ [k]: "" }).success).toBe(false);
      expect(parseList({ [k]: "a".repeat(max) }).success).toBe(true);
      expect(parseList({ [k]: "a".repeat(max + 1) }).success).toBe(false);
    },
  );

  it("get_resource rejects log", () => {
    expect(
      getResourceSchema.safeParse({ resourceType: "log", id: "x" }).success,
    ).toBe(false);
  });

  it("delete_resource rejects log", () => {
    expect(
      deleteResourceSchema.safeParse({
        resourceType: "log",
        id: PROJECT_ID,
        projectId: PROJECT_ID,
      }).success,
    ).toBe(false);
  });
});

describe("log wiring: tool definitions", () => {
  const def = (name: string) => tools.find((t) => t.name === name) as any;

  it("list_resources advertises log in its resourceType enum", () => {
    expect(
      def("list_resources").inputSchema.properties.resourceType.enum,
    ).toContain("log");
  });

  it("get_resource and delete_resource do not advertise log", () => {
    expect(
      def("get_resource").inputSchema.properties.resourceType.enum,
    ).not.toContain("log");
    expect(
      def("delete_resource").inputSchema.properties.resourceType.enum,
    ).not.toContain("log");
  });

  it.each(["logLevel", "search", "flowName", "sessionId", "view"])(
    "list_resources declares %s and says it is log-only",
    (prop) => {
      const p = def("list_resources").inputSchema.properties[prop];
      expect(p).toBeDefined();
      expect(String(p.description)).toMatch(/log/i);
    },
  );

  it("logLevel enum in the definition is exactly the six levels", () => {
    const p = def("list_resources").inputSchema.properties.logLevel;
    expect([...p.items.enum].sort()).toEqual([...LEVELS].sort());
  });

  it("logLevel enum in the definition equals LOG_LEVELS from the schema module, in order (A13)", () => {
    const p = def("list_resources").inputSchema.properties.logLevel;
    expectExact([p.items.enum, [...LOG_LEVELS]], [LEVELS, LEVELS], {
      what: "definitions.ts logLevel items.enum vs LOG_LEVELS",
      why: "A13: definitions.ts imports LOG_LEVELS instead of repeating the six levels, so the two can never drift",
      fix: "use enum: [...LOG_LEVELS] in the list_resources definition; LOG_LEVELS = fatal, error, warn, info, debug, trace",
    });
  });

  it("view enum in the definition is summary and entries", () => {
    const p = def("list_resources").inputSchema.properties.view;
    expect([...p.enum].sort()).toEqual(["entries", "summary"]);
  });

  it("the log feature adds no tool; the tool count is 20 with manage_intents", () => {
    expect(tools.length).toBe(20);
  });
});

describe("log wiring: handler", () => {
  let api: jest.Mocked<CognigyApiClient>;
  let h: ToolHandlers;

  beforeEach(() => {
    api = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      put: jest.fn(),
      uploadFile: jest.fn(),
    } as any;
    h = new ToolHandlers(
      api,
      "https://endpoint-trial.cognigy.ai",
      "",
      "https://static-trial.cognigy.ai",
    );
  });

  it("hits GET /v2.1/projects/<id>/logs and returns a summary without an items key", async () => {
    api.get.mockResolvedValue({ items: [upstreamItem()], total: 1 } as never);

    const result = await h.handleToolCall("list_resources", {
      resourceType: "log",
      projectId: PROJECT_ID,
    });

    expect(api.get.mock.calls[0][0]).toBe(`/v2.1/projects/${PROJECT_ID}/logs`);
    expect(result.view).toBe("summary");
    expect(result.sampled).toBe(1);
    expect(result.total).toBe(1);
    expect(result).not.toHaveProperty("items");
    expect(result._hints?.action).toMatch(/24 hours/);
  });

  it("returns the entries view body with scrubbed entries and no items key", async () => {
    api.get.mockResolvedValue({ items: [upstreamItem()], total: 1 } as never);

    const result = await h.handleToolCall("list_resources", {
      resourceType: "log",
      projectId: PROJECT_ID,
      view: "entries",
      limit: 10,
    });

    expect(api.get.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        params: expect.objectContaining({ limit: 10, sort: "timestamp:desc" }),
      }),
    );
    expect(result.view).toBe("entries");
    expect(result.returned).toBe(1);
    expect(result.entries[0]).toEqual({
      timestamp: "2026-10-23T10:00:00.000Z",
      level: "error",
      msg: "Something failed",
      flowId: "60d5ec49f1a2c8b1a4e0f0b1",
      channel: "webchat",
      traceId: "trace-1",
    });
    expect(result).not.toHaveProperty("items");
  });

  it("requires projectId for log with the same error style as other project-scoped types", async () => {
    const result = await h.handleToolCall("list_resources", {
      resourceType: "log",
    });

    expect(result.error).toBe("projectId is required for resourceType 'log'.");
    expect(api.get).not.toHaveBeenCalled();
  });

  it.each(["summary", "entries"])(
    "never outputs user text or URL tokens (view %s)",
    async (view) => {
      api.get.mockResolvedValue({ items: [upstreamItem()], total: 1 } as never);

      const result = await h.handleToolCall("list_resources", {
        resourceType: "log",
        projectId: PROJECT_ID,
        view,
      });

      const json = JSON.stringify(result);
      expect(json).not.toContain(SENTINEL_TEXT);
      expect(json).not.toContain(SENTINEL_TOKEN);
    },
  );

  it("an orchestrator error (start after end) is returned as a body with an error string, not thrown, and the API is not called (A11)", async () => {
    await expect(
      h.handleToolCall("list_resources", {
        resourceType: "log",
        projectId: PROJECT_ID,
        startDate: "2026-10-23T12:00:00.000Z",
        endDate: "2026-10-23T10:00:00.000Z",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/\S/) }),
    );
    expect(api.get).not.toHaveBeenCalled();
  });

  it("a client-shaped failure (plain Error with .status, no .response) returns status 403 with fixed text and no leak (A9)", async () => {
    api.get.mockRejectedValue(clientError(403) as never);
    const result = await h.handleToolCall("list_resources", {
      resourceType: "log",
      projectId: PROJECT_ID,
    });
    expectExact(
      [
        result.status,
        typeof result.error,
        JSON.stringify(result).includes(SENTINEL_ERR),
      ],
      [403, "string", false],
      {
        what: "handler result for a client-shaped 403",
        why: "A9: the real client rejects with a plain Error carrying .status; the reader must read it and output only fixed text",
        fix: "derive status from err.response?.status else err.status and never output the error message",
      },
    );
  });

  it("does not throw or leak upstream error text when the platform call fails", async () => {
    api.get.mockRejectedValue(
      Object.assign(new Error(SENTINEL_ERROR), {
        response: {
          status: 500,
          data: { detail: SENTINEL_ERROR, title: SENTINEL_ERROR },
        },
      }) as never,
    );

    const result = await h.handleToolCall("list_resources", {
      resourceType: "log",
      projectId: PROJECT_ID,
    });

    expect(typeof result.error).toBe("string");
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });
});

describe("log wiring: dispatcher-wrapped output", () => {
  const build = (get: jest.Mock<(...a: any[]) => Promise<any>>) => {
    const api = { get } as unknown as CognigyApiClient;
    const handlers = new ToolHandlers(
      api,
      "https://endpoint-a.cognigy.ai",
      "",
      "https://static-a.cognigy.ai",
    );
    return harness({
      set: setOf(usable("A", KEY_A)),
      tools: [tool("list_resources")],
      impl: { a: (n, a) => handlers.handleToolCall(n, a) },
    });
  };

  it.each(["summary", "entries"])(
    "sentinels and the API key are absent from the wrapped result (view %s)",
    async (view) => {
      const get = jest.fn<(...a: any[]) => Promise<any>>(async () => ({
        items: [upstreamItem()],
        total: 1,
      }));
      const h = build(get);

      const r = await h.dispatcher.callTool("list_resources", {
        resourceType: "log",
        projectId: PROJECT_ID,
        view,
      });

      const text = r.content[0].text;
      expect(text).not.toContain(SENTINEL_TEXT);
      expect(text).not.toContain(SENTINEL_TOKEN);
      expect(text).not.toContain(KEY_A);
      expect(parse(r)).toHaveProperty("_environment");
    },
  );

  it("sentinels and the API key are absent from the wrapped result on an upstream error", async () => {
    const get = jest.fn<(...a: any[]) => Promise<any>>(async () => {
      throw Object.assign(new Error(`${SENTINEL_ERROR} ${KEY_A}`), {
        response: {
          status: 403,
          data: { detail: SENTINEL_ERROR, title: SENTINEL_ERROR },
        },
      });
    });
    const h = build(get);

    const r = await h.dispatcher.callTool("list_resources", {
      resourceType: "log",
      projectId: PROJECT_ID,
    });

    const text = r.content[0].text;
    expect(text).not.toContain(SENTINEL_ERROR);
    expect(text).not.toContain(KEY_A);
  });
});

// SERVER_INSTRUCTIONS is capped at 2000 characters (toolSurfaceBudget), so the
// route to the logs is carried by the list_resources description (every session)
// and the troubleshooting skill (recipe, on intent).
describe("log wiring: where the model learns the log route", () => {
  it("the list_resources description names the log type and the troubleshooting skill", () => {
    const d = String(
      (tools.find((t) => t.name === "list_resources") as any).description,
    );
    expect(d).toMatch(/\blog \(read-only project logs/);
    expect(d).toContain("troubleshooting skill");
  });

  it('the troubleshooting skill shows list_resources with resourceType: "log"', () => {
    expect(readRepo("plugin/skills/troubleshooting/SKILL.md")).toContain(
      'list_resources { resourceType: "log"',
    );
  });

  it("the always-on instructions stay within their cap without the log recipe", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
  });
});
