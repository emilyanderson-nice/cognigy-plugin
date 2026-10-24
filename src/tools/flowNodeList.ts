import { withHints } from "./filters.js";

/** The slice of the API client this module needs (keeps it easy to mock). */
export interface ChartReader {
  get(
    path: string,
    config?: { params?: Record<string, unknown> },
  ): Promise<any>;
}

export interface FlowNodeListEntry {
  id: string | undefined;
  referenceId?: string;
  type: unknown;
  label: unknown;
  parentId: string | null;
  isEntryPoint: boolean;
  isDisabled?: true;
  children?: string[];
  next?: string;
}

export interface FlowNodeListResult {
  nodes: FlowNodeListEntry[];
  total: number;
  truncated?: true;
  totalAvailable?: number;
}

interface Links {
  children: string[];
  next?: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/** One relation per node id (first wins), plus child id -> parent id (first wins). */
function indexRelations(relations: unknown): {
  links: Map<string, Links>;
  parents: Map<string, string>;
} {
  const links = new Map<string, Links>();
  const parents = new Map<string, string>();
  if (!Array.isArray(relations)) return { links, parents };

  for (const rel of relations) {
    if (typeof rel?.node !== "string" || links.has(rel.node)) continue;
    const children: string[] = Array.isArray(rel.children)
      ? rel.children.filter((c: unknown): c is string => typeof c === "string")
      : [];
    links.set(rel.node, {
      children,
      ...(isNonEmptyString(rel.next) ? { next: rel.next } : {}),
    });
    for (const child of children) {
      if (!parents.has(child)) parents.set(child, rel.node);
    }
  }
  return { links, parents };
}

function toEntry(
  n: any,
  parentId: string | null,
  links?: Links,
): FlowNodeListEntry {
  return {
    id: n._id || n.id,
    ...(isNonEmptyString(n.referenceId) ? { referenceId: n.referenceId } : {}),
    type: n.type,
    label: n.label,
    parentId,
    isEntryPoint: n.isEntryPoint ?? false,
    ...(n.isDisabled ? { isDisabled: true as const } : {}),
    ...(links && links.children.length ? { children: links.children } : {}),
    ...(links?.next ? { next: links.next } : {}),
  };
}

const isObject = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * parentId for every node id, by forward traversal (iterative, so a long
 * chain cannot overflow the stack, and independent of relation order).
 * A node listed in some `children` has that relation's node as parent. The
 * nodes of a branch hang off the branch head by `next`, so they inherit the
 * head as parent. Top-level chain nodes (and anything unreachable) get null.
 */
function assignParents(
  ids: string[],
  links: Map<string, Links>,
  heads: Map<string, string>,
): Map<string, string | null> {
  const known = new Set(ids);
  const isNext = new Set<string>();
  for (const l of links.values()) if (l.next) isNext.add(l.next);

  const assigned = new Map<string, string | null>();
  const visited = new Set<string>();
  const queue: string[] = [];

  const visit = (id: string, parent: string | null): void => {
    visited.add(id);
    if (!heads.has(id)) assigned.set(id, parent);
    if (links.get(id)?.children.length) queue.push(id);
  };
  const walk = (start: string | undefined, parent: string | null): void => {
    let cur = start;
    while (cur !== undefined && known.has(cur) && !visited.has(cur)) {
      visit(cur, parent);
      cur = links.get(cur)?.next;
    }
  };
  const drain = (): void => {
    for (let i = 0; i < queue.length; i++) {
      for (const head of links.get(queue[i])?.children ?? []) {
        if (!known.has(head)) continue;
        if (!visited.has(head)) visit(head, heads.get(head) ?? null);
        walk(links.get(head)?.next, head);
      }
    }
    queue.length = 0;
  };

  for (const id of ids) {
    if (!heads.has(id) && !isNext.has(id)) walk(id, null);
  }
  drain();
  for (const id of ids) {
    if (!visited.has(id) && links.get(id)?.children.length) {
      visit(id, null);
      drain();
    }
  }
  return new Map(
    ids.map((id) => [id, heads.get(id) ?? assigned.get(id) ?? null]),
  );
}

function fromChart(chart: any): FlowNodeListResult {
  const { links, parents } = indexRelations(chart.relations);
  const raw = chart.nodes.filter(isObject);
  const ids = raw
    .map((n: any) => n._id || n.id)
    .filter((id: unknown): id is string => typeof id === "string");
  const parentOf = assignParents(ids, links, parents);
  const nodes = raw.map((n: any) => {
    const id = n._id || n.id;
    return toEntry(n, parentOf.get(id) ?? null, links.get(id));
  });
  return { nodes, total: nodes.length };
}

const fallbackWarning = (reason: string): string =>
  `${reason}; parent/child structure is unavailable, so parentId is null for every node and children/next are not reported.`;

type StopCause = "short" | "repeated" | "failed";

const partialAction = (
  returned: number,
  reported: number | undefined,
  cause: StopCause,
): string => {
  const why =
    cause === "repeated"
      ? `The platform returned the same nodes for consecutive pages${
          reported === undefined ? "" : ` (it reported ${reported} nodes)`
        }`
      : cause === "failed"
        ? `A later page failed to load${
            reported === undefined
              ? ""
              : ` (the platform reported ${reported} nodes)`
          }`
        : reported === undefined
          ? "Paging stopped early"
          : `The platform reported ${reported} nodes`;
  return `${why}, but only ${returned} were returned, so this list is partial. Narrow the request (get a specific nodeId) instead of listing the whole flow.`;
};

/** Id of the first usable entry on a page, used to detect paging that does not advance. */
const firstUsableId = (items: unknown[]): string | undefined => {
  const first: any = items.find(isObject);
  return first?._id || first?.id;
};

/** Page /chart/nodes (limit 100, up to 20 pages) when /chart is unusable. */
async function fromNodePages(
  client: ChartReader,
  flowId: string,
  reason: string,
): Promise<FlowNodeListResult> {
  const entries: FlowNodeListEntry[] = [];
  let totalAvailable: number | undefined;
  let more = false;
  let cause: StopCause | undefined;
  let previousFirstId: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params =
      page === 0
        ? { limit: PAGE_SIZE }
        : { limit: PAGE_SIZE, skip: page * PAGE_SIZE };
    let res: any;
    try {
      res = await client.get(`/v2.0/flows/${flowId}/chart/nodes`, { params });
    } catch (err) {
      if (page === 0) throw err;
      more = false;
      cause = "failed";
      break;
    }
    const items = res?.items ?? res;
    if (!Array.isArray(items)) {
      more = false;
      if (page > 0) cause = "failed";
      break;
    }
    const firstId = firstUsableId(items);
    if (page > 0 && firstId !== undefined && firstId === previousFirstId) {
      more = false;
      cause = "repeated";
      break;
    }
    previousFirstId = firstId;
    if (typeof res?.total === "number") totalAvailable = res.total;
    entries.push(...items.filter(isObject).map((n: any) => toEntry(n, null)));
    more =
      items.length >= PAGE_SIZE &&
      !(totalAvailable !== undefined && entries.length >= totalAvailable);
    if (!more) break;
  }

  const truncated =
    more ||
    cause !== undefined ||
    (totalAvailable !== undefined && entries.length < totalAvailable);

  if (entries.length === 0 && !truncated) return { nodes: [], total: 0 };

  const result: FlowNodeListResult = {
    nodes: entries,
    total: entries.length,
    ...(truncated
      ? {
          truncated: true as const,
          ...(totalAvailable !== undefined ? { totalAvailable } : {}),
        }
      : {}),
  };
  return withHints(result, {
    warning: fallbackWarning(reason),
    ...(truncated
      ? {
          action: partialAction(
            entries.length,
            totalAvailable,
            cause ?? "short",
          ),
        }
      : {}),
  });
}

/**
 * List every node of a flow with its real structure. Reads GET /chart once
 * (nodes + relations); only if that fails or has no node list does it fall
 * back to paging /chart/nodes, which carries no structure.
 */
export async function listFlowNodes(
  client: ChartReader,
  flowId: string,
): Promise<FlowNodeListResult> {
  let chart: any;
  let reason: string;
  try {
    chart = await client.get(`/v2.0/flows/${flowId}/chart`);
    reason = "GET /chart returned no node list";
  } catch {
    reason = "GET /chart failed";
  }
  if (Array.isArray(chart?.nodes)) return fromChart(chart);
  return fromNodePages(client, flowId, reason);
}
