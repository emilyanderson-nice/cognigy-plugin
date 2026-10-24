import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  makeFlowNodeHarness,
  type FlowNodeHarness,
} from "./helpers/flowNodeHarness.js";

const FLOW = "60d5ec49f1a2c8b1a4e0f002";
const CHART = `/v2.0/flows/${FLOW}/chart`;

const node = (id: string, type = "say") => ({ _id: id, type, label: id });
const rel = (id: string, children: unknown[] = [], next: unknown = "") => ({
  _id: `rel-${id}`,
  node: id,
  children,
  next,
});

/** id -> parentId of a list result. */
const parents = (res: any): Record<string, unknown> =>
  Object.fromEntries(res.nodes.map((n: any) => [n.id, n.parentId]));

describe("manage_flow_nodes list - parentId by forward traversal", () => {
  let api: FlowNodeHarness["api"];
  let h: FlowNodeHarness["h"];

  beforeEach(() => {
    ({ api, h } = makeFlowNodeHarness());
  });

  const list = () =>
    h.handleToolCall("manage_flow_nodes", { operation: "list", flowId: FLOW });

  const run = async (nodes: unknown[], relations: unknown[]) => {
    api.get.mockResolvedValueOnce({ nodes, relations });
    return list();
  };

  // Probed chart, ids shortened. Branches hang off Then/Else by `next`.
  //  s0 -> a30b(If: Then a30d, Else a30e) -> a30f -> a33d(If: a33e, a33f)
  //  a30d -> a311 -> a315 -> a317(If: a318, a319);  a318 -> a33a -> a31e
  //  a30e -> a320
  //  a33e -> a341(llmPromptV2, Default a344) -> a345 -> a348(If: a34a, a34b)
  //  a34a -> a34c
  const probedNodes = () =>
    [
      "s0",
      "a30b",
      "a30d",
      "a30e",
      "a30f",
      "a311",
      "a315",
      "a317",
      "a318",
      "a319",
      "a33a",
      "a31e",
      "a320",
      "a33d",
      "a33e",
      "a33f",
      "a341",
      "a344",
      "a345",
      "a348",
      "a34a",
      "a34b",
      "a34c",
    ].map((id) => node(id, id === "a341" ? "llmPromptV2" : "say"));
  const probedRelations = () => [
    rel("s0", [], "a30b"),
    rel("a30b", ["a30d", "a30e"], "a30f"),
    rel("a30d", [], "a311"),
    rel("a30e", [], "a320"),
    rel("a30f", [], "a33d"),
    rel("a311", [], "a315"),
    rel("a315", [], "a317"),
    rel("a317", ["a318", "a319"], ""),
    rel("a318", [], "a33a"),
    rel("a319"),
    rel("a33a", [], "a31e"),
    rel("a31e"),
    rel("a320"),
    rel("a33d", ["a33e", "a33f"], ""),
    rel("a33e", [], "a341"),
    rel("a33f"),
    rel("a341", ["a344"], "a345"),
    rel("a344"),
    rel("a345", [], "a348"),
    rel("a348", ["a34a", "a34b"], ""),
    rel("a34a", [], "a34c"),
    rel("a34b"),
    rel("a34c"),
  ];
  const probedExpected = {
    s0: null,
    a30b: null,
    a30d: "a30b",
    a30e: "a30b",
    a30f: null,
    a311: "a30d",
    a315: "a30d",
    a317: "a30d",
    a318: "a317",
    a319: "a317",
    a33a: "a318",
    a31e: "a318",
    a320: "a30e",
    a33d: null,
    a33e: "a33d",
    a33f: "a33d",
    a341: "a33e",
    a344: "a341",
    a345: "a33e",
    a348: "a33e",
    a34a: "a348",
    a34b: "a348",
    a34c: "a34a",
  };

  it("probed chart: exact parentId for every node, one GET /chart call", async () => {
    const res = await run(probedNodes(), probedRelations());
    expect(parents(res)).toEqual(probedExpected);
    expect(res.total).toBe(23);
    expect(api.get.mock.calls).toEqual([[CHART]]);
  });

  it("probed chart: contract anchors (a311/a315/a317 under a30d, a30f null, a33a/a31e under a318, a345/a348 under a33e, a34a/a34b under a348)", async () => {
    const p = parents(await run(probedNodes(), probedRelations()));
    expect([p.a311, p.a315, p.a317]).toEqual(["a30d", "a30d", "a30d"]);
    expect(p.a30f).toBeNull();
    expect([p.a33a, p.a31e]).toEqual(["a318", "a318"]);
    expect([p.a345, p.a348]).toEqual(["a33e", "a33e"]);
    expect([p.a34a, p.a34b]).toEqual(["a348", "a348"]);
  });

  it("probed chart: entry shape and children/next fields are unchanged by traversal", async () => {
    const res = await run(probedNodes(), probedRelations());
    const a30b = res.nodes.find((n: any) => n.id === "a30b");
    expect(a30b).toEqual({
      id: "a30b",
      type: "say",
      label: "a30b",
      parentId: null,
      isEntryPoint: false,
      children: ["a30d", "a30e"],
      next: "a30f",
    });
    expect(res.nodes.map((n: any) => n.id)).toEqual(
      probedNodes().map((n) => n._id),
    );
  });

  it("shuffled relations (no duplicates) give identical output", async () => {
    const baseline = await run(probedNodes(), probedRelations());
    const rels = probedRelations();
    const permutations: unknown[][] = [
      [...rels].reverse(),
      [...rels.slice(7), ...rels.slice(0, 7)],
      [...rels.slice(15), ...rels.slice(0, 15)],
      rels.filter((_, i) => i % 2 === 0).concat(rels.filter((_, i) => i % 2)),
      rels.filter((_, i) => i % 2).concat(rels.filter((_, i) => i % 2 === 0)),
    ];
    // a deterministic pseudo-random shuffle too
    let seed = 12345;
    const shuffled = [...rels];
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    permutations.push(shuffled);
    for (const perm of permutations) {
      api.get.mockReset();
      const res = await run(probedNodes(), perm);
      expect(res).toEqual(baseline);
    }
  });

  describe("join node (container If is the next of a top-level predecessor and of a branch's last node)", () => {
    const nodes = () => ["P", "I", "T", "X", "F"].map((id) => node(id));
    const relations = () => [
      rel("P", [], "I"),
      rel("I", ["T"], "F"),
      rel("T", [], "X"),
      rel("X", [], "I"),
      rel("F"),
    ];
    const expected = { P: null, I: null, T: "I", X: "T", F: null };

    it("relation order as built", async () => {
      expect(parents(await run(nodes(), relations()))).toEqual(expected);
    });

    it("reversed relation order", async () => {
      expect(parents(await run(nodes(), [...relations()].reverse()))).toEqual(
        expected,
      );
    });

    it("reversed nodes order too", async () => {
      expect(
        parents(await run([...nodes()].reverse(), [...relations()].reverse())),
      ).toEqual(expected);
    });
  });

  it("nested If inside a Then: nodes after the inner If belong to the outer Then", async () => {
    // P -> I(T, E) -> F ; T -> J(JT, JE) -> N2 ; JT -> M
    const res = await run(
      ["P", "I", "T", "E", "F", "J", "JT", "JE", "N2", "M"].map((id) =>
        node(id),
      ),
      [
        rel("P", [], "I"),
        rel("I", ["T", "E"], "F"),
        rel("T", [], "J"),
        rel("E"),
        rel("F"),
        rel("J", ["JT", "JE"], "N2"),
        rel("JT", [], "M"),
        rel("JE"),
        rel("N2"),
        rel("M"),
      ],
    );
    expect(parents(res)).toEqual({
      P: null,
      I: null,
      T: "I",
      E: "I",
      F: null,
      J: "T",
      JT: "J",
      JE: "J",
      N2: "T",
      M: "JT",
    });
  });
});
