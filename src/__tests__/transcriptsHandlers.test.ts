/**
 * Conversation transcripts through the schemas and ToolHandlers
 * (list_resources and get_resource with resourceType "conversation"). The api
 * client is a mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { CognigyApiClient } from "../api/client.js";
import { ToolHandlers } from "../tools/handlers.js";
import { RESOURCE_FILTERS } from "../tools/filters.js";
import { listResourcesSchema, getResourceSchema } from "../schemas/tools.js";

const PROJECT = "507f1f77bcf86cd799439011";
const SESSION = "session-abc";

const listRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  _id: `session-${n}`,
  channel: "webchat",
  flowName: "Main",
  startTime: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
  endTime: new Date(Date.UTC(2026, 9, 1, 0, 5, n)).toISOString(),
  messages: 4,
  projectId: PROJECT,
  projectName: "Secret Project Name",
  endpointName: "Endpoint A",
  ratings: [],
  rating: null,
  ratingComments: ["RATING-COMMENT-SECRET"],
  ratingComment: "RATING-COMMENT-SECRET",
  contactId: "CONTACT-SECRET",
  endpointUrlToken: "TOKEN-SECRET",
  ...overrides,
});

const messageItem = (n: number, overrides: Record<string, unknown> = {}) => ({
  _id: `msg-${n}`,
  projectId: PROJECT,
  sessionId: SESSION,
  contactId: "CONTACT-SECRET",
  organisation: "ORGANISATION-SECRET",
  inputText: `ZEBRA-SECRET-TEXT ${n}`,
  inputData: { k: "INPUTDATA-SECRET" },
  type: n % 2 === 1 ? "input" : "output",
  source: n % 2 === 1 ? "user" : "bot",
  timestamp: new Date(Date.UTC(2026, 9, 1, 10, 0, n)).toISOString(),
  flowName: "Main",
  channel: "webchat",
  endpointUrlToken: "TOKEN-SECRET",
  endpointName: "Endpoint A",
  ...overrides,
});

describe("conversation transcripts through ToolHandlers", () => {
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

  describe("list_resources { resourceType: conversation }", () => {
    it("delegates: one request with only projectId, plugin-side filter, sort and paging", async () => {
      api.get.mockResolvedValue({
        items: [
          listRow(1),
          listRow(3),
          listRow(2, { channel: "voice" }),
          listRow(4),
        ],
        total: 4,
      } as never);

      const result = await h.handleListResources({
        resourceType: "conversation",
        projectId: PROJECT,
        channel: "webchat",
        limit: 2,
        skip: 0,
        startDate: "2026-10-01T00:00:00.000Z",
      });

      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.get).toHaveBeenCalledWith("/v2.0/conversations", {
        params: { projectId: PROJECT },
      });
      expect(result.items.map((i: any) => i.sessionId)).toEqual([
        "session-4",
        "session-3",
      ]);
      expect(result.total).toBe(3);
      expect(result.skip).toBe(0);
      expect(result.limit).toBe(2);
      expect(result._hints.action).toContain("skip: 2");
    });

    it("no longer forwards limit, skip, sort, startDate, endDate or channel to the platform", async () => {
      api.get.mockResolvedValue({ items: [], total: 0 } as never);

      await h.handleListResources({
        resourceType: "conversation",
        projectId: PROJECT,
        limit: 10,
        skip: 5,
        sort: "startTime:desc",
        startDate: "2026-10-01",
        endDate: "2026-10-02",
        channel: "webchat",
      });

      const params = (api.get.mock.calls[0][1] as any).params;
      expect(params).toEqual({ projectId: PROJECT });
      expect(Object.keys(params)).toEqual(["projectId"]);
    });

    it("passes contactIds to the platform and minMessages / flowName to the plugin filter", async () => {
      api.get.mockResolvedValue({
        items: [
          listRow(1, { messages: 1 }),
          listRow(2, { messages: 6 }),
          listRow(3, { messages: 6, flowName: "Other" }),
        ],
      } as never);

      const result = await h.handleListResources({
        resourceType: "conversation",
        projectId: PROJECT,
        contactIds: ["c1"],
        minMessages: 5,
        flowName: "Main",
      });

      expect(api.get).toHaveBeenCalledWith("/v2.0/conversations", {
        params: { projectId: PROJECT, contactIds: ["c1"] },
      });
      expect(result.items.map((i: any) => i.sessionId)).toEqual(["session-2"]);
    });

    it("returns the item shape and never an upstream extra key", async () => {
      api.get.mockResolvedValue({ items: [listRow(1)] } as never);

      const result = await h.handleListResources({
        resourceType: "conversation",
        projectId: PROJECT,
      });

      expect(Object.keys(result.items[0])).toEqual([
        "sessionId",
        "channel",
        "flowName",
        "endpointName",
        "startTime",
        "endTime",
        "messages",
        "rating",
      ]);
      const text = JSON.stringify(result);
      for (const secret of [
        "CONTACT-SECRET",
        "TOKEN-SECRET",
        "RATING-COMMENT-SECRET",
        "Secret Project Name",
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it("an empty result carries the no-match hint", async () => {
      api.get.mockResolvedValue({ items: [] } as never);
      const result = await h.handleListResources({
        resourceType: "conversation",
        projectId: PROJECT,
      });
      expect(result.total).toBe(0);
      expect(result._hints.action.toLowerCase()).toContain(
        "no conversation matched",
      );
    });

    it("still answers a missing projectId with the generic error and no request", async () => {
      const result = await h.handleListResources({
        resourceType: "conversation",
      });
      expect(result.error).toBe(
        "projectId is required for resourceType 'conversation'.",
      );
      expect(api.get).not.toHaveBeenCalled();
    });

    it("an unparseable startDate is refused before any request", async () => {
      await expect(
        h.handleListResources({
          resourceType: "conversation",
          projectId: PROJECT,
          startDate: "not a date",
        }),
      ).rejects.toThrow("startDate must be an ISO 8601 date or datetime.");
      expect(api.get).not.toHaveBeenCalled();
    });

    it("does not echo a platform error", async () => {
      api.get.mockRejectedValue(
        Object.assign(new Error("UPSTREAM-SECRET-ERROR-TEXT"), { status: 500 }),
      );
      const err = await h
        .handleListResources({
          resourceType: "conversation",
          projectId: PROJECT,
        })
        .catch((e: any) => e);
      expect(err.message).toBe("Could not read conversations (HTTP 500).");
    });

    it("other resource types still forward their paging to the platform", async () => {
      api.get.mockResolvedValue({ items: [], total: 0 } as never);
      await h.handleListResources({
        resourceType: "agent",
        projectId: PROJECT,
        limit: 7,
        skip: 3,
      });
      expect(api.get).toHaveBeenCalledWith("/v2.0/aiagents", {
        params: { projectId: PROJECT, limit: 7, skip: 3 },
      });
    });
  });

  describe("get_resource { resourceType: conversation }", () => {
    it("delegates to the outline view by default", async () => {
      api.get.mockResolvedValue({
        items: [messageItem(1), messageItem(2)],
        total: 2,
      } as never);

      const result = await h.handleGetResource({
        resourceType: "conversation",
        id: SESSION,
        projectId: PROJECT,
      });

      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.get).toHaveBeenCalledWith("/v2.0/conversations/session-abc", {
        params: { projectId: PROJECT },
      });
      expect(result.view).toBe("outline");
      expect(result.messageCount).toBe(2);
      expect(result.bySource).toEqual({ user: 1, bot: 1 });
      expect(result.messages.map((m: any) => m.textChars)).toEqual([19, 19]);
      expect(result._hints.action).toContain('view: "text"');
      const text = JSON.stringify(result);
      for (const secret of [
        "ZEBRA",
        "TOKEN-SECRET",
        "CONTACT-SECRET",
        "ORGANISATION-SECRET",
        "INPUTDATA-SECRET",
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it("passes view, msgChars, limit, skip and expertMode to the reader", async () => {
      api.get.mockResolvedValue({
        items: [1, 2, 3, 4].map((n) =>
          messageItem(n, { inputText: "word ".repeat(100) }),
        ),
      } as never);

      const result = await h.handleGetResource({
        resourceType: "conversation",
        id: SESSION,
        view: "text",
        msgChars: 100,
        limit: 2,
        skip: 1,
        expertMode: true,
      });

      expect(api.get).toHaveBeenCalledWith("/v2.0/conversations/session-abc", {
        params: { expertMode: true },
      });
      expect(result.view).toBe("text");
      expect(result.skip).toBe(1);
      expect(result.limit).toBe(2);
      expect(result.returned).toBe(2);
      expect(result.messages.map((m: any) => m.index)).toEqual([1, 2]);
      expect(result.messages[0].text.length).toBe(100);
      expect(result._hints.action.toLowerCase()).toContain("personal data");
    });

    it("rawText with the default outline view is refused before any request", async () => {
      await expect(
        h.handleGetResource({
          resourceType: "conversation",
          id: SESSION,
          rawText: true,
        }),
      ).rejects.toThrow("rawText is only supported with view text.");
      expect(api.get).not.toHaveBeenCalled();
    });

    it("rawText with view text returns unmasked text and the warning", async () => {
      api.get.mockResolvedValue({
        items: [messageItem(1, { inputText: "mail jane@example.com" })],
      } as never);
      const result = await h.handleGetResource({
        resourceType: "conversation",
        id: SESSION,
        view: "text",
        rawText: true,
      });
      expect(result.messages[0].text).toBe("mail jane@example.com");
      expect(result._hints.warning.toLowerCase()).toContain("unmasked");
    });

    it("an unknown session gives the no-messages hint", async () => {
      api.get.mockResolvedValue({ items: [], total: 0 } as never);
      const result = await h.handleGetResource({
        resourceType: "conversation",
        id: SESSION,
      });
      expect(result.sessionId).toBe(SESSION);
      expect(result.messageCount).toBe(0);
      expect(result._hints.action.toLowerCase()).toContain(
        "no messages were found",
      );
    });

    it("does not echo a platform error", async () => {
      api.get.mockRejectedValue(new Error("UPSTREAM-SECRET-ERROR-TEXT"));
      const err = await h
        .handleGetResource({ resourceType: "conversation", id: SESSION })
        .catch((e: any) => e);
      expect(err.message).toBe("Could not read conversation.");
    });

    it("raw: true keeps the raw path (one argument) and strips endpointUrlToken", async () => {
      const upstream = {
        items: [messageItem(1), messageItem(2)],
        total: 2,
      };
      api.get.mockResolvedValue(upstream as never);

      const result = await h.handleGetResource({
        resourceType: "conversation",
        id: SESSION,
        raw: true,
      });

      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.get.mock.calls[0]).toEqual([
        "/v2.0/conversations/session-abc",
      ]);
      expect(result.total).toBe(2);
      expect(result.items.length).toBe(2);
      expect(result.items[0].inputText).toBe("ZEBRA-SECRET-TEXT 1");
      expect(result.items[0].contactId).toBe("CONTACT-SECRET");
      expect(JSON.stringify(result)).not.toContain("TOKEN-SECRET");
      expect(JSON.stringify(result)).not.toContain("endpointUrlToken");
      expect(result.messages).toBeUndefined();
    });
  });

  describe("RESOURCE_FILTERS.conversation", () => {
    it("does not map field names the platform does not have", () => {
      const out = RESOURCE_FILTERS.conversation?.(listRow(1)) ?? {};
      expect(Object.keys(out)).not.toContain("startedAt");
      expect(Object.keys(out)).not.toContain("messageCount");
    });
  });
});

describe("listResourcesSchema: conversation filters", () => {
  const parse = (extra: Record<string, unknown>) =>
    listResourcesSchema.safeParse({
      resourceType: "conversation",
      projectId: PROJECT,
      ...extra,
    });

  it.each([0, 1, 5000])("accepts and keeps minMessages %p", (minMessages) => {
    const r = parse({ minMessages });
    expect(r.success).toBe(true);
    expect((r as any).data.minMessages).toBe(minMessages);
  });

  it.each([-1, 1.5, "3", null])("rejects minMessages %p", (minMessages) => {
    expect(parse({ minMessages }).success).toBe(false);
  });

  it("accepts and keeps contactIds", () => {
    const r = parse({ contactIds: ["c1", "c2"] });
    expect(r.success).toBe(true);
    expect((r as any).data.contactIds).toEqual(["c1", "c2"]);
  });

  it("accepts 1-char and 64-char contact ids and exactly 50 of them", () => {
    expect(parse({ contactIds: ["a"] }).success).toBe(true);
    expect(parse({ contactIds: ["a".repeat(64)] }).success).toBe(true);
    expect(
      parse({ contactIds: Array.from({ length: 50 }, (_, i) => `c${i}`) })
        .success,
    ).toBe(true);
    expect((parse({ contactIds: ["a"] }) as any).data.contactIds).toEqual([
      "a",
    ]);
  });

  it("rejects an empty array, an empty id, a 65-char id and 51 ids", () => {
    expect(parse({ contactIds: [] }).success).toBe(false);
    expect(parse({ contactIds: [""] }).success).toBe(false);
    expect(parse({ contactIds: ["a".repeat(65)] }).success).toBe(false);
    expect(
      parse({ contactIds: Array.from({ length: 51 }, (_, i) => `c${i}`) })
        .success,
    ).toBe(false);
  });

  it("rejects a non-array or non-string contactIds", () => {
    expect(parse({ contactIds: "c1" }).success).toBe(false);
    expect(parse({ contactIds: [1] }).success).toBe(false);
  });
});

describe("getResourceSchema: conversation options", () => {
  const parse = (
    extra: Record<string, unknown>,
    resourceType = "conversation",
  ) => getResourceSchema.safeParse({ resourceType, id: SESSION, ...extra });

  it("accepts and keeps every option with resourceType conversation", () => {
    const r = parse({
      view: "text",
      expertMode: true,
      rawText: true,
      msgChars: 250,
      limit: 20,
      skip: 40,
    });
    expect(r.success).toBe(true);
    expect((r as any).data).toMatchObject({
      view: "text",
      expertMode: true,
      rawText: true,
      msgChars: 250,
      limit: 20,
      skip: 40,
    });
  });

  it.each(["outline", "text"])("accepts view %p", (view) => {
    const r = parse({ view });
    expect(r.success).toBe(true);
    expect((r as any).data.view).toBe(view);
  });

  it.each(["full", "summary", "", 1])("rejects view %p", (view) => {
    expect(parse({ view }).success).toBe(false);
  });

  it.each([100, 4000])("accepts msgChars %p", (msgChars) => {
    const r = parse({ msgChars });
    expect(r.success).toBe(true);
    expect((r as any).data.msgChars).toBe(msgChars);
  });

  it.each([99, 4001, 150.5, "200"])("rejects msgChars %p", (msgChars) => {
    expect(parse({ msgChars }).success).toBe(false);
  });

  it.each([1, 100])("accepts limit %p", (limit) => {
    const r = parse({ limit });
    expect(r.success).toBe(true);
    expect((r as any).data.limit).toBe(limit);
  });

  it.each([0, 101, 1.5])("rejects limit %p", (limit) => {
    expect(parse({ limit }).success).toBe(false);
  });

  it("accepts skip 0 and rejects negative or fractional skip", () => {
    const r = parse({ skip: 0 });
    expect(r.success).toBe(true);
    expect((r as any).data.skip).toBe(0);
    expect(parse({ skip: -1 }).success).toBe(false);
    expect(parse({ skip: 0.5 }).success).toBe(false);
  });

  it.each(["expertMode", "rawText"])("rejects a non-boolean %s", (key) => {
    expect(parse({ [key]: "true" }).success).toBe(false);
    expect(parse({ [key]: 1 }).success).toBe(false);
  });

  it("keeps working without any option", () => {
    expect(parse({}).success).toBe(true);
  });

  it.each([
    ["view", "text"],
    ["rawText", true],
    ["msgChars", 200],
    ["limit", 10],
    ["skip", 1],
    ["expertMode", true],
  ])(
    "refuses %s with a resource type other than conversation",
    (key, value) => {
      expect(parse({ [key]: value }, "agent").success).toBe(false);
      expect(parse({ [key]: value }, "flow").success).toBe(false);
    },
  );

  it("still accepts plain options for another resource type", () => {
    expect(parse({ raw: true }, "agent").success).toBe(true);
    expect(parse({}, "flow").success).toBe(true);
  });
});
