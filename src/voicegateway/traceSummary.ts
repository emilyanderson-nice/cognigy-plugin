/**
 * Summary of a Voice Gateway call trace (OpenTelemetry JSON, findings V4/V5).
 *
 * The trace holds the caller's words and numbers (gm.transcript, stt.result,
 * from, to, callerName, request bodies) and span names that carry voice ids and
 * parameters. Nothing is passed through: the result is built field by field
 * from the attributes named below, each read as a short plain token, a finite
 * non-negative number or a boolean, and no span name is ever returned.
 */

const MAX_SPANS = 5_000;
const MAX_TURNS = 50;
const NOTE_NO_BARGE_IN =
  "No barge-in or voice-activity span or attribute appeared in this trace; that is not proof it did not happen.";
const NOTE_BARGE_IN =
  "Spans or attributes whose names mention barge-in, voice activity or an interruption were present; only their number is shown.";

export interface SpeechTurn {
  atMs: number;
  durationMs: number;
  ttfbMs?: number;
  vendor?: string;
  model?: string;
  voice?: string;
  language?: string;
  characters?: number;
  cached?: boolean;
  streaming?: boolean;
  fallback?: boolean;
}

export interface ListenTurn {
  atMs: number;
  durationMs: number;
  vendor?: string;
  model?: string;
  fallback?: boolean;
}

export interface ConnectTurn {
  atMs: number;
  durationMs: number;
  vendor?: string;
  success?: boolean;
}

interface Group<T> {
  count: number;
  truncated: boolean;
  turns: T[];
}

export interface TraceSummary {
  startedAt?: string;
  call: {
    durationMs?: number;
    finalStatus?: number;
    termination?: string;
    terminatedBy?: string;
    timeline: { status: string; atMs: number }[];
    /** True only when more than MAX_TURNS statuses were present. */
    timelineTruncated?: true;
  };
  speech: Group<SpeechTurn> & {
    ttfbMs: { min: number; median: number; max: number } | null;
  };
  listening: Group<ListenTurn>;
  gatherConnect: Group<ConnectTurn>;
  bargeIn: { observed: boolean; matchingSpans: number; note: string };
  spans: { total: number; read: number; truncated: boolean };
}

type Primitive = string | number | boolean;
interface ReadSpan {
  name: string;
  startMicros: number;
  endMicros: number;
  attrs: Map<string, Primitive>;
  attrKeys: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const round1 = (n: number): number => Math.round(n * 10) / 10;

const NANOS_RE = /^\d{1,20}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:\- ]{1,64}$/;
const STATUS_RE = /^[a-z][a-z-]{0,23}$/;
const BARGE_RE = /barge|(^|[^a-z])vad([^a-z]|$)|interrupt/i;

/** OTLP attribute value -> a primitive; anything else is dropped. */
function primitive(value: unknown): Primitive | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.doubleValue === "number") return value.doubleValue;
  const int = value.intValue;
  if (typeof int === "number") return int;
  if (typeof int === "string" && /^-?\d{1,15}$/.test(int)) return Number(int);
  return undefined;
}

function readSpan(raw: unknown): ReadSpan | undefined {
  if (!isObject(raw) || typeof raw.name !== "string") return undefined;
  const { startTimeUnixNano: start, endTimeUnixNano: end } = raw;
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    !NANOS_RE.test(start) ||
    !NANOS_RE.test(end)
  ) {
    return undefined;
  }
  const startMicros = Number(BigInt(start) / 1000n);
  const endMicros = Number(BigInt(end) / 1000n);
  if (endMicros < startMicros) return undefined;
  const attrs = new Map<string, Primitive>();
  const attrKeys: string[] = [];
  if (Array.isArray(raw.attributes)) {
    for (const a of raw.attributes) {
      if (!isObject(a) || typeof a.key !== "string") continue;
      attrKeys.push(a.key);
      const v = primitive(a.value);
      if (v !== undefined) attrs.set(a.key, v);
    }
  }
  return { name: raw.name, startMicros, endMicros, attrs, attrKeys };
}

const token = (s: ReadSpan, key: string): string | undefined => {
  const v = s.attrs.get(key);
  return typeof v === "string" && TOKEN_RE.test(v) ? v : undefined;
};
const bool = (s: ReadSpan, key: string): boolean | undefined => {
  const v = s.attrs.get(key);
  return typeof v === "boolean" ? v : undefined;
};
/** A finite non-negative number; numeric strings count (ttfb is string-typed). */
const num = (s: ReadSpan, key: string): number | undefined => {
  const v = s.attrs.get(key);
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d{1,12}(\.\d{1,6})?$/.test(v.trim())
        ? Number(v)
        : undefined;
  return n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Only the defined entries. */
function defined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

const median = (sorted: number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? round1(sorted[mid])
    : round1((sorted[mid - 1] + sorted[mid]) / 2);
};

function group<T>(count: number, turns: T[]): Group<T> {
  return {
    count,
    truncated: count > MAX_TURNS,
    turns: turns.slice(0, MAX_TURNS),
  };
}

/** The summary, or null when `raw` is not an OpenTelemetry trace document. */
export function summarizeTrace(raw: unknown): TraceSummary | null {
  if (!isObject(raw) || !Array.isArray(raw.resourceSpans)) return null;
  // Count every span but keep only the first MAX_SPANS: spreading a huge list
  // into push() can exceed the engine's argument limit and throw.
  const items: unknown[] = [];
  let total = 0;
  for (const rs of raw.resourceSpans) {
    if (!isObject(rs) || !Array.isArray(rs.scopeSpans)) continue;
    for (const ss of rs.scopeSpans) {
      if (!isObject(ss) || !Array.isArray(ss.spans)) continue;
      total += ss.spans.length;
      for (let i = 0; i < ss.spans.length && items.length < MAX_SPANS; i++) {
        items.push(ss.spans[i]);
      }
    }
  }
  const spans: ReadSpan[] = [];
  for (const item of items) {
    const s = readSpan(item);
    if (s) spans.push(s);
  }

  const root = spans.find((s) => s.name === "incoming-call");
  const origin = root
    ? root.startMicros
    : spans.length > 0
      ? Math.min(...spans.map((s) => s.startMicros))
      : undefined;
  const at = (s: ReadSpan): number =>
    origin === undefined ? 0 : round1((s.startMicros - origin) / 1000);
  const dur = (s: ReadSpan): number =>
    round1((s.endMicros - s.startMicros) / 1000);

  const timeline: { status: string; atMs: number }[] = [];
  for (const s of spans) {
    const m = /^call-status:(.+)$/.exec(s.name);
    if (m && STATUS_RE.test(m[1])) {
      timeline.push({ status: m[1], atMs: at(s) });
    }
  }
  timeline.sort((a, b) => a.atMs - b.atMs);
  const completed = spans.find((s) => s.name === "call-status:completed");

  const speech: SpeechTurn[] = [];
  const listening: ListenTurn[] = [];
  const connect: ConnectTurn[] = [];
  let bargeSpans = 0;
  for (const s of spans) {
    if (BARGE_RE.test(s.name) || s.attrKeys.some((k) => BARGE_RE.test(k))) {
      bargeSpans++;
    }
    if (s.name === "tts-generation") {
      speech.push(
        defined({
          atMs: at(s),
          durationMs: dur(s),
          ttfbMs: num(s, "time_to_first_byte_ms"),
          vendor: token(s, "tts.vendor"),
          model: token(s, "tts.model"),
          voice: token(s, "tts.voice"),
          language: token(s, "tts.language"),
          characters: num(s, "tts.characters"),
          cached: bool(s, "tts.cached"),
          streaming: bool(s, "tts.streaming"),
          fallback: bool(s, "tts.isFallback"),
        }),
      );
    } else if (s.name.startsWith("verb:gather")) {
      listening.push(
        defined({
          atMs: at(s),
          durationMs: dur(s),
          vendor: token(s, "stt.vendor"),
          model: token(s, "stt.model"),
          fallback: bool(s, "stt.isFallback"),
        }),
      );
    } else if (s.name === "gather:connecting") {
      connect.push(
        defined({
          atMs: at(s),
          durationMs: dur(s),
          vendor: token(s, "stt.vendor"),
          success: bool(s, "stt.connecting.success"),
        }),
      );
    }
  }
  const byTime = <T extends { atMs: number }>(list: T[]): T[] =>
    [...list].sort((a, b) => a.atMs - b.atMs);
  const ttfb = speech
    .map((t) => t.ttfbMs)
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);

  return {
    ...(origin !== undefined
      ? { startedAt: new Date(Math.floor(origin / 1000)).toISOString() }
      : {}),
    call: defined({
      durationMs: root ? dur(root) : undefined,
      finalStatus: root ? num(root, "finalStatus") : undefined,
      termination: root ? token(root, "call.termination") : undefined,
      terminatedBy: completed
        ? token(completed, "callTerminationBy")
        : undefined,
      timeline: timeline.slice(0, MAX_TURNS),
      timelineTruncated:
        timeline.length > MAX_TURNS ? (true as const) : undefined,
    }),
    speech: {
      ...group(speech.length, byTime(speech)),
      ttfbMs:
        ttfb.length > 0
          ? {
              min: round1(ttfb[0]),
              median: median(ttfb),
              max: round1(ttfb[ttfb.length - 1]),
            }
          : null,
    },
    listening: group(listening.length, byTime(listening)),
    gatherConnect: group(connect.length, byTime(connect)),
    bargeIn: {
      observed: bargeSpans > 0,
      matchingSpans: bargeSpans,
      note: bargeSpans > 0 ? NOTE_BARGE_IN : NOTE_NO_BARGE_IN,
    },
    spans: {
      total,
      read: Math.min(total, MAX_SPANS),
      truncated: total > MAX_SPANS,
    },
  };
}
