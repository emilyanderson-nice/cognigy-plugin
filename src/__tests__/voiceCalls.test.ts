/**
 * Voice Gateway calls as a resource: list_resources / get_resource
 * `voice_call`. Read-only; the list row is built field by field and the trace is
 * summarised by the allow-list parser. Every client is a mock.
 */
import { describe, expect, it, jest } from "@jest/globals";
import {
  getVoiceCall,
  listVoiceCalls,
  type VoiceGatewayContext,
} from "../voicegateway/calls.js";

const SID = "11111111-2222-3333-4444-555555555555";
const TRACE = "0123456789abcdef0123456789abcdef";
const CALL = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type VgGet = (
  path: string,
  params?: Record<string, string | number>,
) => Promise<unknown>;
type CogGet = (url: string) => Promise<unknown>;

const row = (n: number, over: Record<string, unknown> = {}) => ({
  attempted_at: `2026-11-01T10:${String(n).padStart(2, "0")}:00.000Z`,
  account_sid: SID,
  answered: true,
  answered_at: `2026-11-01T10:${String(n).padStart(2, "0")}:02.000Z`,
  application_sid: "app-sid-leak",
  call_sid: CALL,
  connector_type: null,
  direction: "inbound",
  duration: 42,
  endpointId: null,
  from: "+4915112345678",
  host: null,
  organisationId: null,
  projectId: null,
  recording_url: "https://rec.example.test/secret.mp3",
  remote_host: "203.0.113.7",
  service_provider_sid: "sp-sid-leak",
  sip_callid: `abc${n}@sbc.example.test`,
  sip_status: 200,
  terminated_at: `2026-11-01T10:${String(n).padStart(2, "0")}:44.000Z`,
  termination_reason: "hangup by caller",
  to: "+4930987654321",
  trace_id: TRACE,
  trunk: "my-trunk",
  ...over,
});

function make(
  rows: unknown[] = [],
  extra: { total?: number; vg?: VgGet; cog?: CogGet; noVg?: boolean } = {},
) {
  const vgGet = jest.fn<VgGet>(
    extra.vg ??
      (async () => ({
        total: extra.total ?? rows.length,
        page_size: "100",
        page: "1",
        data: rows,
      })),
  );
  const cogGet = jest.fn<CogGet>(
    extra.cog ?? (async () => ({ voiceGatewayAccount: SID })),
  );
  const ctx: VoiceGatewayContext = {
    cognigy: { get: cogGet },
    vg: extra.noVg ? undefined : { get: vgGet },
    accountCache: {},
  };
  return { ctx, vgGet, cogGet };
}

describe("listVoiceCalls", () => {
  it("asks for one page of 100 and returns each call as an allow-listed row", async () => {
    const { ctx, vgGet } = make([row(1), row(2)]);
    const r = await listVoiceCalls(ctx, {});
    expect(vgGet).toHaveBeenCalledWith(`/Accounts/${SID}/RecentCalls`, {
      page: 1,
      count: 100,
    });
    expect(r.body.items).toStrictEqual([
      {
        callSid: CALL,
        traceId: TRACE,
        sipCallId: "abc1@sbc.example.test",
        direction: "inbound",
        answered: true,
        attemptedAt: "2026-11-01T10:01:00.000Z",
        answeredAt: "2026-11-01T10:01:02.000Z",
        terminatedAt: "2026-11-01T10:01:44.000Z",
        durationSeconds: 42,
        sipStatus: 200,
        terminationReason: "hangup by caller",
      },
      expect.objectContaining({ sipCallId: "abc2@sbc.example.test" }),
    ]);
    expect(r.body.total).toBe(2);
    expect(r.body.returned).toBe(2);
  });

  it("never returns caller numbers, hosts, the recording, sids or any field not on the allow-list", async () => {
    const { ctx } = make([row(1)]);
    const r = await listVoiceCalls(ctx, {});
    const text = JSON.stringify(r);
    for (const leak of [
      "+4915112345678",
      "+4930987654321",
      "203.0.113.7",
      "rec.example.test",
      "app-sid-leak",
      "sp-sid-leak",
      "my-trunk",
      SID,
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it("omits a field whose value is not what it should be, never passing an object through", async () => {
    const { ctx } = make([
      row(1, {
        call_sid: "not-a-uuid",
        trace_id: "has spaces and ../",
        sip_callid: "bad value <script>",
        direction: "sideways",
        answered: "yes",
        duration: -3,
        sip_status: { nested: "x" },
        termination_reason: "x".repeat(65),
        attempted_at: "not a date",
        answered_at: { a: 1 },
      }),
    ]);
    const r = await listVoiceCalls(ctx, {});
    expect(r.body.items).toStrictEqual([
      { terminatedAt: "2026-11-01T10:01:44.000Z" },
    ]);
  });

  it("passes days to the platform and the filters are applied to the rows read", async () => {
    const rows = [
      row(1, { direction: "inbound", answered: true }),
      row(2, { direction: "outbound", answered: true }),
      row(3, { direction: "inbound", answered: false }),
    ];
    const { ctx, vgGet } = make(rows);
    const r = await listVoiceCalls(ctx, {
      days: 3,
      direction: "inbound",
      answered: true,
    });
    expect(vgGet).toHaveBeenCalledWith(`/Accounts/${SID}/RecentCalls`, {
      page: 1,
      count: 100,
      days: 3,
    });
    expect(
      (r.body.items as { sipCallId: string }[]).map((i) => i.sipCallId),
    ).toStrictEqual(["abc1@sbc.example.test"]);
    expect(r.body.read).toBe(3);
    expect(r.hint?.action).toContain("filters");
  });

  it("finds a call by its SIP Call-ID, exact match", async () => {
    const { ctx } = make([row(1), row(2), row(3)]);
    const r = await listVoiceCalls(ctx, { sipCallId: "abc2@sbc.example.test" });
    expect(r.body.items).toHaveLength(1);
    const none = await listVoiceCalls(ctx, {
      sipCallId: "ABC2@sbc.example.test",
    });
    expect(none.body.items).toStrictEqual([]);
  });

  it("limits the rows returned and says where to continue", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    const { ctx } = make(rows, { total: 250 });
    const r = await listVoiceCalls(ctx, { limit: 10 });
    expect(r.body.items).toHaveLength(10);
    expect(r.body.returned).toBe(10);
    expect(r.body.total).toBe(250);
    expect(r.hint?.action).toContain("skip: 10");
  });

  it("pages by skip: skip 100 reads platform page 2, skip 130 reads page 2 from offset 30", async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row(i % 60, { sip_callid: `call-${i}` }),
    );
    const { ctx, vgGet } = make(rows, { total: 300 });
    const r = await listVoiceCalls(ctx, { skip: 130, limit: 5 });
    expect(vgGet).toHaveBeenCalledWith(`/Accounts/${SID}/RecentCalls`, {
      page: 2,
      count: 100,
    });
    expect((r.body.items as { sipCallId: string }[])[0].sipCallId).toBe(
      "call-30",
    );
    expect(r.hint?.action).toContain("skip: 135");
  });

  it("offers the next page when the read page is used up and the platform has more", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i % 60));
    const { ctx } = make(rows, { total: 250 });
    const r = await listVoiceCalls(ctx, { limit: 100 });
    expect(r.hint?.action).toContain("skip: 100");
  });

  it("reads the account id once and reuses it", async () => {
    const { ctx, cogGet } = make([row(1)]);
    await listVoiceCalls(ctx, {});
    await listVoiceCalls(ctx, {});
    expect(cogGet).toHaveBeenCalledTimes(1);
    expect(cogGet).toHaveBeenCalledWith(
      "/v2.0/organisations/voicegateway/account",
    );
  });

  it("refuses an account id that is not a UUID before it reaches a URL", async () => {
    const { ctx, vgGet } = make([row(1)], {
      cog: async () => ({ voiceGatewayAccount: "../../etc" }),
    });
    await expect(listVoiceCalls(ctx, {})).rejects.toThrow(
      "The Voice Gateway account id has an unexpected format.",
    );
    expect(vgGet).not.toHaveBeenCalled();
  });

  it("without credentials it makes no request and says how to add them", async () => {
    const { ctx, vgGet, cogGet } = make([], { noVg: true });
    const r = await listVoiceCalls(ctx, {});
    expect(r.body.error).toBe(
      "Voice Gateway is not configured for this environment.",
    );
    expect(r.hint?.action).toContain("--voice-gateway-url");
    expect(r.hint?.action).toContain("VOICE_GATEWAY_API_KEY");
    expect(vgGet).not.toHaveBeenCalled();
    expect(cogGet).not.toHaveBeenCalled();
  });

  it("a failure on the Voice Gateway keeps its fixed message and nothing else", async () => {
    const boom = new Error("Voice Gateway request failed (HTTP 401).");
    const { ctx } = make([], {
      vg: async () => {
        throw boom;
      },
    });
    await expect(listVoiceCalls(ctx, {})).rejects.toThrow(
      "Voice Gateway request failed (HTTP 401).",
    );
  });

  it("a failure reading the account id is a fixed text with the status", async () => {
    const { ctx } = make([], {
      cog: async () => {
        throw Object.assign(new Error("UPSTREAM-SECRET"), { status: 403 });
      },
    });
    await expect(listVoiceCalls(ctx, {})).rejects.toThrow(
      "Could not read the Voice Gateway account (HTTP 403).",
    );
  });

  it("a response that is not a list is an error, not an empty result", async () => {
    const { ctx } = make([], { vg: async () => "<html>portal</html>" });
    await expect(listVoiceCalls(ctx, {})).rejects.toThrow(
      "The Voice Gateway returned a call list in an unexpected format.",
    );
  });

  it("explains that a row does not name the Cognigy project or session", async () => {
    const { ctx } = make([row(1)]);
    const r = await listVoiceCalls(ctx, {});
    expect(r.hint?.action).toContain("sipCallId");
  });
});

describe("getVoiceCall", () => {
  const traceDoc = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: "tts-generation",
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "1500000000",
                attributes: [
                  {
                    key: "time_to_first_byte_ms",
                    value: { stringValue: "250" },
                  },
                  {
                    key: "gm.transcript",
                    value: { stringValue: "SECRET WORDS" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it("reads the trace by id and returns the summary, never the caller's words", async () => {
    const { ctx, vgGet } = make([], { vg: async () => traceDoc });
    const r = await getVoiceCall(ctx, { id: TRACE });
    expect(vgGet).toHaveBeenCalledWith(
      `/Accounts/${SID}/RecentCalls/trace/${TRACE}`,
    );
    expect(r.body.traceId).toBe(TRACE);
    expect((r.body.speech as { ttfbMs: unknown }).ttfbMs).toStrictEqual({
      min: 250,
      median: 250,
      max: 250,
    });
    expect(JSON.stringify(r)).not.toContain("SECRET WORDS");
  });

  it.each([
    "",
    "short",
    "has space in it",
    "../../x",
    "a".repeat(65),
    "id;rm -rf",
  ])("refuses the id %j before any request", async (id) => {
    const { ctx, vgGet, cogGet } = make();
    const r = await getVoiceCall(ctx, { id });
    expect(r.body.error).toContain("traceId");
    expect(vgGet).not.toHaveBeenCalled();
    expect(cogGet).not.toHaveBeenCalled();
  });

  it("without credentials it makes no request and says how to add them", async () => {
    const { ctx, vgGet } = make([], { noVg: true });
    const r = await getVoiceCall(ctx, { id: TRACE });
    expect(r.body.error).toBe(
      "Voice Gateway is not configured for this environment.",
    );
    expect(vgGet).not.toHaveBeenCalled();
  });

  it("a response that is not a trace is an error", async () => {
    const { ctx } = make([], { vg: async () => ({ hello: "world" }) });
    await expect(getVoiceCall(ctx, { id: TRACE })).rejects.toThrow(
      "The Voice Gateway returned a trace in an unexpected format.",
    );
  });

  it("says the result is timing only, and that traces are kept for a limited time", async () => {
    const { ctx } = make([], { vg: async () => traceDoc });
    const r = await getVoiceCall(ctx, { id: TRACE });
    expect(r.hint?.action).toContain("timing");
    expect(r.hint?.action).toContain("14 days");
  });

  it("says when spans or turns were cut", async () => {
    const spans = Array.from({ length: 5_100 }, (_, i) => ({
      name: "other",
      startTimeUnixNano: String(1_000_000_000 + i),
      endTimeUnixNano: String(1_000_000_001 + i),
    }));
    const { ctx } = make([], {
      vg: async () => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
    });
    const r = await getVoiceCall(ctx, { id: TRACE });
    expect(r.hint?.action).toContain("5000");
  });
});
