import type { IntentSummary } from "./reader.js";

/** Compact and summary views of an intent list (pure). */

export type ListView = "full" | "compact" | "summary";

export interface CompactTable {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  priority?: "parents" | "children";
}

export interface ReasonGroup {
  type: string;
  intents: string[];
  intentCount: number;
}

export interface ListSummary {
  byDepth: Record<string, number>;
  sentenceCounts?: {
    counted: number;
    min: number;
    max: number;
    median: number;
    sum: number;
  };
  inheriting?: number;
  states?: {
    ok: number;
    low_data: number;
    not_scored: number;
    unknown: number;
  };
  reasons?: ReasonGroup[];
  attention?: Array<{
    id: string;
    name: string;
    state: "low_data" | "unknown";
  }>;
  attentionMore?: number;
}

const MAX_ATTENTION = 50;

type Cell = string | number | boolean | null;

const OPTIONAL_COLUMNS: Array<{
  name: string;
  value: (i: IntentSummary) => Cell | undefined;
}> = [
  { name: "sentenceCount", value: (i) => i.sentenceCount },
  { name: "effectiveSentenceCount", value: (i) => i.effectiveSentenceCount },
  { name: "childFeatures", value: (i) => i.childFeatures },
  { name: "state", value: (i) => i.status?.state },
];

export function compactTable(intents: IntentSummary[]): CompactTable {
  const optional = OPTIONAL_COLUMNS.filter((c) =>
    intents.some((i) => c.value(i) !== undefined),
  );
  const columns = [
    "id",
    "name",
    "parentId",
    "depth",
    ...optional.map((c) => c.name),
  ];
  const rows = intents.map((i): Cell[] => [
    i.id,
    i.name,
    i.parentId,
    i.depth,
    ...optional.map((c) => c.value(i) ?? null),
  ]);
  const first = intents[0]?.priority;
  const sharedPriority =
    first !== undefined && intents.every((i) => i.priority === first);
  return { columns, rows, ...(sharedPriority ? { priority: first } : {}) };
}

export function groupReasons(intents: IntentSummary[]): ReasonGroup[] {
  const groups = new Map<string, ReasonGroup>();
  for (const intent of intents) {
    for (const reason of intent.status?.reasons ?? []) {
      const key = JSON.stringify([reason.type, reason.intents]);
      const group = groups.get(key);
      if (group) group.intentCount += 1;
      else {
        groups.set(key, {
          type: reason.type,
          intents: reason.intents,
          intentCount: 1,
        });
      }
    }
  }
  const compare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;
  return [...groups.values()].sort(
    (a, b) =>
      b.intentCount - a.intentCount ||
      compare(a.type, b.type) ||
      compare(a.intents.join("\u0000"), b.intents.join("\u0000")),
  );
}

export function summarize(intents: IntentSummary[]): ListSummary {
  const byDepth: Record<string, number> = {};
  for (const i of intents) {
    byDepth[String(i.depth)] = (byDepth[String(i.depth)] ?? 0) + 1;
  }
  const summary: ListSummary = { byDepth };

  const counts = intents
    .flatMap((i) =>
      typeof i.sentenceCount === "number" ? [i.sentenceCount] : [],
    )
    .sort((a, b) => a - b);
  if (counts.length > 0) {
    summary.sentenceCounts = {
      counted: counts.length,
      min: counts[0],
      max: counts[counts.length - 1],
      median: counts[Math.floor((counts.length - 1) / 2)],
      sum: counts.reduce((total, n) => total + n, 0),
    };
  }

  const inheriting = intents.filter(
    (i) => i.effectiveSentenceCount !== undefined,
  ).length;
  if (inheriting > 0) summary.inheriting = inheriting;

  const withStatus = intents.filter((i) => i.status !== undefined);
  if (withStatus.length > 0) {
    const states = { ok: 0, low_data: 0, not_scored: 0, unknown: 0 };
    for (const i of withStatus) if (i.status) states[i.status.state] += 1;
    summary.states = states;
  }

  const reasons = groupReasons(intents);
  if (reasons.length > 0) summary.reasons = reasons;

  const attention = intents.flatMap((i) =>
    i.status?.state === "low_data" || i.status?.state === "unknown"
      ? [{ id: i.id, name: i.name, state: i.status.state }]
      : [],
  );
  if (attention.length > 0) {
    summary.attention = attention.slice(0, MAX_ATTENTION);
    if (attention.length > MAX_ATTENTION) {
      summary.attentionMore = attention.length - MAX_ATTENTION;
    }
  }
  return summary;
}
