import { messageTemplate, type LogEntry } from "./logScrub.js";

export interface LogSummary {
  total: number | null;
  sampled: number;
  levels: Record<string, number>;
  span: { from: string; to: string } | null;
  topMessages: {
    template: string;
    count: number;
    level: string;
    firstSeen: string;
    lastSeen: string;
  }[];
  flows: { flowId: string; flowName?: string; count: number }[];
  truncated: boolean;
}

const MAX_TOP_MESSAGES = 10;
const MAX_FLOWS = 5;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function timestampRange(stamps: string[]): { min: string; max: string } | null {
  const present = stamps.filter((s) => s !== "");
  if (present.length === 0) return null;
  return {
    min: present.reduce((a, b) => (b < a ? b : a)),
    max: present.reduce((a, b) => (b > a ? b : a)),
  };
}

function topMessages(entries: LogEntry[]): LogSummary["topMessages"] {
  const groups = new Map<
    string,
    { template: string; level: string; stamps: string[] }
  >();
  for (const entry of entries) {
    const template = messageTemplate(entry.msg);
    const key = JSON.stringify([entry.level, template]);
    const group = groups.get(key) ?? {
      template,
      level: entry.level,
      stamps: [],
    };
    group.stamps.push(entry.timestamp);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.stamps.length - a.stamps.length ||
        compare(a.template, b.template) ||
        compare(a.level, b.level),
    )
    .slice(0, MAX_TOP_MESSAGES)
    .map((group) => {
      const range = timestampRange(group.stamps);
      return {
        template: group.template,
        count: group.stamps.length,
        level: group.level,
        firstSeen: range?.min ?? "",
        lastSeen: range?.max ?? "",
      };
    });
}

function topFlows(entries: LogEntry[]): LogSummary["flows"] {
  const groups = new Map<
    string,
    { flowId: string; flowName?: string; count: number }
  >();
  for (const entry of entries) {
    if (!entry.flowId) continue;
    const group = groups.get(entry.flowId) ?? {
      flowId: entry.flowId,
      count: 0,
    };
    group.count += 1;
    if (group.flowName === undefined && entry.flowName)
      group.flowName = entry.flowName;
    groups.set(entry.flowId, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || compare(a.flowId, b.flowId))
    .slice(0, MAX_FLOWS);
}

export function summarizeEntries(
  entries: LogEntry[],
  options: { total: number | null; truncated?: boolean },
): LogSummary {
  const counts = new Map<string, number>();
  for (const entry of entries)
    counts.set(entry.level, (counts.get(entry.level) ?? 0) + 1);
  const levels: Record<string, number> = Object.fromEntries(counts);
  const range = timestampRange(entries.map((e) => e.timestamp));
  return {
    total: options.total,
    sampled: entries.length,
    levels,
    span: range ? { from: range.min, to: range.max } : null,
    topMessages: topMessages(entries),
    flows: topFlows(entries),
    truncated:
      options.truncated ??
      (options.total !== null && options.total > entries.length),
  };
}
