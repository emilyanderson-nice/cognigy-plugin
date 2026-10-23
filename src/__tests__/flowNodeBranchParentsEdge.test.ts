import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  makeFlowNodeHarness,
  type FlowNodeHarness,
} from "./helpers/flowNodeHarness.js";

const FLOW = "60d5ec49f1a2c8b1a4e0f002";

const node = (id: string, type = "say") => ({ _id: id, type, label: id });
const rel = (id: string, children: unknown[] = [], next: unknown = "") => ({
  _id: `rel-${id}`,
  node: id,
  children,
  next,
});
const parents = (res: any): Record<string, unknown> =>
  Object.fromEntries(res.nodes.map((n: any) => [n.id, n.parentId]));

describe("manage_flow_nodes list - parentId edge cases", () => {
  let api: FlowNodeHarness["api"];
  let h: FlowNodeHarness["h"];

  beforeEach(() => {
    ({ api, h } = makeFlowNodeHarness());
  });

  const run = async (nodes: unknown[], relations: unknown[]) => {
    api.get.mockResolvedValueOnce({ nodes, relations });
    return h.handleToolCall("manage_flow_nodes", {
      operation: "list",
      flowId: FLOW,
    });
  };
  const ids = (...x: string[]) => x.map((id) => node(id));

  it("empty branch whose head next points back at the container changes nothing", async () => {
    const res = await run(ids("P", "I", "T", "F"), [
      rel("P", [], "I"),
      rel("I", ["T"], "F"),
      rel("T", [], "I"),
      rel("F"),
    ]);
    expect(parents(res)).toEqual({ P: null, I: null, T: "I", F: null });
  });

  it("self-next gives null and does not throw or loop", async () => {
    const res = await run(ids("A"), [rel("A", [], "A")]);
    expect(parents(res)).toEqual({ A: null });
    expect(res.total).toBe(1);
  });

  it("two-node cycle gives null for both and terminates", async () => {
    const res = await run(ids("A", "B"), [
      rel("A", [], "B"),
      rel("B", [], "A"),
    ]);
    expect(parents(res)).toEqual({ A: null, B: null });
  });

  it("a cycle reachable from a root terminates with null for all", async () => {
    const res = await run(ids("R", "A", "B"), [
      rel("R", [], "A"),
      rel("A", [], "B"),
      rel("B", [], "A"),
    ]);
    expect(parents(res)).toEqual({ R: null, A: null, B: null });
  });

  it("a head that is also the next of another node keeps rule 1", async () => {
    const res = await run(ids("P", "I", "K", "H"), [
      rel("P", [], "I"),
      rel("I", ["H"]),
      rel("K", [], "H"),
      rel("H"),
    ]);
    expect(parents(res)).toEqual({ P: null, I: null, K: null, H: "I" });
  });

  it("aiAgentJob tool branch: heads under the agent, their chains under the head", async () => {
    const res = await run(
      [
        node("A", "aiAgentJob"),
        node("T1", "aiAgentJobTool"),
        node("T2", "aiAgentJobTool"),
        node("C1"),
        node("N"),
      ],
      [
        rel("A", ["T1", "T2"], "N"),
        rel("T1", [], "C1"),
        rel("T2"),
        rel("C1"),
        rel("N"),
      ],
    );
    expect(parents(res)).toEqual({
      A: null,
      T1: "A",
      T2: "A",
      C1: "T1",
      N: null,
    });
  });

  it("node after a top-level llmPromptV2 (with a Default child) takes the llm node's parent (null)", async () => {
    const res = await run(
      [node("L", "llmPromptV2"), node("D"), node("X")],
      [rel("L", ["D"], "X"), rel("D"), rel("X")],
    );
    expect(parents(res)).toEqual({ L: null, D: "L", X: null });
  });

  it("unknown ids are ignored and passed through; relations without a string node are ignored", async () => {
    const res = await run(ids("A"), [
      rel("A", ["ghost"], "ghost2"),
      { children: ["A"], next: "A" },
      { node: 5, children: ["A"], next: "A" },
      { node: null, next: "A" },
    ]);
    expect(parents(res)).toEqual({ A: null });
    expect(res.nodes[0].children).toEqual(["ghost"]);
    expect(res.nodes[0].next).toBe("ghost2");
  });

  it("next given as an array is ignored (the node it names is not chained)", async () => {
    const res = await run(ids("I", "T", "X"), [
      rel("I", ["T"]),
      rel("T", [], ["X"]),
      rel("X"),
    ]);
    expect(parents(res)).toEqual({ I: null, T: "I", X: null });
    expect(res.nodes[1]).not.toHaveProperty("next");
  });

  it("a 1000-node chain inside a branch resolves iteratively (no recursion overflow)", async () => {
    const chain = Array.from({ length: 999 }, (_, i) => `c${i}`);
    const all = ["I", "H", ...chain];
    const relations = [
      rel("I", ["H"]),
      rel("H", [], chain[0]),
      ...chain.map((id, i) => rel(id, [], chain[i + 1] ?? "")),
    ];
    const res = await run(ids(...all), relations);
    expect(res.total).toBe(1001);
    const p = parents(res);
    expect(p.I).toBeNull();
    expect(p.H).toBe("I");
    expect(p.c0).toBe("H");
    expect(p.c998).toBe("H");
    expect(res.nodes.filter((n: any) => n.parentId === "H")).toHaveLength(999);
  });

  it("a 1000-node top-level chain is all null", async () => {
    const all = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    const res = await run(
      ids(...all),
      all.map((id, i) => rel(id, [], all[i + 1] ?? "")),
    );
    expect(res.nodes.every((n: any) => n.parentId === null)).toBe(true);
    expect(res.total).toBe(1000);
  });

  it("unreachable container: its heads and their chains are still resolved", async () => {
    // X <-> C form a cycle with no root; C has a branch head H -> H2
    const res = await run(ids("X", "C", "H", "H2"), [
      rel("X", [], "C"),
      rel("C", ["H"], "X"),
      rel("H", [], "H2"),
      rel("H2"),
    ]);
    expect(parents(res)).toEqual({ X: null, C: null, H: "C", H2: "H" });
  });

  it("fallback path is unchanged: parentId null for every node", async () => {
    api.get.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({
      items: [
        { _id: "a", type: "say", parentId: "upstream" },
        { _id: "b", type: "say" },
      ],
      total: 2,
    });
    const res = await h.handleToolCall("manage_flow_nodes", {
      operation: "list",
      flowId: FLOW,
    });
    expect(parents(res)).toEqual({ a: null, b: null });
    expect(res._hints.warning).toContain("GET /chart failed");
  });
});
