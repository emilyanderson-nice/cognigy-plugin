import { readSentencePages } from "./sentences.js";
import {
  buildTree,
  resolveIntent,
  type IntentInput,
  type IntentNode,
  type IntentTree,
} from "./tree.js";
import { intentsPath, statusField, type IntentApi } from "./types.js";

export const LIST_PAGE_SIZE = 100;
export const MAX_LIST_PAGES = 20;
export const DEFAULT_CONCURRENCY = 6;
const DEFAULT_DEADLINE_MS = 60000;

export interface ReadOptions {
  includeSentenceCounts?: boolean;
  /** Fetch each parent intent's childFeatures flag (default true). */
  includeChildFeatures?: boolean;
  includeStatus?: boolean;
  concurrency?: number;
  deadlineMs?: number;
  now?: () => number;
}

export interface IntentStatus {
  state: "ok" | "low_data" | "not_scored" | "unknown";
  reasons: Array<{ type: string; intents: string[] }>;
}

export interface IntentSummary {
  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  depth: number;
  childFeatures?: boolean;
  priority?: "parents" | "children";
  sentenceCount?: number;
  /** Own plus inherited sentences; only on parents with childFeatures true. */
  effectiveSentenceCount?: number;
  status?: IntentStatus;
}

export interface FlowIntents {
  ok: true;
  intents: IntentSummary[];
  total: number;
  maxDepth: number;
  tree: IntentTree;
  problems: IntentTree["problems"];
  truncated?: true;
  countsIncomplete?: true;
}

export type ReadResult =
  | FlowIntents
  | { ok: false; error: "flow_not_readable"; httpStatus?: number };

const isPriority = (v: unknown): v is "parents" | "children" =>
  v === "parents" || v === "children";

interface ListPages {
  items: any[];
  total: number;
  truncated: boolean;
}

/** Pages the whole hierarchy; null when the first page rejects. */
async function readListPages(
  api: IntentApi,
  flowId: string,
  includeStatus: boolean,
): Promise<{ pages: ListPages } | { failure: { httpStatus?: number } }> {
  const items: any[] = [];
  let total: number | undefined;
  let cursor: string | null = null;
  let truncated = false;

  for (let pageNo = 1; pageNo <= MAX_LIST_PAGES; pageNo++) {
    const params: Record<string, unknown> = {
      limit: LIST_PAGE_SIZE,
      includeChildren: true,
    };
    if (includeStatus) params.includeFeedbackReport = true;
    if (cursor) params.next = cursor;

    let page: any;
    try {
      page = await api.get(intentsPath(flowId), { params });
    } catch (err) {
      if (pageNo === 1) return { failure: statusField(err) };
      truncated = true;
      break;
    }
    if (pageNo === 1 && typeof page?.total === "number") total = page.total;
    if (Array.isArray(page?.items)) items.push(...page.items);

    const next: string | null = page?.nextCursor ? page.nextCursor : null;
    if (!next) break;
    if (next === cursor || pageNo === MAX_LIST_PAGES) {
      truncated = true;
      break;
    }
    cursor = next;
  }
  return { pages: { items, total: total ?? items.length, truncated } };
}

/** Runs `tasks` with at most `limit` in flight; each task decides if it starts. */
async function runPool(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  };
  const size = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: size }, worker));
}

function deriveStatus(id: string, item: object): IntentStatus {
  // No feedbackReport property at all: the platform did not evaluate it.
  if (!("feedbackReport" in item)) return { state: "unknown", reasons: [] };
  const report: unknown = (item as { feedbackReport?: unknown }).feedbackReport;
  const findings: Array<{ type: string; intents: any[] }> = Array.isArray(
    (report as { findings?: unknown } | undefined)?.findings,
  )
    ? (report as { findings: any[] }).findings
    : [];
  const reasons = findings.map((f) => ({
    type: String(f?.type),
    intents: (Array.isArray(f?.intents) ? f.intents : []).map((i: any) =>
      String(i?.intentName),
    ),
  }));
  const lowData = findings.filter((f) => f?.type === "lowDataIntents");
  const listed = lowData.some(
    (f) =>
      Array.isArray(f.intents) && f.intents.some((i) => i?.intentId === id),
  );
  const state = listed ? "low_data" : lowData.length > 0 ? "not_scored" : "ok";
  return { state, reasons };
}

/**
 * effective(n) = own(n) + (childFeatures ? sum of effective(children) : 0).
 * Set only on inheriting parents, and only when every needed count is known.
 */
function addEffectiveCounts(intents: IntentSummary[]): void {
  const byId = new Map(intents.map((i) => [i.id, i]));
  const memo = new Map<string, number | undefined>();
  const effective = (id: string, path: Set<string>): number | undefined => {
    if (memo.has(id)) return memo.get(id);
    const node = byId.get(id);
    if (!node || path.has(id) || node.sentenceCount === undefined) {
      return undefined;
    }
    let total: number | undefined = node.sentenceCount;
    if (node.childFeatures === true) {
      const next = new Set(path).add(id);
      for (const child of node.childIds) {
        const sub = effective(child, next);
        total =
          total === undefined || sub === undefined ? undefined : total + sub;
      }
    }
    memo.set(id, total);
    return total;
  };
  for (const intent of intents) {
    if (intent.childIds.length === 0 || intent.childFeatures !== true) continue;
    const value = effective(intent.id, new Set());
    if (value !== undefined) intent.effectiveSentenceCount = value;
  }
}

export async function readFlowIntents(
  api: IntentApi,
  flowId: string,
  options: ReadOptions = {},
): Promise<ReadResult> {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const start = now();
  const includeStatus = options.includeStatus === true;
  const wantCounts = options.includeSentenceCounts !== false;
  const wantChildFeatures = options.includeChildFeatures !== false;

  const read = await readListPages(api, flowId, includeStatus);
  if ("failure" in read) {
    return { ok: false, error: "flow_not_readable", ...read.failure };
  }
  const { items, total, truncated } = read.pages;

  const inputs: IntentInput[] = items.map((item) => ({
    id: item._id,
    name: item.name,
    parentId: item.parentIntentId ?? null,
    ...(isPriority(item.biasTowardsParentOrChildIntents)
      ? { priority: item.biasTowardsParentOrChildIntents }
      : {}),
  }));
  const tree = buildTree(inputs);
  const itemById = new Map<string, object>(
    items.map((item) => [item._id, item]),
  );

  const intents: IntentSummary[] = tree.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    childIds: node.childIds,
    depth: node.depth,
    ...(node.priority ? { priority: node.priority } : {}),
    ...(includeStatus
      ? { status: deriveStatus(node.id, itemById.get(node.id) ?? {}) }
      : {}),
  }));

  let countsIncomplete = false;
  const guarded =
    (request: () => Promise<void>): (() => Promise<void>) =>
    async () => {
      if (now() - start >= deadlineMs) {
        countsIncomplete = true;
        return;
      }
      await request();
    };

  const tasks: Array<() => Promise<void>> = [];
  for (const intent of intents) {
    if (wantChildFeatures && intent.childIds.length > 0) {
      tasks.push(
        guarded(async () => {
          try {
            const detail = await api.get(`${intentsPath(flowId)}/${intent.id}`);
            if (typeof detail?.childFeatures === "boolean") {
              intent.childFeatures = detail.childFeatures;
            } else {
              countsIncomplete = true;
            }
          } catch {
            // field left out and flagged; a failed lookup never throws
            countsIncomplete = true;
          }
        }),
      );
    }
    if (wantCounts) {
      tasks.push(
        guarded(async () => {
          try {
            const res = await api.get(
              `${intentsPath(flowId)}/${intent.id}/sentences`,
              { params: { limit: 1 } },
            );
            if (typeof res?.total === "number")
              intent.sentenceCount = res.total;
            else countsIncomplete = true;
          } catch {
            countsIncomplete = true;
          }
        }),
      );
    }
  }
  await runPool(tasks, options.concurrency ?? DEFAULT_CONCURRENCY);
  if (wantCounts) addEffectiveCounts(intents);

  return {
    ok: true,
    intents,
    total,
    maxDepth: tree.maxDepth,
    tree,
    problems: tree.problems,
    ...(truncated ? { truncated: true as const } : {}),
    ...(countsIncomplete ? { countsIncomplete: true as const } : {}),
  };
}

type GetIntentResult =
  | {
      ok: true;
      intent: IntentSummary;
      sentences?: string[];
      sentencesTruncated?: true;
    }
  | {
      ok: false;
      error: "not_found" | "ambiguous" | "request_failed";
      candidates?: string[];
      httpStatus?: number;
    };

export async function getIntent(
  api: IntentApi,
  flowId: string,
  tree: IntentTree,
  ref: string,
  options: { includeSentences?: boolean } = {},
): Promise<GetIntentResult> {
  const resolved = resolveIntent(tree, ref);
  if (!resolved.ok) return resolved;
  const node = tree.nodes.find((n) => n.id === resolved.id) as IntentNode;

  try {
    const detail = await api.get(`${intentsPath(flowId)}/${node.id}`);
    const counted = await api.get(
      `${intentsPath(flowId)}/${node.id}/sentences`,
      { params: { limit: 1 } },
    );
    const intent: IntentSummary = {
      id: node.id,
      name: node.name,
      parentId: node.parentId,
      childIds: node.childIds,
      depth: node.depth,
      ...(node.priority ? { priority: node.priority } : {}),
      ...(typeof detail?.childFeatures === "boolean"
        ? { childFeatures: detail.childFeatures }
        : {}),
      ...(typeof counted?.total === "number"
        ? { sentenceCount: counted.total }
        : {}),
    };
    if (!options.includeSentences) return { ok: true, intent };

    const { sentences, truncated } = await readSentencePages(
      api,
      flowId,
      node.id,
    );
    return {
      ok: true,
      intent,
      sentences: sentences.map((s) => s.text),
      ...(truncated ? { sentencesTruncated: true as const } : {}),
    };
  } catch (err) {
    return { ok: false, error: "request_failed", ...statusField(err) };
  }
}

export function exportTree(
  flowId: string,
  read: FlowIntents,
): {
  flowId: string;
  total: number;
  maxDepth: number;
  truncated?: true;
  intents: Array<{
    id: string;
    name: string;
    parentId: string | null;
    depth: number;
    childFeatures?: boolean;
    priority?: "parents" | "children";
    sentenceCount?: number;
    effectiveSentenceCount?: number;
  }>;
} {
  return {
    flowId,
    total: read.total,
    maxDepth: read.maxDepth,
    ...(read.truncated ? { truncated: true as const } : {}),
    intents: read.intents.map((i) => ({
      id: i.id,
      name: i.name,
      parentId: i.parentId,
      depth: i.depth,
      ...(i.childFeatures !== undefined
        ? { childFeatures: i.childFeatures }
        : {}),
      ...(i.priority ? { priority: i.priority } : {}),
      ...(i.sentenceCount !== undefined
        ? { sentenceCount: i.sentenceCount }
        : {}),
      ...(i.effectiveSentenceCount !== undefined
        ? { effectiveSentenceCount: i.effectiveSentenceCount }
        : {}),
    })),
  };
}
