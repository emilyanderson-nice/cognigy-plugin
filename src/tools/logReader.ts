import { toLogEntry, type LogEntry } from "./logScrub.js";
import { summarizeEntries } from "./logSummary.js";

export interface LogReadArgs {
  projectId: string;
  startDate?: string;
  endDate?: string;
  logLevel?: string[];
  search?: string;
  flowName?: string;
  sessionId?: string;
  view?: "summary" | "entries";
  limit?: number;
  skip?: number;
  sort?: string;
}

export interface LogReadResult {
  body: Record<string, unknown>;
  hint?: { warning?: string; action?: string };
}

export const SUMMARY_PAGE_SIZE = 100;
export const SUMMARY_MAX_PAGES = 3;
export const DEFAULT_DEADLINE_MS = 20_000;
export const ENTRIES_DEFAULT_LIMIT = 25;
export const ENTRIES_MAX_LIMIT = 100;

const TAIL_MAX_ITEMS = 100;
const CALL_TIMEOUT_MS = 10_000;
const MAX_SKIP = 100_000;
const DEFAULT_WINDOW_MS = 3_600_000;
const END_SLACK_MS = 60_000;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const SORT_VALUE = /^timestamp:(asc|desc)$/;

function isRealDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const offsetHour = m[7] === undefined ? 0 : Number(m[7]);
  const offsetMinute = m[8] === undefined ? 0 : Number(m[8]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

interface LogClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(url: string, config?: any): Promise<any>;
}

const RETENTION_ACTION = "Log retention is typically about 24 hours.";
const NARROW_ACTION =
  "Narrow with search, logLevel, flowName, a shorter window or sessionId. " +
  RETENTION_ACTION;
const PAGING_NOTE =
  ' limit and skip apply only to view: "entries" (use that view to page); the summary ignores them.';
const EMPTY_ACTION =
  "No log entries found. Widen the window, or check the project and environment. " +
  RETENTION_ACTION;

const fail = (
  error: string,
  extra: Record<string, unknown> = {},
): LogReadResult => ({
  body: { error, ...extra },
});

function errorText(status: number | null): string {
  switch (status) {
    case 400:
      return "The log query was rejected by the platform (400). Check the parameters.";
    case 401:
    case 403:
      return "Reading logs is not permitted for this API key.";
    case 404:
      return "Project or log endpoint not found. The logs API v2.1 needs a recent Cognigy release.";
    case 429:
      return "Rate limited by the platform. Retry later.";
    default:
      return "Reading the logs failed.";
  }
}

// The client rejects with a plain Error carrying `.status` when the response
// has a body, and with the raw AxiosError (`.response.status`) otherwise.
function statusOf(err: unknown): number | null {
  const e = err as { response?: { status?: unknown }; status?: unknown } | null;
  const status = e?.response?.status ?? e?.status;
  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : null;
}

const failedCall = (err: unknown): LogReadResult => {
  const status = statusOf(err);
  return fail(errorText(status), { status });
};

function itemsOf(data: unknown): unknown[] {
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

function totalOf(data: unknown): number | null {
  const total = (data as { total?: unknown } | null)?.total;
  return typeof total === "number" && total >= 0 ? total : null;
}

function successHint(
  count: number,
  truncated: boolean,
  warning?: string,
): LogReadResult["hint"] {
  if (truncated) {
    return {
      warning:
        warning ??
        "This result is a SAMPLE: more matching log entries exist than were read.",
      action: NARROW_ACTION,
    };
  }
  return { action: count === 0 ? EMPTY_ACTION : RETENTION_ACTION };
}

const LOOK_FURTHER =
  "pass startDate (log retention is typically about 24 hours) to look further back.";

// States the default window when the caller did not choose a start, so a
// quiet result is not mistaken for "nothing happened". Window path only.
function withWindowNote(
  hint: LogReadResult["hint"],
  args: LogReadArgs,
): LogReadResult["hint"] {
  if (args.startDate !== undefined) return hint;
  const shown = args.endDate
    ? "Showing the hour before endDate by default"
    : "Showing the last hour by default";
  return {
    ...hint,
    action: `${hint?.action ?? ""} ${shown}; ${LOOK_FURTHER}`,
  };
}

function withPagingNote(
  hint: LogReadResult["hint"],
  ignored: boolean,
): LogReadResult["hint"] {
  return ignored
    ? { ...hint, action: (hint?.action ?? "") + PAGING_NOTE }
    : hint;
}

function resolveWindow(
  args: LogReadArgs,
  now: number,
): { startDate: string; endDate: string } | LogReadResult {
  for (const date of [args.startDate, args.endDate]) {
    if (date !== undefined && !isRealDate(date)) {
      return fail(
        `Invalid date "${date.slice(0, 40)}": use ISO 8601 with an explicit timezone (Z or +hh:mm), e.g. 2026-10-23T10:00:00Z.`,
      );
    }
  }
  const endDate = args.endDate ?? new Date(now + END_SLACK_MS).toISOString();
  const startDate =
    args.startDate ??
    new Date(
      (args.endDate ? Date.parse(args.endDate) : now) - DEFAULT_WINDOW_MS,
    ).toISOString();
  if (Date.parse(startDate) > Date.parse(endDate)) {
    return fail(
      "startDate must not be later than endDate (ISO 8601 timestamps).",
    );
  }
  return { startDate, endDate };
}

function filterParams(args: LogReadArgs): Record<string, unknown> {
  return {
    ...(args.logLevel ? { type: args.logLevel } : {}),
    ...(args.flowName ? { flowName: args.flowName } : {}),
  };
}

async function readSession(
  client: LogClient,
  args: LogReadArgs,
): Promise<LogReadResult> {
  const unsupported = (
    ["search", "startDate", "endDate", "sort", "skip", "limit"] as const
  ).filter((key) => args[key] !== undefined);
  if (unsupported.length > 0) {
    return fail(
      `With sessionId these parameters are not supported: ${unsupported.join(", ")}. ` +
        "Use only logLevel, flowName and view.",
    );
  }
  let data: unknown;
  try {
    data = await client.get(`/v2.1/projects/${args.projectId}/logs/tail`, {
      params: { sessionId: args.sessionId, ...filterParams(args) },
      headers: { "x-cognigy-log-model-version": "v2" },
      timeout: CALL_TIMEOUT_MS,
    });
  } catch (err) {
    return failedCall(err);
  }
  const entries = itemsOf(data).map(toLogEntry);
  const truncated = entries.length >= TAIL_MAX_ITEMS;
  const body =
    args.view === "entries"
      ? {
          view: "entries",
          window: null,
          total: null,
          returned: entries.length,
          entries,
        }
      : {
          view: "summary",
          window: null,
          ...summarizeEntries(entries, { total: null, truncated }),
        };
  return { body, hint: successHint(entries.length, truncated) };
}

async function readEntries(
  client: LogClient,
  args: LogReadArgs,
  baseParams: Record<string, unknown>,
  window: { startDate: string; endDate: string },
): Promise<LogReadResult> {
  const limit = Math.min(
    Math.max(Math.floor(args.limit ?? ENTRIES_DEFAULT_LIMIT), 1),
    ENTRIES_MAX_LIMIT,
  );
  let data: unknown;
  try {
    data = await client.get(`/v2.1/projects/${args.projectId}/logs`, {
      params: {
        ...baseParams,
        limit,
        ...(args.skip ? { skip: args.skip } : {}),
      },
      timeout: CALL_TIMEOUT_MS,
    });
  } catch (err) {
    return failedCall(err);
  }
  const entries: LogEntry[] = itemsOf(data).map(toLogEntry);
  const total = totalOf(data);
  return {
    body: {
      view: "entries",
      window: { from: window.startDate, to: window.endDate },
      total,
      returned: entries.length,
      entries,
    },
    hint: withWindowNote(successHint(entries.length, false), args),
  };
}

async function readSummary(
  client: LogClient,
  args: LogReadArgs,
  baseParams: Record<string, unknown>,
  window: { startDate: string; endDate: string },
  now: () => number,
  deadlineMs: number,
): Promise<LogReadResult> {
  const began = now();
  const entries: LogEntry[] = [];
  let total: number | null = null;
  let truncated = false;
  let partialFailure = false;
  for (let page = 0; page < SUMMARY_MAX_PAGES; page++) {
    if (page > 0 && now() - began >= deadlineMs) {
      truncated = true;
      break;
    }
    const skip = page * SUMMARY_PAGE_SIZE;
    let data: unknown;
    try {
      data = await client.get(`/v2.1/projects/${args.projectId}/logs`, {
        params: {
          ...baseParams,
          limit: SUMMARY_PAGE_SIZE,
          ...(skip ? { skip } : {}),
        },
        timeout: CALL_TIMEOUT_MS,
      });
    } catch (err) {
      if (page === 0) return failedCall(err);
      truncated = true;
      partialFailure = true;
      break;
    }
    if (page === 0) total = totalOf(data);
    const items = itemsOf(data);
    entries.push(...items.map(toLogEntry));
    if (items.length < SUMMARY_PAGE_SIZE) break;
    if (total !== null && entries.length >= total) break;
    if (page === SUMMARY_MAX_PAGES - 1) truncated = true;
  }
  truncated = truncated || (total !== null && total > entries.length);
  const warning = partialFailure
    ? "A later page failed to load: this result is a SAMPLE of the matching log entries."
    : undefined;
  return {
    body: {
      view: "summary",
      window: { from: window.startDate, to: window.endDate },
      ...summarizeEntries(entries, { total, truncated }),
    },
    hint: withPagingNote(
      withWindowNote(successHint(entries.length, truncated, warning), args),
      args.limit !== undefined || args.skip !== undefined,
    ),
  };
}

export async function readLogs(
  client: LogClient,
  args: LogReadArgs,
  options: { now?: () => number; deadlineMs?: number } = {},
): Promise<LogReadResult> {
  if (args.sessionId) return readSession(client, args);
  if (args.sort !== undefined && !SORT_VALUE.test(args.sort)) {
    return fail("sort must be one of: timestamp:desc, timestamp:asc.");
  }
  if (
    args.skip !== undefined &&
    !(Number.isInteger(args.skip) && args.skip >= 0 && args.skip <= MAX_SKIP)
  ) {
    return fail(`skip must be an integer from 0 to ${MAX_SKIP}.`);
  }
  const now = options.now ?? Date.now;
  const window = resolveWindow(args, now());
  if ("body" in window) return window;
  const baseParams = {
    startDate: window.startDate,
    endDate: window.endDate,
    sort: args.sort ?? "timestamp:desc",
    ...filterParams(args),
    ...(args.search ? { filter: args.search } : {}),
  };
  return args.view === "entries"
    ? readEntries(client, args, baseParams, window)
    : readSummary(
        client,
        args,
        baseParams,
        window,
        now,
        options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      );
}
