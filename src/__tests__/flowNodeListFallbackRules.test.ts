import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  makeFlowNodeHarness,
  type FlowNodeHarness,
} from "./helpers/flowNodeHarness.js";

const FLOW = "60d5ec49f1a2c8b1a4e0f002";
const CHART = `/v2.0/flows/${FLOW}/chart`;
const NODES = `/v2.0/flows/${FLOW}/chart/nodes`;
const SENTINEL = "SENTINEL-upstream-secret-7731";

const page = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    _id: `n${start + i}`,
    type: "say",
    label: `L${start + i}`,
  }));

describe("manage_flow_nodes list - fallback final rules", () => {
  let api: FlowNodeHarness["api"];
  let h: FlowNodeHarness["h"];

  beforeEach(() => {
    ({ api, h } = makeFlowNodeHarness());
  });

  const list = () =>
    h.handleToolCall("manage_flow_nodes", { operation: "list", flowId: FLOW });

  const chartDown = () => api.get.mockRejectedValueOnce(new Error("x"));

  describe("empty or all-skipped first page", () => {
    it.each([
      ["empty items", []],
      ["all entries skipped", [null, 3, "s", []]],
    ])(
      "%s with numeric total 7 is truncated with totalAvailable 7",
      async (_l, items) => {
        chartDown();
        api.get.mockResolvedValueOnce({ items, total: 7 });
        const res = await list();
        expect(res.nodes).toEqual([]);
        expect(res.total).toBe(0);
        expect(res.truncated).toBe(true);
        expect(res.totalAvailable).toBe(7);
        expect(typeof res._hints.warning).toBe("string");
        expect(res._hints.warning).toContain("GET /chart failed");
        expect(typeof res._hints.action).toBe("string");
        expect(res._hints.action.length).toBeGreaterThan(0);
        expect(api.get.mock.calls).toEqual([
          [CHART],
          [NODES, { params: { limit: 100 } }],
        ]);
      },
    );

    it.each([
      ["no total", { items: [] }],
      ["zero total", { items: [], total: 0 }],
      ["negative total", { items: [], total: -3 }],
      ["non-numeric total", { items: [], total: "7" }],
      ["first page not an array", { items: "x", total: 7 }],
      ["first page without items", { total: 7 }],
    ])("stays exactly { nodes: [], total: 0 } for %s", async (_l, body) => {
      chartDown();
      api.get.mockResolvedValueOnce(body);
      const res = await list();
      expect(res).toEqual({ nodes: [], total: 0 });
    });
  });

  describe("repeated page", () => {
    it("discards a page repeating the previous first id; truncated with totalAvailable", async () => {
      chartDown();
      api.get
        .mockResolvedValueOnce({ items: page(0, 100), total: 500 })
        .mockResolvedValueOnce({ items: page(0, 100), total: 500 })
        .mockResolvedValueOnce({ items: page(200, 100), total: 500 });
      const res = await list();
      expect(api.get.mock.calls).toEqual([
        [CHART],
        [NODES, { params: { limit: 100 } }],
        [NODES, { params: { limit: 100, skip: 100 } }],
      ]);
      const ids = res.nodes.map((n: any) => n.id);
      expect(ids).toHaveLength(100);
      expect(new Set(ids).size).toBe(100);
      expect(res.total).toBe(100);
      expect(res.truncated).toBe(true);
      expect(res.totalAvailable).toBe(500);
      expect(res._hints.action).toContain("same nodes");
      expect(res._hints.warning).toContain("GET /chart failed");
    });

    it("without a numeric total: truncated, no totalAvailable, no duplicates", async () => {
      chartDown();
      api.get
        .mockResolvedValueOnce({ items: page(0, 100) })
        .mockResolvedValueOnce({ items: page(0, 100) });
      const res = await list();
      expect(api.get).toHaveBeenCalledTimes(3);
      const ids = res.nodes.map((n: any) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(res.total).toBe(100);
      expect(res.truncated).toBe(true);
      expect(res).not.toHaveProperty("totalAvailable");
      expect(res._hints.action).toContain("same nodes");
    });

    it("compares first USABLE entries (leading null is ignored)", async () => {
      chartDown();
      api.get
        .mockResolvedValueOnce({ items: page(0, 100), total: 300 })
        .mockResolvedValueOnce({
          items: [null, ...page(0, 99)],
          total: 300,
        });
      const res = await list();
      expect(api.get).toHaveBeenCalledTimes(3);
      expect(res.total).toBe(100);
      expect(res.truncated).toBe(true);
      expect(res.totalAvailable).toBe(300);
    });

    it("a different first id on the next page is NOT a repeat", async () => {
      chartDown();
      api.get
        .mockResolvedValueOnce({ items: page(0, 100), total: 200 })
        .mockResolvedValueOnce({ items: page(100, 100), total: 200 });
      const res = await list();
      expect(res.total).toBe(200);
      expect(res).not.toHaveProperty("truncated");
    });
  });

  describe("a later page rejects", () => {
    it("returns what was collected, truncated, totalAvailable, no upstream text", async () => {
      chartDown();
      api.get
        .mockResolvedValueOnce({ items: page(0, 100), total: 400 })
        .mockRejectedValueOnce(new Error(SENTINEL));
      const res = await list();
      expect(api.get.mock.calls).toEqual([
        [CHART],
        [NODES, { params: { limit: 100 } }],
        [NODES, { params: { limit: 100, skip: 100 } }],
      ]);
      expect(res.nodes).toHaveLength(100);
      expect(res.total).toBe(100);
      expect(res.truncated).toBe(true);
      expect(res.totalAvailable).toBe(400);
      expect(typeof res._hints.action).toBe("string");
      expect(res._hints.action).toMatch(/fail/i);
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
    });

    it("without a numeric total: truncated, no totalAvailable, no upstream text", async () => {
      chartDown();
      api.get
        .mockResolvedValueOnce({ items: page(0, 100) })
        .mockRejectedValueOnce(new Error(SENTINEL));
      const res = await list();
      expect(res.total).toBe(100);
      expect(res.truncated).toBe(true);
      expect(res).not.toHaveProperty("totalAvailable");
      expect(res._hints.action).toMatch(/fail/i);
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
    });

    it("rejection of the FIRST fallback page still propagates", async () => {
      chartDown();
      api.get.mockRejectedValueOnce(new Error(SENTINEL));
      await expect(list()).rejects.toThrow(SENTINEL);
    });
  });

  describe("array entries are skipped", () => {
    it("inside nodes from /chart", async () => {
      api.get.mockResolvedValueOnce({
        nodes: [[], [1], { _id: "a", type: "say" }, [{ _id: "b" }]],
        relations: [],
      });
      const res = await list();
      expect(res.nodes.map((n: any) => n.id)).toEqual(["a"]);
      expect(res.total).toBe(1);
    });

    it("inside fallback items", async () => {
      chartDown();
      api.get.mockResolvedValueOnce({
        items: [[], { _id: "a" }, [1], [{ _id: "b" }]],
        total: 1,
      });
      const res = await list();
      expect(res.nodes.map((n: any) => n.id)).toEqual(["a"]);
      expect(res.total).toBe(1);
      expect(res).not.toHaveProperty("truncated");
    });
  });

  it("a full page of 100 with one null entry and total 100: 99 entries, truncated, totalAvailable 100", async () => {
    chartDown();
    api.get
      .mockResolvedValueOnce({ items: [null, ...page(0, 99)], total: 100 })
      .mockResolvedValue({ items: [], total: 100 });
    const res = await list();
    expect(res.nodes).toHaveLength(99);
    expect(res.total).toBe(99);
    expect(res.truncated).toBe(true);
    expect(res.totalAvailable).toBe(100);
    expect(res._hints.action.length).toBeGreaterThan(0);
  });
});
