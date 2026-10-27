import { describe, it, expect } from "@jest/globals";
import {
  MAX_INTENT_DEPTH,
  buildTree,
  checkCreate,
  checkMove,
  resolveIntent,
  type IntentInput,
} from "../tools/intents/tree.js";

const id = (n: number): string =>
  "aaaaaaaaaaaaaaaaaaaaaa" + n.toString(16).padStart(2, "0");

const I1 = id(1);
const I2 = id(2);
const I3 = id(3);
const I4 = id(4);
const I5 = id(5);

// Billing (1)
//   Billing Cards (2)
//     Billing Cards Lost (3)
// Support (1)
//   Support Chat (2)
const standard = (): IntentInput[] => [
  { id: I1, name: "Billing", parentId: null },
  { id: I2, name: "Billing Cards", parentId: I1 },
  { id: I3, name: "Billing Cards Lost", parentId: I2 },
  { id: I4, name: "Support", parentId: null },
  { id: I5, name: "Support Chat", parentId: I4 },
];

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

describe("MAX_INTENT_DEPTH", () => {
  it("is 3", () => {
    expect(MAX_INTENT_DEPTH).toBe(3);
  });
});

describe("buildTree", () => {
  it("keeps input order, input fields, child ids, depths and roots", () => {
    const input: IntentInput[] = [
      {
        id: I1,
        name: "Billing",
        parentId: null,
        childFeatures: true,
        priority: "parents",
        sentenceCount: 7,
      },
      { id: I2, name: "Billing Cards", parentId: I1, sentenceCount: 2 },
      {
        id: I3,
        name: "Billing Cards Lost",
        parentId: I2,
        priority: "children",
      },
      { id: I4, name: "Support", parentId: null },
      { id: I5, name: "Support Chat", parentId: I4 },
    ];
    const tree = buildTree(input);
    expect(tree.nodes).toEqual([
      { ...input[0], childIds: [I2], depth: 1 },
      { ...input[1], childIds: [I3], depth: 2 },
      { ...input[2], childIds: [], depth: 3 },
      { ...input[3], childIds: [I5], depth: 1 },
      { ...input[4], childIds: [], depth: 2 },
    ]);
    expect(tree.roots).toEqual([I1, I4]);
    expect(tree.maxDepth).toBe(3);
    expect(tree.problems).toEqual([]);
  });

  it("lists children in input order even when a child appears before its parent", () => {
    const tree = buildTree([
      { id: I3, name: "Child Two", parentId: I1 },
      { id: I1, name: "Parent", parentId: null },
      { id: I2, name: "Child One", parentId: I1 },
    ]);
    const parent = tree.nodes.find((n) => n.id === I1);
    expect(parent?.childIds).toEqual([I3, I2]);
    expect(tree.nodes.map((n) => n.depth)).toEqual([2, 1, 2]);
    expect(tree.nodes.map((n) => n.id)).toEqual([I3, I1, I2]);
    expect(tree.roots).toEqual([I1]);
  });

  it("an empty input gives an empty tree with maxDepth 0", () => {
    expect(buildTree([])).toEqual({
      nodes: [],
      roots: [],
      maxDepth: 0,
      problems: [],
    });
  });

  it("a flat list of roots has maxDepth 1", () => {
    const tree = buildTree([
      { id: I1, name: "One", parentId: null },
      { id: I2, name: "Two", parentId: null },
    ]);
    expect(tree.maxDepth).toBe(1);
    expect(tree.roots).toEqual([I1, I2]);
  });

  it("a depth-2 tree has maxDepth 2", () => {
    const tree = buildTree([
      { id: I1, name: "One", parentId: null },
      { id: I2, name: "Two", parentId: I1 },
    ]);
    expect(tree.maxDepth).toBe(2);
  });

  it("reports an orphan once, with depth 0, and leaves it out of roots and maxDepth", () => {
    const tree = buildTree([
      { id: I1, name: "Billing", parentId: null },
      { id: I2, name: "Lost Child", parentId: id(0x99) },
    ]);
    expect(tree.problems).toEqual([{ id: I2, problem: "orphan" }]);
    expect(tree.nodes.find((n) => n.id === I2)?.depth).toBe(0);
    expect(tree.nodes.find((n) => n.id === I1)?.depth).toBe(1);
    expect(tree.roots).toEqual([I1]);
    expect(tree.maxDepth).toBe(1);
  });

  it("gives descendants of an orphan depth 0 and reports each as an orphan", () => {
    const tree = buildTree([
      { id: I1, name: "Orphan Head", parentId: id(0x99) },
      { id: I2, name: "Below Orphan", parentId: I1 },
      { id: I3, name: "Below Below", parentId: I2 },
    ]);
    expect(tree.nodes.map((n) => n.depth)).toEqual([0, 0, 0]);
    expect([...tree.problems].sort(byId)).toEqual([
      { id: I1, problem: "orphan" },
      { id: I2, problem: "orphan" },
      { id: I3, problem: "orphan" },
    ]);
    expect(tree.maxDepth).toBe(0);
    expect(tree.roots).toEqual([]);
  });

  it("reports a two-node parent loop as a cycle for both nodes, depth 0", () => {
    const tree = buildTree([
      { id: I1, name: "Loop A", parentId: I2 },
      { id: I2, name: "Loop B", parentId: I1 },
    ]);
    expect(tree.nodes.map((n) => n.depth)).toEqual([0, 0]);
    expect([...tree.problems].sort(byId)).toEqual([
      { id: I1, problem: "cycle" },
      { id: I2, problem: "cycle" },
    ]);
    expect(tree.maxDepth).toBe(0);
  });

  it("reports a node that is its own parent as a cycle", () => {
    const tree = buildTree([{ id: I1, name: "Self", parentId: I1 }]);
    expect(tree.problems).toEqual([{ id: I1, problem: "cycle" }]);
    expect(tree.nodes[0].depth).toBe(0);
  });

  it("reports a descendant of a cycle as a cycle too", () => {
    const tree = buildTree([
      { id: I1, name: "Loop A", parentId: I2 },
      { id: I2, name: "Loop B", parentId: I1 },
      { id: I3, name: "Hangs Off Loop", parentId: I1 },
    ]);
    expect(tree.nodes.map((n) => n.depth)).toEqual([0, 0, 0]);
    expect([...tree.problems].sort(byId)).toEqual([
      { id: I1, problem: "cycle" },
      { id: I2, problem: "cycle" },
      { id: I3, problem: "cycle" },
    ]);
  });

  it("keeps healthy parts of the tree intact next to a problem", () => {
    const tree = buildTree([
      { id: I1, name: "Billing", parentId: null },
      { id: I2, name: "Billing Cards", parentId: I1 },
      { id: I3, name: "Stray", parentId: id(0x99) },
    ]);
    expect(tree.nodes.map((n) => n.depth)).toEqual([1, 2, 0]);
    expect(tree.maxDepth).toBe(2);
    expect(tree.problems).toEqual([{ id: I3, problem: "orphan" }]);
  });
});

describe("checkCreate", () => {
  it("a root intent (null parent) is depth 1", () => {
    expect(checkCreate(buildTree(standard()), null)).toEqual({
      ok: true,
      depth: 1,
    });
  });

  it("a child of a depth-1 parent is depth 2", () => {
    expect(checkCreate(buildTree(standard()), I1)).toEqual({
      ok: true,
      depth: 2,
    });
  });

  it("a child of a depth-2 parent is depth 3", () => {
    expect(checkCreate(buildTree(standard()), I2)).toEqual({
      ok: true,
      depth: 3,
    });
  });

  it("refuses a 4th level under a depth-3 parent and names the limit and the level", () => {
    const r = checkCreate(buildTree(standard()), I3);
    expect(r).toMatchObject({ ok: false, error: "max_depth_exceeded" });
    if (r.ok) throw new Error("expected failure");
    expect(r.message).toContain("3 levels");
    expect(r.message).toContain("level 4");
  });

  it("an unknown parent gives parent_not_found", () => {
    const r = checkCreate(buildTree(standard()), id(0x77));
    expect(r).toMatchObject({ ok: false, error: "parent_not_found" });
  });

  it("fails closed with tree_incomplete when the tree has an orphan, even for a root create", () => {
    const tree = buildTree([
      ...standard(),
      { id: id(6), name: "Stray", parentId: id(0x99) },
    ]);
    expect(checkCreate(tree, null)).toMatchObject({
      ok: false,
      error: "tree_incomplete",
    });
    expect(checkCreate(tree, I1)).toMatchObject({
      ok: false,
      error: "tree_incomplete",
    });
  });

  it("tree_incomplete is checked before parent_not_found", () => {
    const tree = buildTree([{ id: I1, name: "Self", parentId: I1 }]);
    expect(checkCreate(tree, id(0x77))).toMatchObject({
      ok: false,
      error: "tree_incomplete",
    });
  });
});

describe("checkMove", () => {
  it("not_found when the moved id is unknown", () => {
    expect(checkMove(buildTree(standard()), id(0x77), I1)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("parent_not_found when the new parent is non-null and unknown", () => {
    expect(checkMove(buildTree(standard()), I5, id(0x77))).toMatchObject({
      ok: false,
      error: "parent_not_found",
    });
  });

  it("refuses moving a node under itself with cycle", () => {
    expect(checkMove(buildTree(standard()), I1, I1)).toMatchObject({
      ok: false,
      error: "cycle",
    });
  });

  it("refuses moving a node under its direct child with cycle", () => {
    expect(checkMove(buildTree(standard()), I1, I2)).toMatchObject({
      ok: false,
      error: "cycle",
    });
  });

  it("refuses moving a node under a deeper descendant with cycle", () => {
    expect(checkMove(buildTree(standard()), I1, I3)).toMatchObject({
      ok: false,
      error: "cycle",
    });
  });

  it("moving a leaf to root gives newDepth 1 and deepestLevel 1", () => {
    expect(checkMove(buildTree(standard()), I3, null)).toEqual({
      ok: true,
      newDepth: 1,
      deepestLevel: 1,
    });
  });

  it("moving a height-3 subtree to root keeps deepestLevel 3", () => {
    expect(checkMove(buildTree(standard()), I1, null)).toEqual({
      ok: true,
      newDepth: 1,
      deepestLevel: 3,
    });
  });

  it("moving a leaf under a depth-2 parent gives newDepth 3 and deepestLevel 3", () => {
    expect(checkMove(buildTree(standard()), I3, I5)).toEqual({
      ok: true,
      newDepth: 3,
      deepestLevel: 3,
    });
  });

  it("moving a height-2 subtree under a depth-1 parent fits: newDepth 2, deepestLevel 3", () => {
    expect(checkMove(buildTree(standard()), I2, I4)).toEqual({
      ok: true,
      newDepth: 2,
      deepestLevel: 3,
    });
  });

  it("moving a height-2 subtree under a depth-2 parent exceeds the limit at level 4", () => {
    const r = checkMove(buildTree(standard()), I2, I5);
    expect(r).toMatchObject({ ok: false, error: "max_depth_exceeded" });
    if (r.ok) throw new Error("expected failure");
    expect(r.message).toContain("3 levels");
    expect(r.message).toContain("level 4");
  });

  it("names the actual deepest level in the message when a subtree would reach level 5", () => {
    // Support (height 2) under Billing Cards Lost (depth 3) => newDepth 4, deepest 5
    const r = checkMove(buildTree(standard()), I4, I3);
    expect(r).toMatchObject({ ok: false, error: "max_depth_exceeded" });
    if (r.ok) throw new Error("expected failure");
    expect(r.message).toContain("3 levels");
    expect(r.message).toContain("level 5");
  });

  it("moving a height-3 subtree under a depth-1 parent exceeds the limit at level 4", () => {
    const r = checkMove(buildTree(standard()), I1, I4);
    expect(r).toMatchObject({ ok: false, error: "max_depth_exceeded" });
    if (r.ok) throw new Error("expected failure");
    expect(r.message).toContain("level 4");
  });

  it("moving a node under its current parent is allowed and keeps its depth", () => {
    expect(checkMove(buildTree(standard()), I3, I2)).toEqual({
      ok: true,
      newDepth: 3,
      deepestLevel: 3,
    });
  });

  it("moving a root to root is allowed", () => {
    expect(checkMove(buildTree(standard()), I4, null)).toEqual({
      ok: true,
      newDepth: 1,
      deepestLevel: 2,
    });
  });

  it("fails closed with tree_incomplete on a cycle in the tree, before not_found", () => {
    const tree = buildTree([
      ...standard(),
      { id: id(6), name: "Loop A", parentId: id(7) },
      { id: id(7), name: "Loop B", parentId: id(6) },
    ]);
    expect(checkMove(tree, id(0x77), null)).toMatchObject({
      ok: false,
      error: "tree_incomplete",
    });
    expect(checkMove(tree, I3, null)).toMatchObject({
      ok: false,
      error: "tree_incomplete",
    });
  });

  it("fails closed with tree_incomplete when the tree has an orphan", () => {
    const tree = buildTree([
      ...standard(),
      { id: id(6), name: "Stray", parentId: id(0x99) },
    ]);
    expect(checkMove(tree, I5, I1)).toMatchObject({
      ok: false,
      error: "tree_incomplete",
    });
  });
});

describe("resolveIntent", () => {
  it("resolves a 24-hex id that exists", () => {
    expect(resolveIntent(buildTree(standard()), I2)).toEqual({
      ok: true,
      id: I2,
    });
  });

  it("trims the reference before resolving an id", () => {
    expect(resolveIntent(buildTree(standard()), `  ${I2}\n`)).toEqual({
      ok: true,
      id: I2,
    });
  });

  it("a 24-hex reference that matches no id falls through to name matching and gives not_found", () => {
    expect(resolveIntent(buildTree(standard()), id(0x77))).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("a 24-hex reference that is not an id but is exactly a node name resolves by name", () => {
    const tree = buildTree([
      { id: I1, name: id(0x77), parentId: null },
      { id: I2, name: "Other", parentId: null },
    ]);
    expect(resolveIntent(tree, id(0x77))).toEqual({ ok: true, id: I1 });
  });

  it("resolves a unique name", () => {
    expect(resolveIntent(buildTree(standard()), "Support Chat")).toEqual({
      ok: true,
      id: I5,
    });
  });

  it("trims the reference before resolving a name", () => {
    expect(resolveIntent(buildTree(standard()), "  Support Chat \t")).toEqual({
      ok: true,
      id: I5,
    });
  });

  it("matching is case-sensitive", () => {
    expect(resolveIntent(buildTree(standard()), "support chat")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("matching is exact, not a prefix or substring", () => {
    expect(resolveIntent(buildTree(standard()), "Billing")).toEqual({
      ok: true,
      id: I1,
    });
    expect(resolveIntent(buildTree(standard()), "Billing Car")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("an unknown name gives not_found without candidates", () => {
    expect(resolveIntent(buildTree(standard()), "Nothing Here")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("the same name at different levels is ambiguous, candidates in input order, never the first", () => {
    const tree = buildTree([
      { id: I1, name: "Billing", parentId: null },
      { id: I2, name: "Cards", parentId: I1 },
      { id: I3, name: "Support", parentId: null },
      { id: I4, name: "Cards", parentId: I3 },
      { id: I5, name: "Cards", parentId: null },
    ]);
    expect(resolveIntent(tree, "Cards")).toEqual({
      ok: false,
      error: "ambiguous",
      candidates: [I2, I4, id(5)],
    });
  });

  it("resolves an ambiguous name by its Parent/Child path", () => {
    const tree = buildTree([
      { id: I1, name: "Billing", parentId: null },
      { id: I2, name: "Cards", parentId: I1 },
      { id: I3, name: "Support", parentId: null },
      { id: I4, name: "Cards", parentId: I3 },
    ]);
    expect(resolveIntent(tree, "Billing/Cards")).toEqual({ ok: true, id: I2 });
    expect(resolveIntent(tree, "Support/Cards")).toEqual({ ok: true, id: I4 });
  });

  it("resolves a three-segment Family/Group/Tag path", () => {
    expect(
      resolveIntent(
        buildTree(standard()),
        "Billing/Billing Cards/Billing Cards Lost",
      ),
    ).toEqual({ ok: true, id: I3 });
  });

  it("trims each path segment", () => {
    expect(
      resolveIntent(buildTree(standard()), "  Billing  /  Billing Cards "),
    ).toEqual({ ok: true, id: I2 });
  });

  it("path matching is case-sensitive", () => {
    expect(
      resolveIntent(buildTree(standard()), "billing/Billing Cards"),
    ).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("a path must start at a root: a child name as first segment is not_found", () => {
    expect(
      resolveIntent(buildTree(standard()), "Billing Cards/Billing Cards Lost"),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("a path whose last segment does not exist is not_found", () => {
    expect(resolveIntent(buildTree(standard()), "Billing/Nope")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("a path that skips a level is not_found", () => {
    expect(
      resolveIntent(buildTree(standard()), "Billing/Billing Cards Lost"),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("a path matching several nodes is ambiguous with their ids", () => {
    const tree = buildTree([
      { id: I1, name: "Family", parentId: null },
      { id: I2, name: "Group", parentId: I1 },
      { id: I3, name: "Family", parentId: null },
      { id: I4, name: "Group", parentId: I3 },
    ]);
    expect(resolveIntent(tree, "Family/Group")).toEqual({
      ok: false,
      error: "ambiguous",
      candidates: [I2, I4],
    });
  });

  it("an exact name containing a slash wins over path interpretation", () => {
    const tree = buildTree([
      { id: I1, name: "Billing/Cards", parentId: null },
      { id: I2, name: "Billing", parentId: null },
      { id: I3, name: "Cards", parentId: I2 },
    ]);
    expect(resolveIntent(tree, "Billing/Cards")).toEqual({ ok: true, id: I1 });
  });
});
