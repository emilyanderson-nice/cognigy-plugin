/**
 * Tool calls in a conversation.
 *
 * A transcript records a tool call as one empty bot row with
 * `inputData._cognigy._finishReason` "tool_calls" (T9); it names no tool. The
 * name exists only in the project log, in the line the tool's Log node writes
 * (T10): `[tool-call] <toolId> args=[<names>] inputId=<uuid>`. Every row of one
 * conversation turn carries the same inputId, so a line that holds it pairs with
 * its turn exactly. Older lines have no inputId and pair by time, flagged as such.
 *
 * Privacy: the log text is parsed against ONE fixed pattern and only the tool id
 * and argument NAMES (allow-listed tokens) leave this module. The raw line, the
 * inputId and any argument value are never returned.
 */
import { fetchRawLogLines } from "../logReader.js";
import { type ConversationClient, parseInstant } from "./common.js";

export type ToolCallMatch = "inputId" | "time" | "ambiguous" | "none";

export interface ParsedToolCallLine {
  tool: string;
  argNames: string[];
  inputId?: string;
}

export interface LogToolLine extends ParsedToolCallLine {
  timestampMs: number;
}

export interface ToolCallMarker {
  messageIndex: number;
  timestamp?: string;
  timestampMs?: number;
  inputId?: string;
}

export interface ToolCall {
  messageIndex: number;
  timestamp?: string;
  tool: string | null;
  argNames: string[];
  matched: ToolCallMatch;
}

export const TOOL_CALL_SEARCH = "[tool-call]";

/** A log line is written within milliseconds of its marker; 2 s is generous. */
const MAX_TIME_GAP_MS = 2000;
/** Window around each marker when asking the log for its line. */
const WINDOW_PAD_MS = 10_000;
/** At most this many log requests (one per cluster of markers) and this long. */
const MAX_WINDOWS = 10;
const DEADLINE_MS = 20_000;
const MAX_ARG_NAMES = 20;
/**
 * A marker time outside this range is treated as unreadable: it cannot be a real
 * conversation, and an extreme value would break the window arithmetic.
 */
const SANE_MIN_MS = Date.UTC(2000, 0, 1);
const SANE_MAX_MS = Date.UTC(2100, 0, 1);

const LINE_RE =
  /^(?:Flow Node - )?\[tool-call\] ([A-Za-z0-9_-]{1,64}) args=\[([^\]\n]*)\](?: inputId=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}))?$/;
// Argument names are what the model sent, not only what the tool declared, so
// they are capped short: a long token could be an id or an address.
const ARG_NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const ROW_INPUT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const PROJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** One tool-call log line, or null when it does not match the pattern exactly. */
export function parseToolCallLine(msg: string): ParsedToolCallLine | null {
  if (typeof msg !== "string") return null;
  const m = LINE_RE.exec(msg);
  if (!m) return null;
  const [, tool, argsText, inputId] = m;
  const argNames =
    argsText === "" || argsText === "none"
      ? []
      : argsText
          .split(", ")
          .slice(0, MAX_ARG_NAMES)
          .map((name) => (ARG_NAME_RE.test(name) ? name : "<name>"));
  return { tool, argNames, ...(inputId ? { inputId } : {}) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The bot rows that mark a tool call, with their position in `rows`. */
export function findToolCallMarkers(rows: unknown[]): ToolCallMarker[] {
  const markers: ToolCallMarker[] = [];
  rows.forEach((row, messageIndex) => {
    if (!isPlainObject(row) || row.type !== "output") return;
    const cognigy = isPlainObject(row.inputData)
      ? row.inputData._cognigy
      : undefined;
    if (!isPlainObject(cognigy) || cognigy._finishReason !== "tool_calls") {
      return;
    }
    const parsedMs = parseInstant(row.timestamp);
    const timestampMs =
      parsedMs !== undefined &&
      parsedMs >= SANE_MIN_MS &&
      parsedMs <= SANE_MAX_MS
        ? parsedMs
        : undefined;
    const inputId =
      typeof row.inputId === "string" && ROW_INPUT_ID_RE.test(row.inputId)
        ? row.inputId
        : undefined;
    markers.push({
      messageIndex,
      // Re-formatted, never the row's own string: nothing but a date leaves here.
      ...(timestampMs !== undefined
        ? { timestamp: new Date(timestampMs).toISOString(), timestampMs }
        : {}),
      ...(inputId ? { inputId } : {}),
    });
  });
  return markers;
}

const lower = (s: string | undefined) => s?.toLowerCase();

/**
 * Pair markers with log lines. Exact first: markers and lines that share an
 * inputId pair in time order when their counts match, and pair nothing when
 * they do not (which line belongs to which call is then unknowable). What is
 * left falls back to the nearest line in time within MAX_TIME_GAP_MS, one line
 * to one marker, smallest gap first; a line that carries an inputId only ever
 * pairs with a marker of that turn or one without an inputId.
 */
export function pairToolCalls(
  markers: ToolCallMarker[],
  lines: LogToolLine[],
): { toolCalls: ToolCall[]; unmatchedLogLines: number } {
  const toolCalls: ToolCall[] = markers.map((m) => ({
    messageIndex: m.messageIndex,
    ...(m.timestamp !== undefined ? { timestamp: m.timestamp } : {}),
    tool: null,
    argNames: [],
    matched: "none",
  }));
  const paired = new Set<number>();
  const claimed = new Set<number>(); // lines owned by a turn that has markers
  const resolved = new Set<number>(); // markers settled by inputId

  const group = <T>(items: T[], idOf: (t: T) => string | undefined) => {
    const out = new Map<string, number[]>();
    items.forEach((item, i) => {
      const id = lower(idOf(item));
      if (id) out.set(id, [...(out.get(id) ?? []), i]);
    });
    return out;
  };
  const markersById = group(markers, (m) => m.inputId);
  const linesById = group(lines, (l) => l.inputId);

  for (const [id, markerIdx] of markersById) {
    const lineIdx = linesById.get(id) ?? [];
    if (lineIdx.length === 0) continue; // nothing carries this turn's id: time fallback
    lineIdx.forEach((j) => claimed.add(j));
    markerIdx.forEach((i) => resolved.add(i));
    if (lineIdx.length !== markerIdx.length) {
      markerIdx.forEach((i) => (toolCalls[i].matched = "ambiguous"));
      continue;
    }
    const orderedMarkers = [...markerIdx].sort(
      (a, b) => markers[a].messageIndex - markers[b].messageIndex,
    );
    const orderedLines = [...lineIdx].sort(
      (a, b) => lines[a].timestampMs - lines[b].timestampMs,
    );
    orderedMarkers.forEach((i, k) => {
      const line = lines[orderedLines[k]];
      toolCalls[i] = {
        ...toolCalls[i],
        tool: line.tool,
        argNames: line.argNames,
        matched: "inputId",
      };
      paired.add(orderedLines[k]);
    });
  }

  const candidates: { gap: number; i: number; j: number }[] = [];
  markers.forEach((marker, i) => {
    if (resolved.has(i) || marker.timestampMs === undefined) return;
    lines.forEach((line, j) => {
      if (claimed.has(j)) return;
      if (line.inputId && marker.inputId) return;
      const gap = Math.abs(line.timestampMs - marker.timestampMs!);
      if (gap <= MAX_TIME_GAP_MS) candidates.push({ gap, i, j });
    });
  });
  candidates.sort((a, b) => a.gap - b.gap || a.i - b.i || a.j - b.j);
  const markerTaken = new Set<number>();
  for (const { i, j } of candidates) {
    if (markerTaken.has(i) || paired.has(j)) continue;
    markerTaken.add(i);
    paired.add(j);
    toolCalls[i] = {
      ...toolCalls[i],
      tool: lines[j].tool,
      argNames: lines[j].argNames,
      matched: "time",
    };
  }

  return { toolCalls, unmatchedLogLines: lines.length - paired.size };
}

export type ToolCallLogRead =
  | "ok"
  | "skipped"
  | "failed"
  | "noProject"
  | "noWindow";

export interface ToolCallsOutcome {
  toolCalls: ToolCall[];
  unmatchedLogLines: number;
  logRead: ToolCallLogRead;
  truncated: boolean;
}

/**
 * The tool calls of a conversation: markers from `rows` (in conversation
 * order), names from the project log in the window around them. No tool call
 * means no log request.
 */
/**
 * One window per cluster of markers: windows that touch merge into one, so a
 * long conversation is read as a few short slices of a project-wide log and
 * not as one span the 300-line read could not cover.
 */
function windowsAround(times: number[]): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const start = t - WINDOW_PAD_MS;
    const end = t + WINDOW_PAD_MS;
    const last = windows[windows.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }
  return windows;
}

export async function collectToolCalls(
  client: ConversationClient,
  rows: unknown[],
  opts: { projectId?: string; now?: () => number },
): Promise<ToolCallsOutcome> {
  const markers = findToolCallMarkers(rows);
  const empty = (logRead: ToolCallLogRead): ToolCallsOutcome => ({
    toolCalls: pairToolCalls(markers, []).toolCalls,
    unmatchedLogLines: 0,
    logRead,
    truncated: false,
  });
  if (markers.length === 0) return empty("skipped");

  const rowProject = rows
    .map((r) => (isPlainObject(r) ? r.projectId : undefined))
    .find((p): p is string => typeof p === "string" && PROJECT_ID_RE.test(p));
  const projectId = opts.projectId ?? rowProject;
  if (!projectId || !PROJECT_ID_RE.test(projectId)) return empty("noProject");

  const times = markers
    .map((m) => m.timestampMs)
    .filter((t): t is number => t !== undefined);
  if (times.length === 0) return empty("noWindow");

  const now = opts.now ?? Date.now;
  const began = now();
  const lines: LogToolLine[] = [];
  let truncated = false;
  const windows = windowsAround(times);
  for (let w = 0; w < windows.length; w++) {
    if (w >= MAX_WINDOWS || (w > 0 && now() - began >= DEADLINE_MS)) {
      truncated = true;
      break;
    }
    const fetched = await fetchRawLogLines(client, {
      projectId,
      search: TOOL_CALL_SEARCH,
      startDate: new Date(windows[w].start).toISOString(),
      endDate: new Date(windows[w].end).toISOString(),
    });
    if (!fetched.ok) {
      if (w === 0) return empty("failed");
      truncated = true; // a later slice failed: what was read is partial
      break;
    }
    truncated = truncated || fetched.truncated;
    for (const raw of fetched.lines) {
      const parsed = parseToolCallLine(raw.msg);
      const timestampMs = parseInstant(raw.timestamp);
      if (parsed && timestampMs !== undefined) {
        lines.push({ ...parsed, timestampMs });
      }
    }
  }
  const { toolCalls, unmatchedLogLines } = pairToolCalls(markers, lines);
  return { toolCalls, unmatchedLogLines, logRead: "ok", truncated };
}
