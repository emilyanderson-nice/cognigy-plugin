import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ToolHandlers } from "../tools/handlers.js";

const ENDPOINT = "60d5ec49f1a2c8b1a4e0f003";
const FLOW = "6d1f1d02-a5fb-49f2-8b6e-7246c2456097";
const OTHER_FLOW = "8d1f1d02-a5fb-49f2-8b6e-7246c2456099";

describe("manage_endpoint_settings call events", () => {
  let stored: any;
  let api: {
    get: jest.Mock<any>;
    patch: jest.Mock<any>;
    post: jest.Mock<any>;
    delete: jest.Mock<any>;
    put: jest.Mock<any>;
  };
  let h: ToolHandlers;

  beforeEach(() => {
    stored = {
      _id: ENDPOINT,
      name: "Voice",
      channel: "voiceGateway2",
      settings: {
        privacyNotice: { enabled: false },
        callEvents: {
          callCompleted: { enabled: true, action: "executeFlow", flowId: FLOW },
          callFailed: {
            enabled: false,
            action: "executeFlow",
            flowId: OTHER_FLOW,
          },
        },
      },
    };
    api = {
      get: jest.fn(async () => structuredClone(stored)),
      // the platform merges a partial settings.callEvents (checked live on the EU trial)
      patch: jest.fn(async (_p: string, body: any) => {
        stored = {
          ...stored,
          settings: {
            ...stored.settings,
            callEvents: {
              ...stored.settings.callEvents,
              ...body.settings.callEvents,
            },
          },
        };
        return {};
      }),
      post: jest.fn(),
      delete: jest.fn(),
      put: jest.fn(),
    };
    h = new ToolHandlers(api as any, "https://e", "https://w");
  });

  const run = async (args: any) => {
    const r: any = await h.handleToolCall("manage_endpoint_settings", args);
    return r?.content ? JSON.parse(r.content[0].text) : r;
  };

  it("get_call_events returns the configured events", async () => {
    const r = await run({ operation: "get_call_events", endpointId: ENDPOINT });
    expect(r.callEvents.callCompleted.flowId).toBe(FLOW);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("switches one event and sends only that event", async () => {
    const r = await run({
      operation: "update_call_events",
      endpointId: ENDPOINT,
      events: { callFailed: { enabled: true } },
    });
    expect(api.patch.mock.calls[0][1]).toEqual({
      settings: {
        callEvents: {
          callFailed: {
            enabled: true,
            action: "executeFlow",
            flowId: OTHER_FLOW,
          },
        },
      },
    });
    expect(r.verified).toBe(true);
    expect(r.changed).toEqual(["callFailed"]);
    expect(stored.settings.callEvents.callCompleted.enabled).toBe(true);
    expect(stored.settings.privacyNotice).toEqual({ enabled: false });
  });

  it("points an event at another flow", async () => {
    const r = await run({
      operation: "update_call_events",
      endpointId: ENDPOINT,
      events: { callCompleted: { flowId: OTHER_FLOW } },
    });
    expect(r.verified).toBe(true);
    expect(r.after.callCompleted.flowId).toBe(OTHER_FLOW);
  });

  it("needs a flow for the three events that run one, not for noAnswer and recognizedDtmf", async () => {
    // observed: a configured endpoint stores callCompleted, callFailed and
    // userInputTimeout with { enabled, action, flowId }, the other two with
    // { enabled } only; the platform accepts every event switched on without a flow
    for (const event of ["callCompleted", "callFailed", "userInputTimeout"]) {
      stored.settings.callEvents[event] = { enabled: false };
      const r = await run({
        operation: "update_call_events",
        endpointId: ENDPOINT,
        events: { [event]: { enabled: true } },
      });
      expect(r.error).toMatch(/runs a flow and needs a flowId/);
    }
    expect(api.patch).not.toHaveBeenCalled();
    for (const event of ["noAnswer", "recognizedDtmf"]) {
      const r = await run({
        operation: "update_call_events",
        endpointId: ENDPOINT,
        events: { [event]: { enabled: true } },
      });
      expect(r.verified).toBe(true);
      expect(stored.settings.callEvents[event]).toEqual({ enabled: true });
    }
  });

  it("refuses to switch on an event that has no flow", async () => {
    const r = await run({
      operation: "update_call_events",
      endpointId: ENDPOINT,
      events: { userInputTimeout: { enabled: true } },
    });
    expect(r.error).toMatch(/needs a flowId/);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("rejects an unknown flow id format and nothing to change", async () => {
    await expect(
      run({
        operation: "update_call_events",
        endpointId: ENDPOINT,
        events: { callCompleted: { flowId: "not-a-uuid" } },
      }),
    ).rejects.toBeDefined();
    const none = await run({
      operation: "update_call_events",
      endpointId: ENDPOINT,
      events: {},
    });
    expect(none.error).toMatch(/Nothing to change/);
  });

  it("reports the platform's refusal and does not claim a change", async () => {
    api.patch.mockImplementation(async () => {
      throw new Error("Mandatory fields missing");
    });
    const r = await run({
      operation: "update_call_events",
      endpointId: ENDPOINT,
      events: { callFailed: { enabled: true } },
    });
    expect(r.error).toMatch(/platform refused/);
    expect(r.updated).toBeUndefined();
  });
});
