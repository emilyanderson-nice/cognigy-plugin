import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// talk_to_agent posts with a bare axios call; mock the module to observe the URL.
const post = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule("axios", () => ({ default: { post } }));

const { ToolHandlers } = await import("../tools/handlers.js");
const { talkToAgentSchema } = await import("../schemas/tools.js");
const {
  ID,
  TOKEN,
  PROD_URL,
  TEST_URL,
  ENDPOINT_BASE,
  check,
  expectNoToken,
  expectNoWord,
  mockApi,
  upstreamEndpoint,
} = await import("./helpers/endpointFixtures.js");

const SESSION = "sess-fixed-1";

const httpError = (status: number) => {
  const err: any = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { error: "nope" } };
  return err;
};

/** Asserts the request URL without ever printing it. */
const expectPostedTo = (call: number, url: string, label: string) =>
  check(post.mock.calls[call]?.[0] === url, {
    what: `${label}: the request went to the wrong URL`,
    why: "the URL is built in-process from the endpoint base + token (test mode default)",
    expected:
      "base + (/test) + '/' + token as in the existing resolved-endpoint path",
    actual: "the posted URL differs (value not printed)",
    guidance: "use endpointUrlFor(this.endpointBaseUrl, token, testMode)",
  });

/** Every talk_to_agent output: no token, no endpointUrl anywhere. */
const expectClean = (result: unknown, label: string) => {
  expectNoToken(result, label);
  expectNoWord(result, "endpointUrl", label);
};

describe("talk_to_agent by endpointId (K2c)", () => {
  let api: any;
  let h: InstanceType<typeof ToolHandlers>;

  beforeEach(() => {
    post.mockReset();
    api = mockApi();
    h = new ToolHandlers(
      api,
      ENDPOINT_BASE,
      "",
      "https://static-trial.cognigy.ai",
    );
  });

  const viaId = (extra: Record<string, unknown> = {}) =>
    h.handleTalkToAgent({
      endpointId: ID.endpoint,
      message: "Hi",
      sessionId: SESSION,
      ...extra,
    });

  describe("success", () => {
    it("GETs the endpoint once and posts to the test-mode URL built from base + token", async () => {
      api.get.mockResolvedValueOnce(upstreamEndpoint());
      post.mockResolvedValueOnce({ data: { text: "hello" } });

      const result = await viaId();

      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.get.mock.calls[0][0]).toBe(`/v2.0/endpoints/${ID.endpoint}`);
      expect(post).toHaveBeenCalledTimes(1);
      expectPostedTo(0, TEST_URL, "endpointId default");
      expect(result.agentResponse).toBe("hello");
      expect(result.testMode).toBe(true);
      expect(result.sessionId).toBe(SESSION);
      expect(result.endpointId).toBe(ID.endpoint);
      expect(api.post).not.toHaveBeenCalled();
      expectClean(result, "talk_to_agent endpointId success");
    });

    it("testMode: false posts to the regular URL", async () => {
      api.get.mockResolvedValueOnce(upstreamEndpoint());
      post.mockResolvedValueOnce({ data: { text: "billed" } });

      const result = await viaId({ testMode: false });

      expectPostedTo(0, PROD_URL, "endpointId testMode false");
      expect(result.testMode).toBe(false);
      expect(result.endpointId).toBe(ID.endpoint);
      expectClean(result, "talk_to_agent endpointId testMode false");
    });

    it("still sends the caller's `data` payload", async () => {
      api.get.mockResolvedValueOnce(upstreamEndpoint());
      post.mockResolvedValueOnce({ data: { text: "ok" } });

      await viaId({ data: { plan: "gold", n: 2 } });

      expect(post.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          text: "Hi",
          data: { plan: "gold", n: 2 },
        }),
      );
    });

    it("empty-response hints stay clean of the token", async () => {
      api.get.mockResolvedValueOnce(upstreamEndpoint());
      post.mockResolvedValueOnce({ data: { text: "" } });

      const result = await viaId();

      expect(result._hints.likely_cause).toContain("no text");
      expectClean(result, "talk_to_agent endpointId empty response");
    });
  });

  describe("resolution order: endpointUrl > endpointId > aiAgentId", () => {
    it("endpointUrl wins over endpointId: no lookup, no endpointId in the result", async () => {
      post.mockResolvedValueOnce({ data: { text: "hi" } });

      const result = await h.handleTalkToAgent({
        endpointUrl: PROD_URL,
        endpointId: ID.endpoint,
        aiAgentId: ID.agent,
        message: "Hi",
      });

      expect(api.get).not.toHaveBeenCalled();
      expectPostedTo(0, TEST_URL, "endpointUrl precedence");
      expect(result.endpointId).toBeUndefined();
      expectClean(result, "talk_to_agent caller-supplied endpointUrl success");
    });

    it("endpointId wins over aiAgentId: only the endpoint is fetched", async () => {
      api.get.mockResolvedValueOnce(upstreamEndpoint());
      post.mockResolvedValueOnce({ data: { text: "hi" } });

      const result = await h.handleTalkToAgent({
        endpointId: ID.endpoint,
        aiAgentId: ID.agent,
        message: "Hi",
      });

      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.get.mock.calls[0][0]).toBe(`/v2.0/endpoints/${ID.endpoint}`);
      expect(result.endpointId).toBe(ID.endpoint);
      expectClean(result, "talk_to_agent endpointId over aiAgentId");
    });
  });

  describe("error paths return a body, never throw, never carry the token", () => {
    it("non-REST endpoint: error body with sessionId, nothing posted", async () => {
      api.get.mockResolvedValueOnce(upstreamEndpoint({ channel: "webchat3" }));

      const result = await viaId();

      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.sessionId).toBe(SESSION);
      expect(post).not.toHaveBeenCalled();
      expectClean(result, "talk_to_agent non-REST endpoint");
    });

    it.each([
      ["empty", ""],
      ["missing", undefined],
    ])(
      "endpoint with a %s URLToken: error body with sessionId, nothing posted",
      async (_n, tok) => {
        api.get.mockResolvedValueOnce(upstreamEndpoint({ URLToken: tok }));

        const result = await viaId();

        expect(typeof result.error).toBe("string");
        expect(result.sessionId).toBe(SESSION);
        expect(post).not.toHaveBeenCalled();
        expectClean(result, "talk_to_agent endpoint without token");
      },
    );

    it("HTTP error after the request: single attempt, outcome-first hints, no token, endpointId present", async () => {
      api.get.mockResolvedValueOnce(upstreamEndpoint());
      post.mockRejectedValueOnce(httpError(500));

      const result = await viaId();

      expect(post).toHaveBeenCalledTimes(1);
      expect(result.error).toBe("Request failed with status 500");
      expect(result.testMode).toBe(true);
      expect(result.sessionId).toBe(SESSION);
      expect(result.endpointId).toBe(ID.endpoint);
      expect(result._hints.action.indexOf("FIRST establish")).toBe(0);
      expectClean(result, "talk_to_agent endpointId HTTP error");
    });

    it("network-level failure: no token, no endpointUrl", async () => {
      api.get.mockResolvedValueOnce(upstreamEndpoint());
      const netErr: any = new Error("timeout of 30000ms exceeded");
      netErr.code = "ECONNABORTED";
      post.mockRejectedValueOnce(netErr);

      const result = await viaId();

      expect(result.error).toBe("Request failed with status unknown");
      expect(result.endpointId).toBe(ID.endpoint);
      expectClean(result, "talk_to_agent endpointId network failure");
    });

    it("malformed endpoint base URL: structured error without the token", async () => {
      const broken = new ToolHandlers(
        api,
        "endpoint-trial.cognigy.ai",
        "",
        "https://static-trial.cognigy.ai",
      );
      api.get.mockResolvedValueOnce(upstreamEndpoint());

      const result = await broken.handleTalkToAgent({
        endpointId: ID.endpoint,
        message: "Hi",
      });

      expect(post).not.toHaveBeenCalled();
      expect(result.error).toBe("Endpoint URL is not a valid absolute URL.");
      expect(result._hints.likely_cause).toContain("COGNIGY_ENDPOINT_BASE_URL");
      expectClean(result, "talk_to_agent malformed base URL");
    });

    it("catch-all: a failing endpoint lookup returns an error body without the token or endpointUrl", async () => {
      api.get.mockRejectedValueOnce(new Error("lookup exploded"));

      const result = await viaId();

      expect(typeof result.error).toBe("string");
      expect(result.sessionId).toBe(SESSION);
      expect(post).not.toHaveBeenCalled();
      expectClean(result, "talk_to_agent catch-all");
    });
  });

  describe("caller-supplied endpointUrl (compatibility)", () => {
    it("HTTP error: no endpointUrl, no token and no endpointId in the body", async () => {
      post.mockRejectedValueOnce(httpError(404));

      const result = await h.handleTalkToAgent({
        endpointUrl: PROD_URL,
        message: "Hi",
        sessionId: SESSION,
      });

      expect(post).toHaveBeenCalledTimes(1);
      expectPostedTo(0, TEST_URL, "endpointUrl error path");
      expect(result.error).toBe("Request failed with status 404");
      expect(result.endpointId).toBeUndefined();
      expectClean(result, "talk_to_agent endpointUrl HTTP error");
    });

    it("token-less URL error body carries no endpointUrl", async () => {
      const result = await h.handleTalkToAgent({
        endpointUrl: ENDPOINT_BASE,
        message: "Hi",
      });

      expect(result.error).toBe("Endpoint URL has no URL token.");
      expectNoWord(result, "endpointUrl", "talk_to_agent token-less URL");
    });
  });

  describe("aiAgentId path", () => {
    const resolveMocks = (items: any[]) =>
      api.get
        .mockResolvedValueOnce({
          _id: ID.agent,
          name: "Test Agent",
          flowId: ID.flow,
          projectId: ID.project,
        })
        .mockResolvedValueOnce({ _id: ID.flow, referenceId: "ref-flow-uuid" })
        .mockResolvedValueOnce({ items });

    it("existing REST endpoint: returns endpointId and endpointResolved, nothing sensitive", async () => {
      resolveMocks([upstreamEndpoint()]);
      post.mockResolvedValueOnce({ data: { text: "hi" } });

      const result = await h.handleTalkToAgent({
        aiAgentId: ID.agent,
        message: "Hi",
      });

      expectPostedTo(0, TEST_URL, "aiAgentId existing endpoint");
      expect(result.endpointResolved).toBe(true);
      expect(result.endpointId).toBe(ID.endpoint);
      expect(result.testMode).toBe(true);
      expectClean(result, "talk_to_agent aiAgentId success");
    });

    it("existing REST endpoint, HTTP error: endpointId present, no token or endpointUrl", async () => {
      resolveMocks([upstreamEndpoint()]);
      post.mockRejectedValueOnce(httpError(503));

      const result = await h.handleTalkToAgent({
        aiAgentId: ID.agent,
        message: "Hi",
        sessionId: SESSION,
      });

      expect(post).toHaveBeenCalledTimes(1);
      expect(result.error).toBe("Request failed with status 503");
      expect(result.endpointId).toBe(ID.endpoint);
      expectClean(result, "talk_to_agent aiAgentId HTTP error");
    });

    it("auto-created endpoint: endpointAutoCreated, endpointId, token never returned", async () => {
      resolveMocks([]);
      api.post.mockResolvedValueOnce(upstreamEndpoint());
      post.mockResolvedValueOnce({ data: { text: "hi" } });

      const result = await h.handleTalkToAgent({
        aiAgentId: ID.agent,
        message: "Hi",
      });

      expect(api.post).toHaveBeenCalledWith("/v2.0/endpoints", {
        projectId: ID.project,
        channel: "rest",
        flowId: "ref-flow-uuid",
        name: "Test Agent REST Endpoint",
      });
      expectPostedTo(0, TEST_URL, "aiAgentId auto-created endpoint");
      expect(result.endpointAutoCreated).toBe(true);
      expect(result.endpointId).toBe(ID.endpoint);
      expectClean(result, "talk_to_agent auto-created endpoint success");
    });

    it("auto-created endpoint, HTTP error: still no token or endpointUrl", async () => {
      resolveMocks([]);
      api.post.mockResolvedValueOnce(upstreamEndpoint());
      post.mockRejectedValueOnce(httpError(500));

      const result = await h.handleTalkToAgent({
        aiAgentId: ID.agent,
        message: "Hi",
      });

      expect(result.endpointId).toBe(ID.endpoint);
      expectClean(result, "talk_to_agent auto-created endpoint error");
    });

    it("flow-resolution failure body has no endpointUrl", async () => {
      api.get
        .mockResolvedValueOnce({
          _id: ID.agent,
          name: "Test Agent",
          projectId: ID.project,
        })
        .mockRejectedValueOnce(new Error("Not found"))
        .mockResolvedValueOnce({ items: [] });

      const result = await h.handleTalkToAgent({
        aiAgentId: ID.agent,
        message: "Hi",
      });

      expect(result.error).toContain("Could not find a flow");
      expectNoWord(
        result,
        "endpointUrl",
        "talk_to_agent flow-resolution failure",
      );
    });
  });
});

describe("talkToAgentSchema with endpointId (K2c)", () => {
  it("accepts endpointId alone", () => {
    const parsed = talkToAgentSchema.parse({
      endpointId: ID.endpoint,
      message: "Hello",
    });
    expect(parsed.endpointId).toBe(ID.endpoint);
  });

  it("accepts all three together", () => {
    const parsed = talkToAgentSchema.parse({
      endpointUrl: PROD_URL,
      endpointId: ID.endpoint,
      aiAgentId: ID.agent,
      message: "Hello",
    });
    expect(parsed.endpointId).toBe(ID.endpoint);
  });

  it("rejects a malformed endpointId", () => {
    expect(() =>
      talkToAgentSchema.parse({ endpointId: "nope", message: "Hello" }),
    ).toThrow();
  });

  it("requires one of the three and names all of them in the message", () => {
    let message = "";
    try {
      talkToAgentSchema.parse({ message: "Hello" });
    } catch (e: any) {
      message = String(e.message);
    }
    expect(message).toContain("endpointUrl");
    expect(message).toContain("endpointId");
    expect(message).toContain("aiAgentId");
  });
});
