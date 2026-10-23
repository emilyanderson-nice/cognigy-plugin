import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  makeFlowNodeHarness,
  type FlowNodeHarness,
} from "./helpers/flowNodeHarness.js";

const FLOW = "60d5ec49f1a2c8b1a4e0f002";
const CHART = `/v2.0/flows/${FLOW}/chart`;
const NODES = `/v2.0/flows/${FLOW}/chart/nodes`;

const page = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    _id: `n${start + i}`,
    referenceId: `r${start + i}`,
    type: "say",
    label: `L${start + i}`,
    parentId: null,
    config: { leak: true },
    preview: "p",
  }));

describe("manage_flow_nodes list - fallback to GET /chart/nodes", () => {
  let api: FlowNodeHarness["api"];
  let h: FlowNodeHarness["h"];

  beforeEach(() => {
    ({ api, h } = makeFlowNodeHarness());
  });

  const list = () =>
    h.handleToolCall("manage_flow_nodes", {
      operation: "list",
      flowId: FLOW,
    });

  const callsTo = (path: string) =>
    api.get.mock.calls.filter((c) => c[0] === path);

  it("rejected /chart: pages /chart/nodes with limit 100, no skip key on page 1", async () => {
    api.get
      .mockRejectedValueOnce(new Error("chart down"))
      .mockResolvedValueOnce({ items: page(0, 3), total: 3 });
    const res = await list();
    expect(api.get.mock.calls).toEqual([
      [CHART],
      [NODES, { params: { limit: 100 } }],
    ]);
    expect(Object.keys((api.get.mock.calls[1][1] as any).params)).toEqual([
      "limit",
    ]);
    expect(res.total).toBe(3);
  });

  it("fallback entries: exact shape, no children/next, parentId null, no leaks", async () => {
    api.get.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({
      items: [
        {
          _id: "a",
          referenceId: "ra",
          type: "say",
          label: "A",
          isEntryPoint: true,
          isDisabled: true,
          parentId: "upstream",
          config: { leak: 1 },
          preview: "p",
          mock: {},
          comment: "c",
        },
        { _id: "b", referenceId: "", type: "end", label: "B" },
      ],
      total: 2,
    });
    const res = await list();
    expect(res.nodes).toEqual([
      {
        id: "a",
        referenceId: "ra",
        type: "say",
        label: "A",
        parentId: null,
        isEntryPoint: true,
        isDisabled: true,
      },
      {
        id: "b",
        type: "end",
        label: "B",
        parentId: null,
        isEntryPoint: false,
      },
    ]);
    expect(res.total).toBe(2);
    expect(res).not.toHaveProperty("truncated");
  });

  it("rejected /chart: warning contains 'GET /chart failed' and the null-parent statement", async () => {
    api.get
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ items: page(0, 1), total: 1 });
    const res = await list();
    expect(res._hints.warning).toContain("GET /chart failed");
    expect(res._hints.warning).not.toContain(
      "GET /chart returned no node list",
    );
    expect(res._hints.warning).toContain("parentId");
    expect(res._hints.warning).toContain("null");
    expect(res._hints.warning.toLowerCase()).toContain("unavailable");
  });

  it.each([
    ["nodes missing", { relations: [] }],
    ["nodes not an array (object)", { nodes: { a: 1 }, relations: [] }],
    ["nodes a string", { nodes: "x" }],
    ["nodes null", { nodes: null }],
  ])(
    "unusable /chart (%s): falls back with the 'returned no node list' warning",
    async (_l, body) => {
      api.get
        .mockResolvedValueOnce(body)
        .mockResolvedValueOnce({ items: page(0, 2), total: 2 });
      const res = await list();
      expect(api.get.mock.calls).toEqual([
        [CHART],
        [NODES, { params: { limit: 100 } }],
      ]);
      expect(res._hints.warning).toContain("GET /chart returned no node list");
      expect(res._hints.warning).not.toContain("GET /chart failed");
      expect(res._hints.warning).toContain("parentId");
      expect(res.total).toBe(2);
    },
  );

  it("fallback rejection propagates (no catch)", async () => {
    api.get
      .mockRejectedValueOnce(new Error("chart down"))
      .mockRejectedValueOnce(new Error("nodes down too"));
    await expect(list()).rejects.toThrow("nodes down too");
  });

  it("stops when the collected count reaches the numeric total (two pages)", async () => {
    api.get
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ items: page(0, 100), total: 150 })
      .mockResolvedValueOnce({ items: page(100, 50), total: 150 });
    const res = await list();
    expect(api.get.mock.calls).toEqual([
      [CHART],
      [NODES, { params: { limit: 100 } }],
      [NODES, { params: { limit: 100, skip: 100 } }],
    ]);
    expect(res.total).toBe(150);
    expect(res.nodes).toHaveLength(150);
    expect(res.nodes[149].id).toBe("n149");
    expect(res).not.toHaveProperty("truncated");
  });

  it("stops when total is reached exactly on a full page (no extra request)", async () => {
    api.get
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ items: page(0, 100), total: 100 });
    const res = await list();
    expect(callsTo(NODES)).toHaveLength(1);
    expect(res.total).toBe(100);
  });

  it("a short page with a larger numeric total is reported as truncated, never silently", async () => {
    api.get
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ items: page(0, 99), total: 500 });
    const res = await list();
    expect(callsTo(NODES)).toHaveLength(1);
    expect(res.total).toBe(99);
    expect(res.nodes).toHaveLength(99);
    expect(res.truncated).toBe(true);
    expect(res.totalAvailable).toBe(500);
    expect(typeof res._hints.action).toBe("string");
    expect(res._hints.action).toContain("500");
    expect(res._hints.action).toContain("99");
    expect(res._hints.warning).toContain("GET /chart failed");
  });

  it("a short page whose numeric total equals the collected count is NOT truncated", async () => {
    api.get
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ items: page(0, 80), total: 80 });
    const res = await list();
    expect(res.total).toBe(80);
    expect(res).not.toHaveProperty("truncated");
    expect(res).not.toHaveProperty("totalAvailable");
    expect(res._hints.action ?? "").not.toContain("80 nodes");
  });

  it("a later page that is not an array sets truncated with the numeric total as totalAvailable", async () => {
    api.get
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ items: page(0, 100), total: 250 })
      .mockResolvedValueOnce({ weird: true });
    const res = await list();
    expect(api.get.mock.calls).toEqual([
      [CHART],
      [NODES, { params: { limit: 100 } }],
      [NODES, { params: { limit: 100, skip: 100 } }],
    ]);
    expect(res.total).toBe(100);
    expect(res.truncated).toBe(true);
    expect(res.totalAvailable).toBe(250);
    expect(res._hints.action).toContain("250");
    expect(res._hints.action).toContain("100");
  });

  it("a later non-array page with no numeric total is truncated without totalAvailable", async () => {
    api.get
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ items: page(0, 100) })
      .mockResolvedValueOnce({ items: "nope" });
    const res = await list();
    expect(res.total).toBe(100);
    expect(res.truncated).toBe(true);
    expect(res).not.toHaveProperty("totalAvailable");
    expect(typeof res._hints.action).toBe("string");
    expect(res._hints.action.length).toBeGreaterThan(0);
  });

  it("skips null, number and string entries in fallback items, not counting them", async () => {
    api.get.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({
      items: [null, { _id: "a", type: "say" }, 7, "str", { _id: "b" }],
      total: 2,
    });
    const res = await list();
    expect(res.nodes.map((n: any) => n.id)).toEqual(["a", "b"]);
    expect(res.total).toBe(2);
    expect(res).not.toHaveProperty("truncated");
  });

  it("non-numeric total plus a short page stops", async () => {
    api.get
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ items: page(0, 100), total: "many" })
      .mockResolvedValueOnce({ items: page(100, 7), total: "many" });
    const res = await list();
    expect(api.get.mock.calls).toEqual([
      [CHART],
      [NODES, { params: { limit: 100 } }],
      [NODES, { params: { limit: 100, skip: 100 } }],
    ]);
    expect(res.total).toBe(107);
    expect(res).not.toHaveProperty("truncated");
  });

  it("an exactly-100 page with no total requests another page", async () => {
    api.get
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ items: page(0, 100) })
      .mockResolvedValueOnce({ items: page(100, 0) });
    const res = await list();
    expect(callsTo(NODES)).toHaveLength(2);
    expect(api.get.mock.calls[2]).toEqual([
      NODES,
      { params: { limit: 100, skip: 100 } },
    ]);
    expect(res.total).toBe(100);
  });

  it("caps at 20 pages: truncated true, totalAvailable, narrowing hint", async () => {
    api.get.mockRejectedValueOnce(new Error("x"));
    for (let p = 0; p < 25; p++) {
      api.get.mockResolvedValueOnce({ items: page(p * 100, 100), total: 5000 });
    }
    const res = await list();
    const nodeCalls = callsTo(NODES);
    expect(nodeCalls).toHaveLength(20);
    expect(nodeCalls[0][1]).toEqual({ params: { limit: 100 } });
    expect(nodeCalls[1][1]).toEqual({ params: { limit: 100, skip: 100 } });
    expect(nodeCalls[19][1]).toEqual({ params: { limit: 100, skip: 1900 } });
    expect(res.nodes).toHaveLength(2000);
    expect(res.total).toBe(2000);
    expect(res.truncated).toBe(true);
    expect(res.totalAvailable).toBe(5000);
    expect(res._hints.warning).toContain("GET /chart failed");
    expect(typeof res._hints.action).toBe("string");
    expect(res._hints.action.length).toBeGreaterThan(0);
  });

  it("20-page cap with no numeric total: truncated true, no totalAvailable", async () => {
    api.get.mockRejectedValueOnce(new Error("x"));
    for (let p = 0; p < 25; p++) {
      api.get.mockResolvedValueOnce({ items: page(p * 100, 100) });
    }
    const res = await list();
    expect(callsTo(NODES)).toHaveLength(20);
    expect(res.truncated).toBe(true);
    expect(res.total).toBe(2000);
    expect(res).not.toHaveProperty("totalAvailable");
  });

  it.each([
    ["no items key", {}],
    ["items not an array", { items: "x" }],
    ["empty items", { items: [] }],
  ])(
    "fallback page with %s returns { nodes: [], total: 0 }",
    async (_l, body) => {
      api.get.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(body);
      const res = await list();
      expect(res.nodes).toEqual([]);
      expect(res.total).toBe(0);
      expect(callsTo(NODES)).toHaveLength(1);
    },
  );

  it("successful /chart never touches /chart/nodes", async () => {
    api.get.mockResolvedValueOnce({ nodes: [{ _id: "a" }], relations: [] });
    await list();
    expect(callsTo(NODES)).toHaveLength(0);
  });
});
