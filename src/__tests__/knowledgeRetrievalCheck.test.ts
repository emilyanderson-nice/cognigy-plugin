/**
 * Knowledge Search retrieval check: the `knowledgeSearchV2` flow node type,
 * manage_flows `create_endpoint`, manage_knowledge `delete_source` and the
 * `chunkCount` on `list_sources`. Mocked API client, synthetic values only.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ToolHandlers } from "../tools/handlers.js";
import { tools } from "../tools/definitions.js";
import { manageFlowsSchema } from "../schemas/tools.js";
import { conventionalLabel } from "../utils/nodeLabels.js";

const ID = {
  project: "60d5ec49f1a2c8b1a4e0f000",
  flow: "60d5ec49f1a2c8b1a4e0f002",
  otherFlow: "60d5ec49f1a2c8b1a4e0f0a2",
  start: "60d5ec49f1a2c8b1a4e0f010",
  end: "60d5ec49f1a2c8b1a4e0f011",
  say: "60d5ec49f1a2c8b1a4e0f012",
  created: "60d5ec49f1a2c8b1a4e0f099",
  endpoint: "60d5ec49f1a2c8b1a4e0f0e1",
  newEndpoint: "60d5ec49f1a2c8b1a4e0f0e2",
  store: "60d5ec49f1a2c8b1a4e0f0c1",
  src: "60d5ec49f1a2c8b1a4e0f0c2",
  src2: "60d5ec49f1a2c8b1a4e0f0c3",
  src3: "60d5ec49f1a2c8b1a4e0f0c4",
};
const FLOW_REF = "11111111-2222-4333-8444-555555555555";
const STORE_REF = "99999999-8888-4777-8666-555555555555";
const TOKEN = "TOKEN_SENTINEL_5521";
const UPSTREAM_TEXT = "UPSTREAM_SECRET_TEXT_42";

const makeApi = () =>
  ({
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    put: jest.fn(),
    uploadFile: jest.fn(),
  }) as any;

/** An upstream failure shaped like a real AxiosError (status in both places). */
const upstreamError = (status?: number) => {
  const err: any = new Error(UPSTREAM_TEXT);
  if (status !== undefined) {
    err.status = status;
    err.response = { status, data: { message: UPSTREAM_TEXT } };
  }
  return err;
};

/** Runs a handler call and returns the result, or `{ error }` when it throws. */
const attempt = async (fn: () => Promise<any>): Promise<any> => {
  try {
    return await fn();
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
};

// ---------------------------------------------------------------------------
// 1. Flow node type knowledgeSearchV2
// ---------------------------------------------------------------------------
describe("manage_flow_nodes: knowledgeSearchV2", () => {
  let api: any;
  let h: ToolHandlers;

  const chart = {
    nodes: [
      { _id: ID.start, type: "start" },
      { _id: ID.end, type: "end" },
    ],
    relations: [
      { node: ID.start, next: ID.end, children: [] },
      { node: ID.end, next: null, children: [] },
    ],
  };

  const create = (
    nodeType: string,
    config?: Record<string, unknown>,
    label = "Lookup",
  ) =>
    h.handleToolCall("manage_flow_nodes", {
      operation: "create",
      flowId: ID.flow,
      nodeType,
      label,
      ...(config === undefined ? {} : { config }),
    });

  beforeEach(() => {
    api = makeApi();
    h = new ToolHandlers(api, "https://endpoint.example", "", "");
    (h as any).backupDeclinedForProject.add(ID.project);
    (h as any).backupAnsweredAnywhere = true;
    api.get.mockResolvedValue(chart);
    api.post.mockResolvedValue({ _id: ID.created });
  });

  it("creates the node with one POST, config exactly as given, and the conventional label", async () => {
    const config = {
      knowledgeStoreId: STORE_REF,
      topK: 3,
      storeLocation: "context",
      contextKey: "kbResult",
    };

    const result: any = await create("knowledgeSearchV2", config);

    expect(result.error).toBeUndefined();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes`,
      {
        type: "knowledgeSearchV2",
        extension: "@cognigy/basic-nodes",
        mode: "append",
        target: ID.start,
        label: conventionalLabel("knowledgeSearchV2", "Lookup"),
        config,
      },
    );
    // Only the chart was read to find the anchor.
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0][0]).toBe(`/v2.0/flows/${ID.flow}/chart`);
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("does not prefix a label that already carries the conventional prefix a second time", async () => {
    const label = conventionalLabel("knowledgeSearchV2", "Lookup");
    await create("knowledgeSearchV2", { knowledgeStoreId: STORE_REF }, label);
    expect(api.post.mock.calls[0][1].label).toBe(label);
  });

  it("passes the input location with its key through untouched", async () => {
    const config = {
      knowledgeStoreId: STORE_REF,
      topK: 5,
      storeLocation: "input",
      inputKey: "kbHits",
    };
    await create("knowledgeSearchV2", config);
    expect(api.post.mock.calls[0][1].config).toEqual(config);
  });

  it("keeps a config that only has the required key exactly that (no default key added)", async () => {
    await create("knowledgeSearchV2", { knowledgeStoreId: STORE_REF });
    expect(api.post.mock.calls[0][1].config).toEqual({
      knowledgeStoreId: STORE_REF,
    });
  });

  it.each([
    ["no config at all", undefined],
    ["an empty config", {}],
    ["a config with other keys only", { topK: 3 }],
  ])(
    "refuses %s because knowledgeStoreId is required, before any API call",
    async (_name, config) => {
      const result = await attempt(() =>
        create("knowledgeSearchV2", config as any),
      );

      expect(result.error).toMatch(
        /Missing required config keys.*knowledgeStoreId/,
      );
      expect(api.get).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
    },
  );

  it.each(["input", "context"])(
    "accepts storeLocation %s",
    async (storeLocation) => {
      const result: any = await create("knowledgeSearchV2", {
        knowledgeStoreId: STORE_REF,
        storeLocation,
      });
      expect(result.error).toBeUndefined();
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(api.post.mock.calls[0][1].config.storeLocation).toBe(
        storeLocation,
      );
    },
  );

  it.each(["everywhere", "Input", "CONTEXT", ""])(
    "refuses storeLocation %p before any API call",
    async (storeLocation) => {
      const result = await attempt(() =>
        create("knowledgeSearchV2", {
          knowledgeStoreId: STORE_REF,
          storeLocation,
        }),
      );

      expect(result.error).toMatch(/storeLocation must be one of/);
      expect(result.error).toContain("input");
      expect(result.error).toContain("context");
      expect(api.get).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
    },
  );

  it("still refuses the legacy knowledgeSearch type and posts nothing", async () => {
    const result = await attempt(() =>
      create("knowledgeSearch", { knowledgeStoreId: STORE_REF }),
    );

    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("lists knowledgeSearchV2, and not the legacy knowledgeSearch, among the supported types", async () => {
    const result = await attempt(() => create("notARealNodeType", {}));

    expect(typeof result.error).toBe("string");
    // The refusal echoes the requested type, so compare only the list.
    const list = result.error
      .split("Supported types: ")[1]
      .replace(/\.$/, "")
      .split(", ");
    expect([...list].sort()).toEqual(
      [
        ...[
          "say",
          "question",
          "ifThenElse",
          "lookup",
          "setSessionContext",
          "code",
          "executeFlow",
          "log",
          "debugMessage",
          "goTo",
          "sleep",
          "httpRequest",
          "initAppSession",
          "showXAppHtml",
          "showXAppAdaptiveCard",
          "setXAppState",
          "getXAppSessionPin",
          "llmPrompt",
          "wait",
          "cxOneSendCopilotStatus",
          "setSessionConfig",
        ],
        "knowledgeSearchV2",
      ].sort(),
    );
    expect(list).not.toContain("knowledgeSearch");
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. manage_flows create_endpoint
// ---------------------------------------------------------------------------
describe("manageFlowsSchema: create_endpoint", () => {
  it("accepts a 24-hex flowId with and without a name", () => {
    expect(
      manageFlowsSchema.parse({
        operation: "create_endpoint",
        flowId: ID.flow,
      }),
    ).toMatchObject({ operation: "create_endpoint", flowId: ID.flow });
    expect(
      manageFlowsSchema.parse({
        operation: "create_endpoint",
        flowId: ID.flow,
        name: "x".repeat(200),
      }),
    ).toMatchObject({ name: "x".repeat(200) });
  });

  it.each([
    ["a missing flowId", { operation: "create_endpoint" }],
    ["a non-hex flowId", { operation: "create_endpoint", flowId: "not-an-id" }],
    [
      "an empty name",
      { operation: "create_endpoint", flowId: ID.flow, name: "" },
    ],
    [
      "a 201 character name",
      { operation: "create_endpoint", flowId: ID.flow, name: "x".repeat(201) },
    ],
  ])("rejects %s", (_n, input) => {
    expect(() => manageFlowsSchema.parse(input)).toThrow();
  });
});

describe("manage_flows create_endpoint", () => {
  let api: any;
  let h: ToolHandlers;

  const flowDoc = (over: Record<string, unknown> = {}) => ({
    _id: ID.flow,
    referenceId: FLOW_REF,
    projectReference: ID.project,
    name: "Support Flow",
    ...over,
  });

  const rest = (flowId: string, over: Record<string, unknown> = {}) => ({
    _id: ID.endpoint,
    channel: "rest",
    flowId,
    name: "Existing",
    URLToken: TOKEN,
    endpointUrl: `https://endpoint.example/${TOKEN}`,
    token: TOKEN,
    ...over,
  });

  /** `n` REST endpoints that all belong to another flow. */
  const fillers = (n: number) =>
    Array.from({ length: n }, (_v, i) =>
      rest(ID.otherFlow, {
        _id: `60d5ec49f1a2c8b1a4e1${String(i).padStart(4, "0")}`,
      }),
    );

  /** Mock GETs by path: the flow read plus the endpoint pages in order. */
  const mockGets = (flow: unknown, pages: unknown[][]) => {
    let page = 0;
    api.get.mockImplementation(async (path: string) => {
      if (path === `/v2.0/flows/${ID.flow}`) return flow;
      if (path === "/v2.0/endpoints") {
        const items = pages[page] ?? [];
        page += 1;
        return { items, total: items.length };
      }
      throw new Error(`unexpected GET ${path}`);
    });
  };

  const endpointListCalls = () =>
    api.get.mock.calls.filter((c: any[]) => c[0] === "/v2.0/endpoints");

  const run = (args: Record<string, unknown> = {}) =>
    h.handleToolCall("manage_flows", {
      operation: "create_endpoint",
      flowId: ID.flow,
      ...args,
    });

  beforeEach(() => {
    // Fresh handler: no backup decision recorded on purpose (gate test).
    api = makeApi();
    h = new ToolHandlers(api, "https://endpoint.example", "", "");
    api.post.mockResolvedValue({
      _id: ID.newEndpoint,
      channel: "rest",
      URLToken: TOKEN,
      endpointUrl: `https://endpoint.example/${TOKEN}`,
      token: TOKEN,
    });
  });

  describe("creating", () => {
    it("reads the flow, finds nothing, and POSTs exactly one endpoint with the flow's referenceId", async () => {
      mockGets(flowDoc(), [[]]);

      const result: any = await run({ name: "KB check" });

      expect(api.post).toHaveBeenCalledTimes(1);
      expect(api.post).toHaveBeenCalledWith("/v2.0/endpoints", {
        projectId: ID.project,
        channel: "rest",
        flowId: FLOW_REF,
        name: "KB check",
      });
      expect(api.patch).not.toHaveBeenCalled();
      expect(api.delete).not.toHaveBeenCalled();
      expect(api.put).not.toHaveBeenCalled();
      const { _hints, ...rest_ } = result;
      expect(rest_).toEqual({
        operation: "create_endpoint",
        flowId: ID.flow,
        endpointId: ID.newEndpoint,
        reused: false,
      });
      expect(_hints.action).toContain("talk_to_agent");
      expect(_hints.action).toContain("endpointId");
      expect(_hints.action).toContain("delete_resource");
      expect(_hints.warning).toBeUndefined();
      expect(api.get.mock.calls.map((c: any[]) => c[0])).toEqual([
        `/v2.0/flows/${ID.flow}`,
        "/v2.0/endpoints",
      ]);
    });

    it("looks for existing endpoints with exactly projectId, limit 100 and skip 0", async () => {
      mockGets(flowDoc(), [[]]);
      await run();
      expect(endpointListCalls()).toHaveLength(1);
      expect(endpointListCalls()[0][1]).toEqual({
        params: { projectId: ID.project, limit: 100, skip: 0 },
      });
    });

    it("names the endpoint '<flow name> REST Endpoint' when no name is given", async () => {
      mockGets(flowDoc({ name: "Billing Flow" }), [[]]);
      await run();
      expect(api.post.mock.calls[0][1]).toEqual({
        projectId: ID.project,
        channel: "rest",
        flowId: FLOW_REF,
        name: "Billing Flow REST Endpoint",
      });
    });

    it("names the endpoint 'REST Endpoint' when the flow has no name and none is given", async () => {
      mockGets(flowDoc({ name: undefined }), [[]]);
      await run();
      expect(api.post.mock.calls[0][1].name).toBe("REST Endpoint");
    });

    it("uses a given name verbatim", async () => {
      mockGets(flowDoc(), [[]]);
      await run({ name: "  odd NAME  " });
      expect(api.post.mock.calls[0][1].name).toBe("  odd NAME  ");
    });

    it("does not reuse a REST endpoint of ANOTHER flow", async () => {
      mockGets(flowDoc(), [[rest(ID.otherFlow)]]);
      const result: any = await run();
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(result.reused).toBe(false);
      expect(result.endpointId).toBe(ID.newEndpoint);
    });

    it("does not reuse an endpoint of another channel on the same flow (by _id or referenceId)", async () => {
      mockGets(flowDoc(), [
        [
          rest(ID.flow, { channel: "webchat3" }),
          rest(FLOW_REF, { channel: "alexa" }),
        ],
      ]);
      const result: any = await run();
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(result.reused).toBe(false);
      expect(result.endpointId).toBe(ID.newEndpoint);
    });

    it("stops paging after a page of fewer than 100 items (one list call for 99)", async () => {
      mockGets(flowDoc(), [fillers(99), fillers(5)]);
      await run();
      expect(endpointListCalls()).toHaveLength(1);
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    it("keeps paging after a full page of 100 and creates once every page is exhausted", async () => {
      mockGets(flowDoc(), [fillers(100), []]);
      await run();
      expect(endpointListCalls().map((c: any[]) => c[1])).toEqual([
        { params: { projectId: ID.project, limit: 100, skip: 0 } },
        { params: { projectId: ID.project, limit: 100, skip: 100 } },
      ]);
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    it("never leaks the token, URLToken or endpointUrl, even under other keys", async () => {
      mockGets(flowDoc(), [[]]);
      const result = await run();
      const json = JSON.stringify(result);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain("URLToken");
      expect(json).not.toContain("endpointUrl");
    });

    it("does not need a backup decision: a fresh handler runs the first call", async () => {
      mockGets(flowDoc(), [[]]);
      const result: any = await run();
      expect(result.error).toBeUndefined();
      expect(result.endpointId).toBe(ID.newEndpoint);
      expect(api.post).toHaveBeenCalledTimes(1);
    });
  });

  describe("reusing", () => {
    it("reuses a REST endpoint whose flowId is the flow's _id, creating nothing", async () => {
      mockGets(flowDoc(), [[rest(ID.flow)]]);

      const result: any = await run();

      expect(api.post).not.toHaveBeenCalled();
      const { _hints, ...rest_ } = result;
      expect(rest_).toEqual({
        operation: "create_endpoint",
        flowId: ID.flow,
        endpointId: ID.endpoint,
        reused: true,
      });
      expect(_hints.action).toContain("talk_to_agent");
      expect(_hints.action).toContain("endpointId");
      expect(_hints.action).toContain("delete_resource");
      expect(_hints.warning).toContain("settings");
    });

    it("reuses a REST endpoint whose flowId is the flow's referenceId", async () => {
      mockGets(flowDoc(), [[rest(FLOW_REF)]]);
      const result: any = await run();
      expect(api.post).not.toHaveBeenCalled();
      expect(result.reused).toBe(true);
      expect(result.endpointId).toBe(ID.endpoint);
    });

    it("reuses the FIRST match when several qualify", async () => {
      const first = "60d5ec49f1a2c8b1a4e0f0f1";
      const second = "60d5ec49f1a2c8b1a4e0f0f2";
      mockGets(flowDoc(), [
        [
          rest(ID.otherFlow),
          rest(FLOW_REF, { _id: first }),
          rest(ID.flow, { _id: second }),
        ],
      ]);
      const result: any = await run();
      expect(result.endpointId).toBe(first);
    });

    it("finds a match on page 2 after a full page of 100 non-matching items", async () => {
      mockGets(flowDoc(), [fillers(100), [rest(FLOW_REF)]]);

      const result: any = await run();

      expect(endpointListCalls().map((c: any[]) => c[1])).toEqual([
        { params: { projectId: ID.project, limit: 100, skip: 0 } },
        { params: { projectId: ID.project, limit: 100, skip: 100 } },
      ]);
      expect(api.post).not.toHaveBeenCalled();
      expect(result.reused).toBe(true);
      expect(result.endpointId).toBe(ID.endpoint);
    });

    it("does not reuse by name and ignores a given name when reusing", async () => {
      mockGets(flowDoc(), [[rest(ID.flow, { name: "Other name" })]]);
      const result: any = await run({ name: "Wanted" });
      expect(api.post).not.toHaveBeenCalled();
      expect(result.endpointId).toBe(ID.endpoint);
    });

    it("never leaks the token, URLToken or endpointUrl when reusing", async () => {
      mockGets(flowDoc(), [[rest(ID.flow)]]);
      const json = JSON.stringify(await run());
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain("URLToken");
      expect(json).not.toContain("endpointUrl");
    });

    it("does not need a backup decision: a fresh handler runs the first call", async () => {
      mockGets(flowDoc(), [[rest(ID.flow)]]);
      const result: any = await run();
      expect(result.error).toBeUndefined();
      expect(result.reused).toBe(true);
    });
  });

  describe("failures", () => {
    it("returns flow_not_readable with the status and makes no endpoint call when the flow read fails", async () => {
      api.get.mockRejectedValue(upstreamError(404));

      const result = await run();

      expect(result).toEqual({
        operation: "create_endpoint",
        error: "flow_not_readable",
        httpStatus: 404,
      });
      expect(JSON.stringify(result)).not.toContain(UPSTREAM_TEXT);
      expect(endpointListCalls()).toHaveLength(0);
      expect(api.post).not.toHaveBeenCalled();
    });

    it("omits httpStatus on flow_not_readable when the failure has no status", async () => {
      api.get.mockRejectedValue(upstreamError());

      const result = await run();

      expect(result).toEqual({
        operation: "create_endpoint",
        error: "flow_not_readable",
      });
      expect(endpointListCalls()).toHaveLength(0);
      expect(api.post).not.toHaveBeenCalled();
    });

    it("returns flow_unusable and posts nothing when the flow has no referenceId", async () => {
      mockGets(flowDoc({ referenceId: undefined }), [[rest(ID.flow)]]);

      const result = await run();

      expect(result).toEqual({
        operation: "create_endpoint",
        error: "flow_unusable",
      });
      expect(endpointListCalls()).toHaveLength(0);
      expect(api.post).not.toHaveBeenCalled();
    });

    it("returns request_failed with the numeric status and no upstream text when the POST fails", async () => {
      mockGets(flowDoc(), [[]]);
      api.post.mockRejectedValue(upstreamError(403));

      const result = await run();

      expect(result).toEqual({
        operation: "create_endpoint",
        error: "request_failed",
        httpStatus: 403,
      });
      expect(JSON.stringify(result)).not.toContain(UPSTREAM_TEXT);
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    it("omits httpStatus when the failed POST has no status", async () => {
      mockGets(flowDoc(), [[]]);
      api.post.mockRejectedValue(upstreamError());

      expect(await run()).toEqual({
        operation: "create_endpoint",
        error: "request_failed",
      });
    });

    it("returns request_failed, not a success without an id, when the created endpoint has no id", async () => {
      mockGets(flowDoc(), [[]]);
      api.post.mockResolvedValue({ channel: "rest", URLToken: TOKEN });

      const result = await run();

      expect(result).toEqual({
        operation: "create_endpoint",
        error: "request_failed",
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("takes the endpoint id from `id` when the endpoint has no `_id`", async () => {
      mockGets(flowDoc(), [
        [rest(ID.flow, { _id: undefined, id: ID.endpoint })],
      ]);

      const result: any = await run();

      expect(result.endpointId).toBe(ID.endpoint);
      expect(result.reused).toBe(true);
      expect(api.post).not.toHaveBeenCalled();
    });

    it("returns request_failed when the reused endpoint has no id, and posts nothing", async () => {
      mockGets(flowDoc(), [[rest(ID.flow, { _id: undefined })]]);

      const result = await run();

      expect(result).toEqual({
        operation: "create_endpoint",
        error: "request_failed",
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(api.post).not.toHaveBeenCalled();
    });

    it("stops paging after 100 pages when the API keeps returning full pages, then creates", async () => {
      mockGets(
        flowDoc(),
        Array.from({ length: 150 }, () => fillers(100)),
      );

      const result: any = await run();

      expect(endpointListCalls()).toHaveLength(100);
      expect(endpointListCalls()[99][1]).toEqual({
        params: { projectId: ID.project, limit: 100, skip: 9900 },
      });
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(result.reused).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 3 and 4. manage_knowledge delete_source and list_sources chunkCount
// ---------------------------------------------------------------------------
describe("manage_knowledge delete_source", () => {
  let api: any;
  let h: ToolHandlers;

  const run = (args: Record<string, unknown>) =>
    h.handleToolCall("manage_knowledge", {
      operation: "delete_source",
      ...args,
    });
  const noOtherCalls = () => {
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    // Fresh handler: no backup decision recorded on purpose (gate test).
    api = makeApi();
    h = new ToolHandlers(api, "https://endpoint.example", "", "");
    api.delete.mockResolvedValue({});
  });

  it("makes exactly one DELETE on the source path and returns the success shape", async () => {
    const result: any = await run({
      knowledgeStoreId: ID.store,
      sourceId: ID.src,
    });

    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(api.delete.mock.calls[0][0]).toBe(
      `/v2.0/knowledgestores/${ID.store}/sources/${ID.src}`,
    );
    noOtherCalls();
    const { _hints, ...rest } = result;
    expect(rest).toEqual({
      operation: "delete_source",
      knowledgeStoreId: ID.store,
      sourceId: ID.src,
      deleted: true,
    });
    expect(_hints.warning).toContain("chunks");
    expect(_hints.warning).toContain("create_source");
  });

  it("runs on a fresh handler without a backup decision", async () => {
    const result: any = await run({
      knowledgeStoreId: ID.store,
      sourceId: ID.src,
    });
    expect(result.error).toBeUndefined();
    expect(result.deleted).toBe(true);
  });

  it.each([
    ["sourceId", { knowledgeStoreId: ID.store }],
    ["knowledgeStoreId", { sourceId: ID.src }],
  ])(
    "returns an in-handler error when %s is missing, with no API call",
    async (name, args) => {
      const result: any = await run(args);

      expect(result.error).toContain(`${name} is required for delete_source`);
      expect(result._hints).toBeDefined();
      expect(api.delete).not.toHaveBeenCalled();
      noOtherCalls();
    },
  );

  it.each([
    ["knowledgeStoreId", { knowledgeStoreId: "nope", sourceId: ID.src }],
    ["sourceId", { knowledgeStoreId: ID.store, sourceId: "nope" }],
  ])(
    "rejects a malformed %s through the schema, with no API call",
    async (_n, args) => {
      await expect(run(args)).rejects.toThrow();
      expect(api.delete).not.toHaveBeenCalled();
      noOtherCalls();
    },
  );

  it("maps a 404 to source_not_found without upstream text", async () => {
    api.delete.mockRejectedValue(upstreamError(404));

    const result = await run({ knowledgeStoreId: ID.store, sourceId: ID.src });

    expect(result).toEqual({
      operation: "delete_source",
      error: "source_not_found",
    });
    expect(JSON.stringify(result)).not.toContain(UPSTREAM_TEXT);
    expect(api.delete).toHaveBeenCalledTimes(1);
  });

  it("maps another failure to request_failed with its numeric status and no upstream text", async () => {
    api.delete.mockRejectedValue(upstreamError(500));

    const result = await run({ knowledgeStoreId: ID.store, sourceId: ID.src });

    expect(result).toEqual({
      operation: "delete_source",
      error: "request_failed",
      httpStatus: 500,
    });
    expect(JSON.stringify(result)).not.toContain(UPSTREAM_TEXT);
  });

  it("omits httpStatus when the failure has no status", async () => {
    api.delete.mockRejectedValue(upstreamError());

    expect(await run({ knowledgeStoreId: ID.store, sourceId: ID.src })).toEqual(
      { operation: "delete_source", error: "request_failed" },
    );
  });
});

describe("manage_knowledge list_sources chunkCount", () => {
  let api: any;
  let h: ToolHandlers;

  /** All plain objects anywhere in `value`, so the test does not pin the result's wrapper key. */
  const objectsIn = (value: unknown, out: any[] = []): any[] => {
    if (Array.isArray(value)) value.forEach((v) => objectsIn(v, out));
    else if (value && typeof value === "object") {
      out.push(value);
      Object.values(value).forEach((v) => objectsIn(v, out));
    }
    return out;
  };
  const sourceEntry = (result: unknown, id: string): any => {
    const hits = objectsIn(result).filter(
      (o) => o.id === id || o._id === id || o.sourceId === id,
    );
    expect(hits).toHaveLength(1);
    return hits[0];
  };

  beforeEach(() => {
    api = makeApi();
    h = new ToolHandlers(api, "https://endpoint.example", "", "");
    api.get.mockResolvedValue({
      items: [
        { _id: ID.src, name: "Positive", type: "manual", chunkCount: 12 },
        { _id: ID.src2, name: "Zero", type: "manual", chunkCount: 0 },
        { _id: ID.src3, name: "Text", type: "manual", chunkCount: "37" },
        { _id: "60d5ec49f1a2c8b1a4e0f0c5", name: "Absent", type: "manual" },
        {
          _id: "60d5ec49f1a2c8b1a4e0f0c6",
          name: "Null",
          type: "manual",
          chunkCount: null,
        },
      ],
      total: 5,
    });
  });

  const list = () =>
    h.handleToolCall("manage_knowledge", {
      operation: "list_sources",
      knowledgeStoreId: ID.store,
    });

  it("carries a numeric chunkCount through", async () => {
    expect(sourceEntry(await list(), ID.src).chunkCount).toBe(12);
  });

  it("keeps chunkCount 0 (not dropped as falsy)", async () => {
    const entry = sourceEntry(await list(), ID.src2);
    expect(entry).toHaveProperty("chunkCount", 0);
  });

  it("does not pass a string chunkCount through", async () => {
    const result = await list();
    expect(sourceEntry(result, ID.src3)).not.toHaveProperty("chunkCount");
    expect(JSON.stringify(result)).not.toContain("37");
  });

  it("leaves chunkCount out when absent or null", async () => {
    const result = await list();
    expect(sourceEntry(result, "60d5ec49f1a2c8b1a4e0f0c5")).not.toHaveProperty(
      "chunkCount",
    );
    expect(sourceEntry(result, "60d5ec49f1a2c8b1a4e0f0c6")).not.toHaveProperty(
      "chunkCount",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Tool contract
// ---------------------------------------------------------------------------
describe("tool definitions list the new operations", () => {
  const opsOf = (name: string): string[] =>
    (tools.find((t) => t.name === name)!.inputSchema.properties as any)
      .operation.enum;

  it("manage_flows offers create_endpoint and keeps its earlier operations", () => {
    expect(opsOf("manage_flows")).toEqual(
      expect.arrayContaining(["create", "update", "clone", "create_endpoint"]),
    );
    expect(tools.find((t) => t.name === "manage_flows")!.description).toContain(
      "create_endpoint",
    );
  });

  it("manage_knowledge offers delete_source and keeps list_sources", () => {
    expect(opsOf("manage_knowledge")).toEqual(
      expect.arrayContaining([
        "list_sources",
        "create_source",
        "delete_source",
      ]),
    );
    expect(
      tools.find((t) => t.name === "manage_knowledge")!.description,
    ).toContain("delete_source");
  });
});
