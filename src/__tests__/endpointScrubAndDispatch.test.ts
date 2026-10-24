import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const post = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule("axios", () => ({ default: { post } }));

const { ToolHandlers } = await import("../tools/handlers.js");
const {
  ID,
  TOKEN,
  PROD_URL,
  TEST_URL,
  check,
  expectNoToken,
  mockApi,
  upstreamEndpoint,
} = await import("./helpers/endpointFixtures.js");
const { harness, parse, setOf, tool, usable, KEY_A, endpointUrl } =
  await import("./helpers/dispatchHarness.js");

const { getResourceSchema, listResourcesSchema } = await import(
  "../schemas/tools.js"
);

const BASE = "https://endpoint-trial.cognigy.ai";

// B4: an upstream error that echoes the token or URL is scrubbed from detail
// and rawResponse. The token and URL are never printed in failure messages.
describe("talk_to_agent scrubs echoed tokens from upstream errors (B4)", () => {
  let api: any;
  let h: InstanceType<typeof ToolHandlers>;

  beforeEach(() => {
    post.mockReset();
    api = mockApi();
    h = new ToolHandlers(api, BASE, "", "https://static-trial.cognigy.ai");
  });

  const bodies: Array<[string, (url: string) => any]> = [
    [
      "error text with the token path",
      () => ({ error: `Cannot POST /test/${TOKEN}` }),
    ],
    ["message holding the full URL", (url) => ({ message: url })],
  ];

  const failWith = (status: number, data: any, message?: string) => {
    const err: any = new Error(
      message ?? `Request failed with status code ${status}`,
    );
    err.response = { status, data };
    return err;
  };

  const resolveViaAgent = () =>
    api.get
      .mockResolvedValueOnce({
        _id: ID.agent,
        name: "Test Agent",
        flowId: ID.flow,
        projectId: ID.project,
      })
      .mockResolvedValueOnce({ _id: ID.flow, referenceId: "ref-flow-uuid" })
      .mockResolvedValueOnce({ items: [upstreamEndpoint()] });

  const paths: Array<[string, () => Record<string, unknown>]> = [
    [
      "endpointId path",
      () => {
        api.get.mockResolvedValueOnce(upstreamEndpoint());
        return { endpointId: ID.endpoint };
      },
    ],
    [
      "aiAgentId path",
      () => {
        resolveViaAgent();
        return { aiAgentId: ID.agent };
      },
    ],
  ];

  describe.each(paths)("%s", (_p, setup) => {
    describe.each([true, false])("testMode %s", (testMode) => {
      describe.each(bodies)("upstream body: %s", (_b, makeBody) => {
        it.each([false, true])(
          "verbose %s: token and URL absent, detail still a non-empty string",
          async (verbose) => {
            const target = testMode ? TEST_URL : PROD_URL;
            const idArgs = setup();
            post.mockRejectedValueOnce(failWith(404, makeBody(target)));

            const result = await h.handleTalkToAgent({
              ...idArgs,
              message: "Hi",
              testMode,
              verbose,
            });

            expect(post).toHaveBeenCalledTimes(1);
            expectNoToken(result, "talk_to_agent echoed-token error");
            check(!JSON.stringify(result).includes(target), {
              what: "the full request URL survived in the result",
              why: "an upstream error body that echoes the URL must be scrubbed from detail/rawResponse",
              expected: "no URL containing the token anywhere in the result",
              actual: "the URL is present (value not printed)",
              guidance:
                "replace the token and any URL containing it before returning detail and rawResponse",
            });
            expect(typeof result.detail).toBe("string");
            expect(result.detail.length).toBeGreaterThan(0);
          },
        );
      });

      it("a transport error whose own message echoes the URL is scrubbed too", async () => {
        const target = testMode ? TEST_URL : PROD_URL;
        const idArgs = setup();
        const err: any = new Error(
          `connect ECONNREFUSED while posting to ${target}`,
        );
        err.code = "ECONNREFUSED";
        post.mockRejectedValueOnce(err);

        const result = await h.handleTalkToAgent({
          ...idArgs,
          message: "Hi",
          testMode,
          verbose: true,
        });

        expectNoToken(result, "talk_to_agent echoed-token transport error");
        expect(typeof result.detail).toBe("string");
        expect(result.detail.length).toBeGreaterThan(0);
      });
    });
  });
});

// S5: the dispatcher-wrapped result (with _environment) stays token-free.
describe("dispatcher-wrapped results stay token-free (S5)", () => {
  const BASE_A = endpointUrl("a");
  let api: any;

  const build = () => {
    api = mockApi();
    const real = new ToolHandlers(
      api,
      BASE_A,
      "",
      "https://static-a.cognigy.ai",
    );
    return harness({
      set: setOf(usable("A", KEY_A)),
      tools: [tool("list_resources"), tool("talk_to_agent")],
      impl: { a: (n, a) => real.handleToolCall(n, a) },
    });
  };

  beforeEach(() => post.mockReset());

  it("list_resources endpoint", async () => {
    const h = build();
    api.get.mockResolvedValue({ items: [upstreamEndpoint()], total: 1 });

    const r = await h.dispatcher.callTool("list_resources", {
      resourceType: "endpoint",
      projectId: ID.project,
    });

    const body = parse(r);
    expect(body._environment).toBeDefined();
    expectNoToken(r.content[0].text, "dispatcher list_resources endpoint");
    expect((body as any).items[0].hasToken).toBe(true);
  });

  it("talk_to_agent by endpointId, success and error", async () => {
    const h = build();
    api.get.mockResolvedValue(upstreamEndpoint());
    post.mockResolvedValueOnce({ data: { text: "hi" } });

    const ok = await h.dispatcher.callTool("talk_to_agent", {
      endpointId: ID.endpoint,
      message: "Hi",
    });
    expect(parse(ok)._environment).toBeDefined();
    expect(parse(ok).agentResponse).toBe("hi");
    expectNoToken(ok.content[0].text, "dispatcher talk_to_agent success");

    const err: any = new Error("Request failed with status code 500");
    err.response = {
      status: 500,
      data: { error: `Cannot POST /test/${TOKEN}` },
    };
    post.mockRejectedValueOnce(err);

    const bad = await h.dispatcher.callTool("talk_to_agent", {
      endpointId: ID.endpoint,
      message: "Hi",
    });
    expect(parse(bad)._environment).toBeDefined();
    expectNoToken(bad.content[0].text, "dispatcher talk_to_agent error");
  });
});

describe("revealToken schema refine (S2)", () => {
  it("list_resources and get_resource reject revealToken: true for a non-endpoint type", () => {
    expect(() =>
      listResourcesSchema.parse({
        resourceType: "flow",
        projectId: ID.project,
        revealToken: true,
      }),
    ).toThrow();
    expect(() =>
      getResourceSchema.parse({
        resourceType: "flow",
        id: ID.flow,
        revealToken: true,
      }),
    ).toThrow();
  });

  it("accepts revealToken: true for endpoint", () => {
    expect(
      (
        listResourcesSchema.parse({
          resourceType: "endpoint",
          projectId: ID.project,
          revealToken: true,
        }) as any
      ).revealToken,
    ).toBe(true);
    expect(
      (
        getResourceSchema.parse({
          resourceType: "endpoint",
          id: ID.endpoint,
          revealToken: true,
        }) as any
      ).revealToken,
    ).toBe(true);
  });

  it("accepts revealToken: false for a non-endpoint type (rejected only when true)", () => {
    expect(() =>
      listResourcesSchema.parse({
        resourceType: "flow",
        projectId: ID.project,
        revealToken: false,
      }),
    ).not.toThrow();
    expect(() =>
      getResourceSchema.parse({
        resourceType: "flow",
        id: ID.flow,
        revealToken: false,
      }),
    ).not.toThrow();
  });
});
