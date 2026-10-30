import {
  type ConversationClient,
  type TranscriptResult,
  parseInstant,
  rowsOf,
  scalar,
  upstreamError,
} from "./common.js";

export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;
export const MAX_LIST_ROWS = 5000;

export interface ListConversationsOptions {
  projectId?: string;
  startDate?: string;
  endDate?: string;
  channel?: string;
  flowName?: string;
  minMessages?: number;
  contactIds?: string[];
  limit?: number;
  skip?: number;
}

function dateBound(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const t = parseInstant(value);
  if (t === undefined) {
    throw new Error(`${name} must be an ISO 8601 date or datetime.`);
  }
  return t;
}

function idOf(row: any): string {
  return typeof row?._id === "string" ? row._id : "";
}

// Built field by field: nothing else from the upstream row is ever returned.
function project(row: any): Record<string, unknown> {
  const pairs: [string, unknown][] = [
    ["sessionId", row._id],
    ["channel", row.channel],
    ["flowName", row.flowName],
    ["endpointName", row.endpointName],
    ["startTime", row.startTime],
    ["endTime", row.endTime],
    ["messages", row.messages],
    ["rating", row.rating],
  ];
  const out: Record<string, unknown> = {};
  for (const [k, raw] of pairs) {
    const v = scalar(raw);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The platform returns every conversation of a project in one call and
 * ignores paging and date filters (findings T1-T8), so filtering, sorting and
 * paging happen here.
 */
export async function listConversations(
  client: ConversationClient,
  opts: ListConversationsOptions,
): Promise<TranscriptResult> {
  if (!opts.projectId) {
    throw new Error("projectId is required for resourceType 'conversation'.");
  }
  const from = dateBound("startDate", opts.startDate);
  const to = dateBound("endDate", opts.endDate);

  const params: Record<string, unknown> = { projectId: opts.projectId };
  if (Array.isArray(opts.contactIds) && opts.contactIds.length > 0) {
    params.contactIds = opts.contactIds;
  }

  let response: any;
  try {
    response = await client.get("/v2.0/conversations", { params });
  } catch (error) {
    throw upstreamError("conversations", error);
  }

  const all = rowsOf(response);
  const truncated = all.length > MAX_LIST_ROWS;
  const rows = truncated ? all.slice(0, MAX_LIST_ROWS) : all;

  const matched = rows
    .map((row) => ({ row, t: parseInstant(row?.startTime) }))
    .filter(({ row, t }) => {
      if (from !== undefined || to !== undefined) {
        if (t === undefined) return false;
        if (from !== undefined && t < from) return false;
        if (to !== undefined && t > to) return false;
      }
      if (opts.channel !== undefined && row?.channel !== opts.channel) {
        return false;
      }
      if (opts.flowName !== undefined && row?.flowName !== opts.flowName) {
        return false;
      }
      if (opts.minMessages !== undefined) {
        const m = typeof row?.messages === "number" ? row.messages : 0;
        if (m < opts.minMessages) return false;
      }
      return true;
    });

  matched.sort((a, b) => {
    if (a.t !== undefined && b.t !== undefined && a.t !== b.t) return b.t - a.t;
    if (a.t === undefined && b.t !== undefined) return 1;
    if (a.t !== undefined && b.t === undefined) return -1;
    const ia = idOf(a.row);
    const ib = idOf(b.row);
    return ia < ib ? 1 : ia > ib ? -1 : 0;
  });

  const skip = opts.skip ?? 0;
  const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const total = matched.length;
  const items = matched
    .slice(skip, skip + limit)
    .map(({ row }) => project(row));

  const body: Record<string, unknown> = { items, total, skip, limit };
  const hint: { warning?: string; action?: string } = {};
  if (truncated) {
    body.truncated = true;
    hint.warning = `The platform returned more than ${MAX_LIST_ROWS} conversations; only the first ${MAX_LIST_ROWS} rows were considered and total counts only those.`;
    hint.action =
      "Narrow the list with contactIds (the only filter the platform applies itself).";
  }
  if (total > skip + items.length) {
    const next = `More conversations follow: call again with skip: ${skip + items.length}.`;
    hint.action = hint.action ? `${hint.action} ${next}` : next;
  } else if (items.length === 0 && total === 0) {
    // Rows read but all excluded is a filter problem (usually an inexact
    // flowName or channel); no rows at all is where collection may be off.
    const none =
      rows.length > 0
        ? `Result is empty: no conversation matched. ${rows.length} ${rows.length === 1 ? "conversation was" : "conversations were"} read from this project, but none matched the filters: flowName and channel must match exactly (case-sensitive), startDate and endDate compare the start time.`
        : "Result is empty: no conversation matched. Check the filters, and note the project may not collect conversations (the endpoint needs Collect Analytics / Conversations enabled).";
    hint.action = hint.action ? `${hint.action} ${none}` : none;
  }
  return { body, hint };
}
