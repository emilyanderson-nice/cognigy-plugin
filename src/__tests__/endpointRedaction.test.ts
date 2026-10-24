import { describe, it, expect, beforeEach } from "@jest/globals";
import { ToolHandlers } from "../tools/handlers.js";
import {
  ID,
  TOKEN,
  PROD_URL,
  ENDPOINT_BASE,
  check,
  expectNoToken,
  expectNoWord,
  mockApi,
  upstreamEndpoint,
} from "./helpers/endpointFixtures.js";

// K2a / K2b: endpoint tokens are redacted by default; revealToken opts in.
describe("endpoint token redaction (K2a, K2b)", () => {
  let api: any;
  let h: InstanceType<typeof ToolHandlers>;

  beforeEach(() => {
    api = mockApi();
    h = new ToolHandlers(
      api,
      ENDPOINT_BASE,
      "",
      "https://static-trial.cognigy.ai",
    );
    (h as any).backupDeclinedForProject.add(ID.project);
  });

  const list = (extra: Record<string, unknown> = {}) =>
    h.handleToolCall("list_resources", {
      resourceType: "endpoint",
      projectId: ID.project,
      ...extra,
    });
  const get = (extra: Record<string, unknown> = {}) =>
    h.handleToolCall("get_resource", {
      resourceType: "endpoint",
      id: ID.endpoint,
      ...extra,
    });

  describe("list_resources endpoint", () => {
    const mockList = (items: any[]) =>
      api.get.mockResolvedValue({ items, total: items.length });

    it("default output has no token, no URL, and exact hasToken per endpoint", async () => {
      mockList([
        upstreamEndpoint(),
        upstreamEndpoint({ _id: ID.other, name: "NoTok", URLToken: "" }),
        upstreamEndpoint({
          _id: ID.flow,
          name: "Missing",
          URLToken: undefined,
        }),
      ]);

      const result = await list();

      expectNoToken(result, "list_resources endpoint");
      expectNoWord(result, "URLToken", "list_resources endpoint");
      expectNoWord(result, "endpointUrl", "list_resources endpoint");
      expect(result.items).toHaveLength(3);
      expect(result.items[0]).toEqual({
        id: ID.endpoint,
        name: "EP",
        channel: "rest",
        flowId: ID.flow,
        createdAt: "2024-01-01",
        hasToken: true,
      });
      expect(result.items[1].hasToken).toBe(false);
      expect(result.items[2].hasToken).toBe(false);
      expect(result.items[0].secret).toBeUndefined();
    });

    it("revealToken: true returns the token and the URL as before", async () => {
      mockList([upstreamEndpoint()]);

      const result = await list({ revealToken: true });

      expect(result.items[0].URLToken).toBe(TOKEN);
      check(JSON.stringify(result).includes(PROD_URL), {
        what: "list_resources endpoint with revealToken did not return endpointUrl",
        why: "revealToken: true restores today's output (URLToken and endpointUrl)",
        expected:
          "endpointUrl equal to endpoint base + '/' + token somewhere in the output",
        actual: "no such URL in the serialized output (value not printed)",
        guidance: "keep adding endpointUrl when revealToken is true",
      });
      expect(JSON.stringify(result)).toContain('"endpointUrl"');
    });

    it("revealToken: false behaves like the default", async () => {
      mockList([upstreamEndpoint()]);

      const result = await list({ revealToken: false });

      expectNoToken(result, "list_resources endpoint (revealToken false)");
      expect(result.items[0].hasToken).toBe(true);
    });

    it("other resource types are unchanged (no hasToken added to flows)", async () => {
      api.get.mockResolvedValue({
        items: [{ _id: ID.flow, name: "Main Flow", createdAt: "2024-01-01" }],
        total: 1,
      });

      const result = await h.handleToolCall("list_resources", {
        resourceType: "flow",
        projectId: ID.project,
      });

      expect(result.items[0].hasToken).toBeUndefined();
      expect(result.items[0].id).toBe(ID.flow);
    });
  });

  describe("list_resources endpoint paging and sorting stay redacted (S5)", () => {
    it("skip, limit and sort do not bring the token back", async () => {
      api.get.mockResolvedValue({ items: [upstreamEndpoint()], total: 9 });

      const result = await list({
        skip: 5,
        limit: 5,
        sort: "lastChanged:desc",
      });

      expectNoToken(result, "list_resources endpoint skip/limit/sort");
      expectNoWord(
        result,
        "URLToken",
        "list_resources endpoint skip/limit/sort",
      );
      expectNoWord(
        result,
        "endpointUrl",
        "list_resources endpoint skip/limit/sort",
      );
      expect(result.items[0].hasToken).toBe(true);
    });
  });

  describe("get_resource raw: true drops token keys at any depth (S1)", () => {
    const record = () => ({
      _id: ID.other,
      sessionId: "sess-1",
      keepTop: "TOP_KEEP",
      endpointUrlToken: TOKEN,
      URLToken: TOKEN,
      nested: {
        endpointUrlToken: TOKEN,
        deeper: [{ URLToken: TOKEN, keepInner: "INNER_KEEP" }],
      },
    });

    it.each([
      ["conversation", { id: "sess-1", projectId: ID.project }],
      ["session_state", { id: "sess-1", projectId: ID.project }],
      ["audit_event", { id: ID.other }],
      ["endpoint", { id: ID.endpoint }],
    ])(
      "%s: sentinel absent, other fields kept",
      async (resourceType, extra) => {
        api.get.mockResolvedValue(record());

        const result = await h.handleToolCall("get_resource", {
          resourceType,
          raw: true,
          ...extra,
        });

        expectNoToken(result, `get_resource ${resourceType} raw`);
        const json = JSON.stringify(result);
        expect(json).not.toContain("endpointUrlToken");
        expect(json).not.toContain("URLToken");
        expect(json).toContain("TOP_KEEP");
        expect(json).toContain("INNER_KEEP");
      },
    );
  });

  describe("get_resource endpoint", () => {
    it("default output has no token and no URL, with hasToken true", async () => {
      api.get.mockResolvedValue(upstreamEndpoint());

      const result = await get();

      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.get.mock.calls[0][0]).toBe(`/v2.0/endpoints/${ID.endpoint}`);
      expectNoToken(result, "get_resource endpoint");
      expectNoWord(result, "URLToken", "get_resource endpoint");
      expectNoWord(result, "endpointUrl", "get_resource endpoint");
      expect(result.hasToken).toBe(true);
      expect(result.id).toBe(ID.endpoint);
      expect(result.secret).toBeUndefined();
    });

    it("hasToken is false for an empty or missing token", async () => {
      api.get.mockResolvedValueOnce(upstreamEndpoint({ URLToken: "" }));
      expect((await get()).hasToken).toBe(false);
      api.get.mockResolvedValueOnce(upstreamEndpoint({ URLToken: undefined }));
      expect((await get()).hasToken).toBe(false);
    });

    it("raw: true also drops the token by default", async () => {
      api.get.mockResolvedValue(upstreamEndpoint());

      const result = await get({ raw: true });

      expectNoToken(result, "get_resource endpoint raw");
      expect(result.URLToken).toBeUndefined();
    });

    it("revealToken: true returns URLToken and endpointUrl", async () => {
      api.get.mockResolvedValue(upstreamEndpoint());

      const result = await get({ revealToken: true });

      expect(result.URLToken).toBe(TOKEN);
      check(result.endpointUrl === PROD_URL, {
        what: "get_resource endpoint with revealToken did not return the exact endpointUrl",
        why: "revealToken: true restores today's output",
        expected: "endpointUrl = endpoint base + '/' + token",
        actual: `endpointUrl is ${typeof result.endpointUrl} (value not printed)`,
        guidance:
          "build endpointUrl from the configured endpoint base and the token",
      });
    });

    it("raw: true with revealToken: true keeps the token", async () => {
      api.get.mockResolvedValue(upstreamEndpoint());

      const result = await get({ raw: true, revealToken: true });

      expect(result.URLToken).toBe(TOKEN);
    });

    it("other resource types ignore revealToken and keep their output", async () => {
      api.get.mockResolvedValue({
        _id: ID.agent,
        name: "Agent",
        projectReference: ID.project,
      });

      const result = await h.handleToolCall("get_resource", {
        resourceType: "agent",
        id: ID.agent,
      });

      expect(result.projectId).toBe(ID.project);
      expect(result.hasToken).toBeUndefined();
    });
  });

  describe("create_ai_agent (K2b)", () => {
    const classicMocks = (endpoint: Record<string, unknown>) => {
      api.post
        .mockResolvedValueOnce({
          _id: ID.agent,
          referenceId: "ref-uuid",
          name: "Test Agent",
          image: "default-avatar:4",
          imageOptimizedFormat: true,
        })
        .mockResolvedValueOnce({
          _id: ID.flow,
          referenceId: "flow-uuid",
          name: "Test Agent Flow",
        })
        .mockResolvedValueOnce({ _id: ID.node })
        .mockResolvedValueOnce(endpoint);
      api.get
        .mockResolvedValueOnce({
          items: [{ _id: ID.entry, isEntryPoint: true }],
        })
        .mockResolvedValueOnce({
          items: [{ _id: ID.llm, connectionId: "conn-1" }],
        })
        .mockResolvedValueOnce({ nodes: [] })
        .mockResolvedValueOnce({ items: [] });
    };

    const promptMocks = (endpoint: Record<string, unknown>) => {
      api.post
        .mockResolvedValueOnce({
          _id: ID.flow,
          referenceId: "flow-uuid",
          name: "Prompt Agent Flow",
        })
        .mockResolvedValueOnce({ _id: ID.node })
        .mockResolvedValueOnce(endpoint);
      api.get
        .mockResolvedValueOnce({
          items: [{ _id: ID.entry, isEntryPoint: true }],
        })
        .mockResolvedValueOnce({
          items: [{ _id: ID.llm, referenceId: "llm-ref", isDefault: true }],
        })
        .mockResolvedValueOnce({
          nodes: [
            { _id: ID.node, type: "llmPromptV2" },
            { _id: ID.defaultBranch, type: "llmPromptDefault" },
            { _id: ID.placeholder, type: "llmPromptTool", label: "Tool" },
          ],
          relations: [
            { node: ID.node, children: [ID.defaultBranch, ID.placeholder] },
          ],
        });
      api.delete.mockResolvedValue({});
    };

    const classicArgs = {
      projectId: ID.project,
      name: "Test Agent",
      description: "A test agent",
    };
    const promptArgs = {
      projectId: ID.project,
      name: "Prompt Agent",
      agentNodeType: "llmPrompt" as const,
      systemPrompt: "You are a summarizer.",
    };
    const ep = { _id: ID.endpoint, URLToken: TOKEN, channel: "rest" };

    it.each([
      ["agent-job mode", classicArgs, classicMocksFor],
      ["llmPrompt mode", promptArgs, promptMocksFor],
    ])(
      "%s: returns endpointId and hasToken, no endpointUrl, no token",
      async (_n, args, mocks) => {
        mocks(ep);

        const result = await h.handleToolCall("create_ai_agent", args);

        expectNoToken(result, `create_ai_agent (${_n})`);
        expectNoWord(result, "endpointUrl", `create_ai_agent (${_n})`);
        expectNoWord(result, "URLToken", `create_ai_agent (${_n})`);
        expect(result.endpointUrl).toBeUndefined();
        expect(result.endpointId).toBe(ID.endpoint);
        expect(result.hasToken).toBe(true);
      },
    );

    it.each([
      ["agent-job mode", classicArgs, classicMocksFor],
      ["llmPrompt mode", promptArgs, promptMocksFor],
    ])(
      "%s: an endpoint without a token reports hasToken false and still the endpointId",
      async (_n, args, mocks) => {
        mocks({ _id: ID.endpoint, channel: "rest" });

        const result = await h.handleToolCall("create_ai_agent", args);

        expect(result.endpointId).toBe(ID.endpoint);
        expect(result.hasToken).toBe(false);
        expect(result.endpointUrl).toBeUndefined();
        expectNoWord(
          result,
          "endpointUrl",
          `create_ai_agent (${_n}, no token)`,
        );
      },
    );

    it("hint text that told the caller to pass a URL now says talk_to_agent { endpointId", async () => {
      // No LLM available -> the result carries hints.
      api.post
        .mockResolvedValueOnce({
          _id: ID.agent,
          referenceId: "ref-uuid",
          name: "Test Agent",
        })
        .mockResolvedValueOnce({ _id: ID.flow, referenceId: "f", name: "Flow" })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(ep);
      api.get
        .mockResolvedValueOnce({
          items: [{ _id: ID.entry, isEntryPoint: true }],
        })
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ nodes: [] })
        .mockResolvedValueOnce({ items: [] });

      const result = await h.handleToolCall("create_ai_agent", classicArgs);

      expect(result._hints).toBeDefined();
      expectNoToken(result, "create_ai_agent hints");
      expectNoWord(result, "endpointUrl", "create_ai_agent hints");
      // LLM state unknown: the endpointId test hint is merged.
      expect(JSON.stringify(result._hints)).toContain(
        "talk_to_agent { endpointId",
      );
    });

    it("does NOT merge the talk_to_agent { endpointId hint when the default LLM was skipped but another is connected", async () => {
      api.post
        .mockResolvedValueOnce({
          _id: ID.agent,
          referenceId: "ref-uuid",
          name: "Test Agent",
        })
        .mockResolvedValueOnce({ _id: ID.flow, referenceId: "f", name: "Flow" })
        .mockResolvedValueOnce({ _id: ID.node })
        .mockResolvedValueOnce(ep);
      api.get
        .mockResolvedValueOnce({
          items: [{ _id: ID.entry, isEntryPoint: true }],
        })
        .mockResolvedValueOnce({
          items: [
            {
              _id: "a".repeat(24),
              referenceId: "chosen-default-ref",
              isDefault: true,
              modelType: "gpt-4o",
            },
            {
              _id: "b".repeat(24),
              referenceId: "other-connected-ref",
              connectionId: "conn-1",
              modelType: "gpt-4o-mini",
            },
          ],
        });
      api.patch.mockResolvedValue({});

      const result = await h.handleToolCall("create_ai_agent", classicArgs);

      expect(result._hints.warning).toContain("project default LLM");
      expect(JSON.stringify(result._hints)).not.toContain(
        "talk_to_agent { endpointId",
      );
      expectNoToken(result, "create_ai_agent skipped-default");
    });

    // Bound to this describe's `api` through the closure above.
    function classicMocksFor(e: Record<string, unknown>) {
      classicMocks(e);
    }
    function promptMocksFor(e: Record<string, unknown>) {
      promptMocks(e);
    }
  });
});
