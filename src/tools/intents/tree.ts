export const MAX_INTENT_DEPTH = 3;

export interface IntentInput {
  id: string;
  name: string;
  parentId: string | null;
  childFeatures?: boolean;
  priority?: "parents" | "children";
  sentenceCount?: number;
}

export interface IntentNode extends IntentInput {
  childIds: string[];
  depth: number;
}

export interface IntentTree {
  nodes: IntentNode[];
  roots: string[];
  maxDepth: number;
  problems: Array<{ id: string; problem: "orphan" | "cycle" }>;
}

export type DepthError = {
  ok: false;
  error:
    | "max_depth_exceeded"
    | "parent_not_found"
    | "cycle"
    | "not_found"
    | "tree_incomplete";
  message: string;
};

type Resolved = { depth: number } | { problem: "orphan" | "cycle" };

export function buildTree(items: IntentInput[]): IntentTree {
  const byId = new Map<string, IntentInput>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);

  const resolveChain = (start: IntentInput): Resolved => {
    const seen = new Set<string>();
    let current: IntentInput = start;
    let hops = 0;
    for (;;) {
      if (seen.has(current.id)) return { problem: "cycle" };
      seen.add(current.id);
      if (current.parentId === null) return { depth: hops + 1 };
      const parent = byId.get(current.parentId);
      if (!parent) return { problem: "orphan" };
      current = parent;
      hops += 1;
    }
  };

  const childIds = new Map<string, string[]>();
  for (const item of items) {
    if (item.parentId !== null) {
      const list = childIds.get(item.parentId) ?? [];
      list.push(item.id);
      childIds.set(item.parentId, list);
    }
  }

  const problems: IntentTree["problems"] = [];
  const nodes: IntentNode[] = items.map((item) => {
    const resolved = resolveChain(item);
    if ("problem" in resolved) {
      problems.push({ id: item.id, problem: resolved.problem });
    }
    return {
      ...item,
      childIds: childIds.get(item.id) ?? [],
      depth: "depth" in resolved ? resolved.depth : 0,
    };
  });

  return {
    nodes,
    roots: items.filter((i) => i.parentId === null).map((i) => i.id),
    maxDepth: nodes.reduce((max, n) => Math.max(max, n.depth), 0),
    problems,
  };
}

const nodeById = (tree: IntentTree, id: string): IntentNode | undefined =>
  tree.nodes.find((n) => n.id === id);

const incomplete = (tree: IntentTree): DepthError | null =>
  tree.problems.length > 0
    ? {
        ok: false,
        error: "tree_incomplete",
        message: `The intent tree has ${tree.problems.length} orphaned or cyclic intent(s); refusing to change it until that is resolved.`,
      }
    : null;

const tooDeep = (level: number): DepthError => ({
  ok: false,
  error: "max_depth_exceeded",
  message: `Intents can nest at most ${MAX_INTENT_DEPTH} levels; this change would reach level ${level}.`,
});

export function checkCreate(
  tree: IntentTree,
  parentId: string | null,
): { ok: true; depth: number } | DepthError {
  const bad = incomplete(tree);
  if (bad) return bad;
  if (parentId === null) return { ok: true, depth: 1 };
  const parent = nodeById(tree, parentId);
  if (!parent) {
    return {
      ok: false,
      error: "parent_not_found",
      message: "The parent intent was not found in this flow.",
    };
  }
  const depth = parent.depth + 1;
  return depth > MAX_INTENT_DEPTH ? tooDeep(depth) : { ok: true, depth };
}

/** Height of the subtree rooted at `id`; a leaf has height 1. */
function subtreeHeight(tree: IntentTree, id: string): number {
  const node = nodeById(tree, id);
  if (!node || node.childIds.length === 0) return 1;
  return 1 + Math.max(...node.childIds.map((c) => subtreeHeight(tree, c)));
}

function isSelfOrDescendant(
  tree: IntentTree,
  ancestorId: string,
  candidateId: string,
): boolean {
  if (ancestorId === candidateId) return true;
  const node = nodeById(tree, ancestorId);
  return (node?.childIds ?? []).some((c) =>
    isSelfOrDescendant(tree, c, candidateId),
  );
}

export function checkMove(
  tree: IntentTree,
  id: string,
  newParentId: string | null,
): { ok: true; newDepth: number; deepestLevel: number } | DepthError {
  const bad = incomplete(tree);
  if (bad) return bad;
  if (!nodeById(tree, id)) {
    return {
      ok: false,
      error: "not_found",
      message: "The intent to move was not found in this flow.",
    };
  }
  let newDepth = 1;
  if (newParentId !== null) {
    const parent = nodeById(tree, newParentId);
    if (!parent) {
      return {
        ok: false,
        error: "parent_not_found",
        message: "The new parent intent was not found in this flow.",
      };
    }
    if (isSelfOrDescendant(tree, id, newParentId)) {
      return {
        ok: false,
        error: "cycle",
        message:
          "An intent cannot be moved under itself or one of its own descendants.",
      };
    }
    newDepth = parent.depth + 1;
  }
  const deepestLevel = newDepth + subtreeHeight(tree, id) - 1;
  return deepestLevel > MAX_INTENT_DEPTH
    ? tooDeep(deepestLevel)
    : { ok: true, newDepth, deepestLevel };
}

const HEX_ID = /^[0-9a-fA-F]{24}$/;

type Resolution =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" | "ambiguous"; candidates?: string[] };

const pick = (ids: string[]): Resolution =>
  ids.length === 1
    ? { ok: true, id: ids[0] }
    : ids.length === 0
      ? { ok: false, error: "not_found" }
      : { ok: false, error: "ambiguous", candidates: ids };

/** True when the chain of names from a root down to `node` equals `segments`. */
function matchesPath(
  tree: IntentTree,
  node: IntentNode,
  segments: string[],
): boolean {
  let current: IntentNode | undefined = node;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!current || current.name !== segments[i]) return false;
    current =
      current.parentId === null ? undefined : nodeById(tree, current.parentId);
    if (i === 0) return current === undefined;
  }
  return false;
}

export function resolveIntent(tree: IntentTree, ref: string): Resolution {
  const text = ref.trim();
  if (text === "") return { ok: false, error: "not_found" };

  if (HEX_ID.test(text) && nodeById(tree, text)) return { ok: true, id: text };

  const byName = tree.nodes.filter((n) => n.name === text).map((n) => n.id);
  if (byName.length > 0) return pick(byName);

  if (text.includes("/")) {
    const segments = text.split("/").map((s) => s.trim());
    return pick(
      tree.nodes.filter((n) => matchesPath(tree, n, segments)).map((n) => n.id),
    );
  }
  return { ok: false, error: "not_found" };
}
