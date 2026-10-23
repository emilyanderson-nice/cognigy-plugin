import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  makeFlowNodeHarness,
  type FlowNodeHarness,
} from "./helpers/flowNodeHarness.js";

const FLOW = "60d5ec49f1a2c8b1a4e0f002";
const NODE = "60d5ec49f1a2c8b1a4e0f0a1";
const PATH = `/v2.0/flows/${FLOW}/chart/nodes/${NODE}`;

describe("manage_flow_nodes get - referenceId", () => {
  let api: FlowNodeHarness["api"];
  let h: FlowNodeHarness["h"];

  beforeEach(() => {
    ({ api, h } = makeFlowNodeHarness());
  });

  const get = () =>
    h.handleToolCall("manage_flow_nodes", {
      operation: "get",
      flowId: FLOW,
      nodeId: NODE,
    });

  it("calls GET with the path only and returns referenceId right after id", async () => {
    api.get.mockResolvedValueOnce({
      _id: NODE,
      referenceId: "ref-uuid",
      type: "say",
      label: "Hi",
      config: { text: "Hello" },
    });
    const res = await get();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0]).toEqual([PATH]);
    expect(res.referenceId).toBe("ref-uuid");
    const keys = Object.keys(res);
    expect(keys.slice(0, 4)).toEqual(["id", "referenceId", "type", "label"]);
    expect(keys.indexOf("parentId")).toBeGreaterThan(keys.indexOf("label"));
  });

  it.each([
    ["absent", {}],
    ["empty string", { referenceId: "" }],
    ["number", { referenceId: 7 }],
    ["object", { referenceId: { a: 1 } }],
    ["null", { referenceId: null }],
  ])("omits referenceId (no undefined key) when %s", async (_l, extra) => {
    api.get.mockResolvedValueOnce({
      _id: NODE,
      type: "say",
      label: "Hi",
      config: {},
      ...(extra as object),
    });
    const res = await get();
    expect(Object.keys(res)).not.toContain("referenceId");
    expect(Object.keys(res).slice(0, 3)).toEqual(["id", "type", "label"]);
  });

  it("still reports id from _id and isDisabled only when true", async () => {
    api.get.mockResolvedValueOnce({
      _id: NODE,
      referenceId: "r",
      type: "say",
      isDisabled: true,
      config: {},
    });
    const res = await get();
    expect(res.id).toBe(NODE);
    expect(res.isDisabled).toBe(true);
  });
});
