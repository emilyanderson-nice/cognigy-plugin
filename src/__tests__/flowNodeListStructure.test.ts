import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  makeFlowNodeHarness,
  type FlowNodeHarness,
} from "./helpers/flowNodeHarness.js";

const FLOW = "60d5ec49f1a2c8b1a4e0f002";
const CHART = `/v2.0/flows/${FLOW}/chart`;
const A = "60d5ec49f1a2c8b1a4e0f0a1";
const B = "60d5ec49f1a2c8b1a4e0f0a2";
const C = "60d5ec49f1a2c8b1a4e0f0a3";
const D = "60d5ec49f1a2c8b1a4e0f0a4";
const E = "60d5ec49f1a2c8b1a4e0f0a5";

describe("manage_flow_nodes list - structure from GET /chart", () => {
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

  it("makes exactly one call, to GET /chart with the path only", async () => {
    api.get.mockResolvedValueOnce({ nodes: [], relations: [] });
    await list();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0]).toEqual([CHART]);
  });

  it("returns the full entry shape with parent, children, next and referenceId", async () => {
    api.get.mockResolvedValueOnce({
      _id: "chartid",
      nodes: [
        {
          _id: A,
          referenceId: "ref-a",
          type: "aiAgentJob",
          label: "Agent",
          isEntryPoint: true,
          isDisabled: true,
          config: { secret: 1 },
          preview: "p",
        },
        { _id: B, referenceId: "ref-b", type: "say", label: "Tool" },
        { _id: C, referenceId: "ref-c", type: "say", label: "Tool2" },
        { _id: D, type: "end", label: "End" },
      ],
      relations: [
        { _id: "r1", node: A, children: [B, C], next: D },
        { _id: "r2", node: B, children: [], next: "" },
      ],
    });
    const res = await list();
    expect(res).toEqual({
      nodes: [
        {
          id: A,
          referenceId: "ref-a",
          type: "aiAgentJob",
          label: "Agent",
          parentId: null,
          isEntryPoint: true,
          isDisabled: true,
          children: [B, C],
          next: D,
        },
        {
          id: B,
          referenceId: "ref-b",
          type: "say",
          label: "Tool",
          parentId: A,
          isEntryPoint: false,
        },
        {
          id: C,
          referenceId: "ref-c",
          type: "say",
          label: "Tool2",
          parentId: A,
          isEntryPoint: false,
        },
        {
          id: D,
          type: "end",
          label: "End",
          parentId: null,
          isEntryPoint: false,
        },
      ],
      total: 4,
    });
    expect(Object.keys(res.nodes[0])).toEqual([
      "id",
      "referenceId",
      "type",
      "label",
      "parentId",
      "isEntryPoint",
      "isDisabled",
      "children",
      "next",
    ]);
    expect(res).not.toHaveProperty("_hints");
    expect(res).not.toHaveProperty("truncated");
  });

  it("keeps the response order of nodes and does not de-duplicate ids", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [
        { _id: C, type: "say" },
        { _id: A, type: "say" },
        { _id: A, type: "end" },
      ],
      relations: [],
    });
    const res = await list();
    expect(res.nodes.map((n: any) => [n.id, n.type])).toEqual([
      [C, "say"],
      [A, "say"],
      [A, "end"],
    ]);
    expect(res.total).toBe(3);
  });

  it("falls back from _id to id and yields undefined when both are missing", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }, { id: B }, {}],
      relations: [],
    });
    const res = await list();
    expect(res.nodes.map((n: any) => n.id)).toEqual([A, B, undefined]);
    expect(res.nodes[2]).toHaveProperty("id");
  });

  it("passes type and label through unchanged, keeping undefined keys present", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }],
      relations: [],
    });
    const res = await list();
    expect(res.nodes[0]).toHaveProperty("type", undefined);
    expect(res.nodes[0]).toHaveProperty("label", undefined);
    expect(res.nodes[0].isEntryPoint).toBe(false);
  });

  it("applies isEntryPoint ?? false (explicit false and true kept)", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [
        { _id: A, isEntryPoint: true },
        { _id: B, isEntryPoint: false },
        { _id: C, isEntryPoint: null },
        { _id: D },
      ],
      relations: [],
    });
    const res = await list();
    expect(res.nodes.map((n: any) => n.isEntryPoint)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("reports isDisabled only when true", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [
        { _id: A, isDisabled: true },
        { _id: B, isDisabled: false },
        { _id: C },
      ],
      relations: [],
    });
    const res = await list();
    expect(res.nodes[0].isDisabled).toBe(true);
    expect(res.nodes[1]).not.toHaveProperty("isDisabled");
    expect(res.nodes[2]).not.toHaveProperty("isDisabled");
  });

  it.each([
    ["absent", {}, false],
    ["non-string number", { referenceId: 42 }, false],
    ["empty string", { referenceId: "" }, false],
    ["object", { referenceId: { x: 1 } }, false],
    ["null", { referenceId: null }, false],
    ["non-empty string", { referenceId: "uuid-1" }, true],
  ])("referenceId %s", async (_label, extra, included) => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A, type: "say", ...(extra as object) }],
      relations: [],
    });
    const res = await list();
    if (included) {
      expect(res.nodes[0].referenceId).toBe("uuid-1");
    } else {
      expect(res.nodes[0]).not.toHaveProperty("referenceId");
    }
  });

  it("takes parentId from the relation whose children contain the node", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }, { _id: B }, { _id: C }],
      relations: [
        { node: A, children: [B] },
        { node: B, children: [C] },
      ],
    });
    const res = await list();
    expect(res.nodes.map((n: any) => n.parentId)).toEqual([null, A, B]);
  });

  it("parentId: first relation containing the child wins", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }, { _id: B }, { _id: C }],
      relations: [
        { node: A, children: [C] },
        { node: B, children: [C] },
      ],
    });
    const res = await list();
    expect(res.nodes[2].parentId).toBe(A);
  });

  it("preserves children order and drops non-string entries", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }],
      relations: [
        { node: A, children: [E, 7, null, C, { id: B }, D, undefined] },
      ],
    });
    const res = await list();
    expect(res.nodes[0].children).toEqual([E, C, D]);
  });

  it("omits children when empty after filtering, or missing", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }, { _id: B }, { _id: C }],
      relations: [
        { node: A, children: [1, null] },
        { node: B, children: [] },
      ],
    });
    const res = await list();
    for (const n of res.nodes) {
      expect(n).not.toHaveProperty("children");
    }
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["missing", undefined],
    ["number", 5],
    ["object", { a: 1 }],
  ])("omits next when %s", async (_l, next) => {
    const relation: any = { node: A };
    if (next !== undefined) relation.next = next;
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }],
      relations: [relation],
    });
    const res = await list();
    expect(res.nodes[0]).not.toHaveProperty("next");
  });

  it("includes next when a non-empty string", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }],
      relations: [{ node: A, next: B }],
    });
    const res = await list();
    expect(res.nodes[0].next).toBe(B);
  });

  it("duplicate relations for one node: the first wins for children and next", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }],
      relations: [
        { node: A, children: [B], next: C },
        { node: A, children: [D], next: E },
      ],
    });
    const res = await list();
    expect(res.nodes[0].children).toEqual([B]);
    expect(res.nodes[0].next).toBe(C);
  });

  it("duplicate relation for a node: a later relation's children do not become parents", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }, { _id: D }],
      relations: [
        { node: A, children: [B] },
        { node: A, children: [D] },
      ],
    });
    const res = await list();
    expect(res.nodes[1].parentId).toBeNull();
  });

  it("ignores a relation without a string node (children and next unused)", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }, { _id: B }],
      relations: [
        { children: [B], next: B },
        { node: 5, children: [B] },
        { node: null, children: [B] },
      ],
    });
    const res = await list();
    expect(res.nodes[1].parentId).toBeNull();
    expect(res.nodes[0]).not.toHaveProperty("children");
    expect(res.nodes[0]).not.toHaveProperty("next");
  });

  it("passes unknown ids in children and next through unchanged", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [{ _id: A }],
      relations: [{ node: A, children: ["ghost1"], next: "ghost2" }],
    });
    const res = await list();
    expect(res.nodes[0].children).toEqual(["ghost1"]);
    expect(res.nodes[0].next).toBe("ghost2");
  });

  it("skips null, number and string entries inside nodes, not counting them", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [null, { _id: A, type: "say" }, 7, "str", undefined, { _id: B }],
      relations: [{ node: A, children: [B] }],
    });
    const res = await list();
    expect(res.nodes.map((n: any) => n.id)).toEqual([A, B]);
    expect(res.nodes[1].parentId).toBe(A);
    expect(res.total).toBe(2);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("returns { nodes: [], total: 0 } for an empty node list", async () => {
    api.get.mockResolvedValueOnce({ nodes: [], relations: [] });
    expect(await list()).toEqual({ nodes: [], total: 0 });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("tolerates missing relations", async () => {
    api.get.mockResolvedValueOnce({ nodes: [{ _id: A, type: "say" }] });
    const res = await list();
    expect(res.nodes).toEqual([
      {
        id: A,
        type: "say",
        label: undefined,
        parentId: null,
        isEntryPoint: false,
      },
    ]);
    expect(res.total).toBe(1);
  });

  it("does not leak upstream extra fields into entries", async () => {
    api.get.mockResolvedValueOnce({
      nodes: [
        {
          _id: A,
          type: "say",
          config: { text: "x" },
          preview: "p",
          mock: { enabled: true },
          comment: "c",
          extension: "e",
          parentId: "upstream-parent",
        },
      ],
      relations: [],
    });
    const res = await list();
    expect(Object.keys(res.nodes[0]).sort()).toEqual(
      ["id", "isEntryPoint", "label", "parentId", "type"].sort(),
    );
    expect(res.nodes[0].parentId).toBeNull();
  });

  it("returns new objects: mutating the result leaves the mock response intact", async () => {
    const response: any = {
      nodes: [{ _id: A, type: "say", referenceId: "r" }],
      relations: [{ node: A, children: [B, C], next: D }],
    };
    const snapshot = JSON.parse(JSON.stringify(response));
    api.get.mockResolvedValueOnce(response);
    const res = await list();
    res.nodes[0].type = "mutated";
    res.nodes[0].children.push("extra");
    res.nodes.push({ id: "extra" });
    // Requirement: entries are new objects and children arrays are copies;
    // guidance: build entries field by field and copy arrays.
    expect(response).toEqual(snapshot);
  });

  it("total equals the number of entries returned", async () => {
    api.get.mockResolvedValueOnce({
      nodes: Array.from({ length: 36 }, (_, i) => ({ _id: `n${i}` })),
      relations: [],
    });
    const res = await list();
    expect(res.nodes).toHaveLength(36);
    expect(res.total).toBe(36);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
