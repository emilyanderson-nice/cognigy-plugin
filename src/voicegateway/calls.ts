/**
 * Voice Gateway calls as a read-only resource (`voice_call`): the recent-calls
 * list and one call's trace summary (findings V1-V7).
 *
 * A call row and a trace hold the caller's number, SIP addresses, the words said
 * and recording links. Output is built field by field: every value is checked
 * against a strict pattern or type, and a value that fails is left out, so an
 * unexpected or hostile upstream field can never carry text through.
 */
import { upstreamError } from "../tools/transcripts/common.js";
import { REASON_RE, SIP_CALL_ID_RE, TRACE_ID_RE, UUID_RE } from "./patterns.js";
import { summarizeTrace } from "./traceSummary.js";

export interface VoiceGatewayContext {
  /** The Cognigy.AI client of the environment: only the account id comes from it. */
  cognigy: { get(url: string): Promise<unknown> };
  /** Absent when the environment has no Voice Gateway credentials. */
  vg?: {
    get(
      path: string,
      params?: Record<string, string | number>,
    ): Promise<unknown>;
  };
  /** Mutable cache, one per environment runtime. */
  accountCache: { sid?: string };
}

export interface VoiceCallResult {
  body: Record<string, unknown>;
  hint?: { warning?: string; action?: string };
}

export interface ListVoiceCallsOptions {
  days?: number;
  direction?: "inbound" | "outbound";
  answered?: boolean;
  sipCallId?: string;
  limit?: number;
  skip?: number;
}

const PAGE_SIZE = 100;
const DEFAULT_LIMIT = 25;
const SANE_MIN_MS = Date.UTC(2000, 0, 1);
const SANE_MAX_MS = Date.UTC(2100, 0, 1);

const NOT_CONFIGURED = "Voice Gateway is not configured for this environment.";
const NOT_CONFIGURED_ACTION =
  "Add the Voice Gateway REST API URL and account API key to this environment's profile: run cognigy-setup profile add <name> --api-base-url <url> --api-key-env <VAR> --voice-gateway-url <https URL> --voice-gateway-key-env <VAR> --force (re-adding a profile replaces it, so give the Cognigy key again), or set COGNIGY_PROFILE_<NAME>_VOICE_GATEWAY_BASE_URL and COGNIGY_PROFILE_<NAME>_VOICE_GATEWAY_API_KEY.";

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function notConfigured(): VoiceCallResult {
  return {
    body: { error: NOT_CONFIGURED },
    hint: { action: NOT_CONFIGURED_ACTION },
  };
}

/** The account id: read once per environment, and only ever a UUID. */
async function accountId(ctx: VoiceGatewayContext): Promise<string> {
  if (ctx.accountCache.sid) return ctx.accountCache.sid;
  let data: unknown;
  try {
    data = await ctx.cognigy.get("/v2.0/organisations/voicegateway/account");
  } catch (error) {
    throw upstreamError("the Voice Gateway account", error);
  }
  const sid = isObject(data) ? data.voiceGatewayAccount : undefined;
  if (typeof sid !== "string" || !UUID_RE.test(sid)) {
    throw new Error("The Voice Gateway account id has an unexpected format.");
  }
  ctx.accountCache.sid = sid;
  return sid;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms < SANE_MIN_MS || ms > SANE_MAX_MS
    ? undefined
    : new Date(ms).toISOString();
}

const matching = (v: unknown, re: RegExp): string | undefined =>
  typeof v === "string" && re.test(v) ? v : undefined;

function finite(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? v
    : undefined;
}

interface CallRow {
  callSid?: string;
  traceId?: string;
  sipCallId?: string;
  direction?: "inbound" | "outbound";
  answered?: boolean;
  attemptedAt?: string;
  answeredAt?: string;
  terminatedAt?: string;
  durationSeconds?: number;
  sipStatus?: number;
  terminationReason?: string;
}

/** One list row, field by field. Caller numbers, hosts and links are not read. */
function toCallRow(raw: unknown): CallRow {
  const r = isObject(raw) ? raw : {};
  const direction =
    r.direction === "inbound" || r.direction === "outbound"
      ? r.direction
      : undefined;
  const entries: [string, unknown][] = [
    ["callSid", matching(r.call_sid, UUID_RE)],
    ["traceId", matching(r.trace_id, TRACE_ID_RE)],
    ["sipCallId", matching(r.sip_callid, SIP_CALL_ID_RE)],
    ["direction", direction],
    ["answered", typeof r.answered === "boolean" ? r.answered : undefined],
    ["attemptedAt", isoTime(r.attempted_at)],
    ["answeredAt", isoTime(r.answered_at)],
    ["terminatedAt", isoTime(r.terminated_at)],
    ["durationSeconds", finite(r.duration, 0, 31_536_000)],
    ["sipStatus", finite(r.sip_status, 100, 699)],
    ["terminationReason", matching(r.termination_reason, REASON_RE)],
  ];
  return Object.fromEntries(
    entries.filter(([, v]) => v !== undefined),
  ) as CallRow;
}

export async function listVoiceCalls(
  ctx: VoiceGatewayContext,
  opts: ListVoiceCallsOptions,
): Promise<VoiceCallResult> {
  if (!ctx.vg) return notConfigured();
  const sid = await accountId(ctx);
  const skip = Math.max(0, Math.floor(opts.skip ?? 0));
  const limit = Math.min(
    PAGE_SIZE,
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)),
  );
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const offset = skip % PAGE_SIZE;

  const response = await ctx.vg.get(`/Accounts/${sid}/RecentCalls`, {
    page,
    count: PAGE_SIZE,
    ...(opts.days !== undefined ? { days: opts.days } : {}),
  });
  if (!isObject(response) || !Array.isArray(response.data)) {
    throw new Error(
      "The Voice Gateway returned a call list in an unexpected format.",
    );
  }
  const pageRows = response.data.slice(0, PAGE_SIZE);
  const rows = pageRows.slice(offset).map(toCallRow);

  const filtered = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        (opts.direction === undefined || row.direction === opts.direction) &&
        (opts.answered === undefined || row.answered === opts.answered) &&
        (opts.sipCallId === undefined || row.sipCallId === opts.sipCallId),
    );
  const shown = filtered.slice(0, limit);
  const filtering =
    opts.direction !== undefined ||
    opts.answered !== undefined ||
    opts.sipCallId !== undefined;

  const total =
    typeof response.total === "number" && Number.isFinite(response.total)
      ? response.total
      : undefined;
  let nextSkip: number | undefined;
  if (filtered.length > limit) {
    nextSkip = skip + shown[shown.length - 1].index + 1;
  } else if (
    pageRows.length === PAGE_SIZE &&
    (total === undefined || total > page * PAGE_SIZE)
  ) {
    nextSkip = page * PAGE_SIZE;
  }

  const actions = [
    "A call row does not name the Cognigy project or session: match it to your own logs by sipCallId or start time. Pass a call's traceId to get_resource { resourceType: 'voice_call' } for its timing.",
  ];
  if (filtering) {
    actions.push(
      `The direction, answered and sipCallId filters apply only to the ${rows.length} calls read from this page (up to ${PAGE_SIZE}); total counts every call in the window.`,
    );
  }
  if (nextSkip !== undefined) {
    actions.push(`More calls follow: call again with skip: ${nextSkip}.`);
  }
  return {
    body: {
      items: shown.map((s) => s.row),
      ...(total !== undefined ? { total } : {}),
      skip,
      limit,
      read: rows.length,
      returned: shown.length,
    },
    hint: { action: actions.join(" ") },
  };
}

export async function getVoiceCall(
  ctx: VoiceGatewayContext,
  opts: { id: string },
): Promise<VoiceCallResult> {
  if (!TRACE_ID_RE.test(opts.id)) {
    return {
      body: {
        error:
          "id must be a Voice Gateway traceId, as listed by list_resources { resourceType: 'voice_call' }.",
      },
    };
  }
  if (!ctx.vg) return notConfigured();
  const sid = await accountId(ctx);
  const raw = await ctx.vg.get(`/Accounts/${sid}/RecentCalls/trace/${opts.id}`);
  const summary = summarizeTrace(raw);
  if (!summary) {
    throw new Error(
      "The Voice Gateway returned a trace in an unexpected format.",
    );
  }
  const actions = [
    "This is timing only: the caller's words, numbers and request bodies are never returned. Voice Gateway keeps traces for up to 14 days.",
  ];
  if (summary.spans.truncated) {
    actions.push(
      `Only the first ${summary.spans.read} spans of ${summary.spans.total} were read, so counts are partial.`,
    );
  }
  if (
    summary.speech.truncated ||
    summary.listening.truncated ||
    summary.gatherConnect.truncated
  ) {
    actions.push(
      "At most 50 turns of each kind are listed; count says how many there were.",
    );
  }
  return {
    body: { traceId: opts.id, ...summary },
    hint: { action: actions.join(" ") },
  };
}
