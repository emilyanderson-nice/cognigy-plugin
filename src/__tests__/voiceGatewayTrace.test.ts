/**
 * Voice Gateway call trace (OpenTelemetry JSON, V4/V5) -> a small summary. The
 * summary is built field by field from an allow-list: the trace holds the
 * caller's words and numbers (gm.transcript, stt.result, from, to, callerName,
 * bodies), none of which may reach the result, at any nesting level.
 */
import { describe, expect, it } from "@jest/globals";
import { summarizeTrace } from "../voicegateway/traceSummary.js";

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
let counter = 0;

type AttrValue = string | number | boolean;
const attr = (key: string, v: AttrValue) => ({
  key,
  value:
    typeof v === "string"
      ? { stringValue: v }
      : typeof v === "number"
        ? { doubleValue: v }
        : { boolValue: v },
});
const ns = (ms: number) =>
  String(BigInt(T0) * 1_000_000n + BigInt(Math.round(ms * 1e6)));
const span = (
  name: string,
  startMs: number,
  endMs: number,
  attrs: Record<string, AttrValue> = {},
) => ({
  traceId: "t",
  spanId: `s${counter++}`,
  parentSpanId: "",
  name,
  startTimeUnixNano: ns(startMs),
  endTimeUnixNano: ns(endMs),
  attributes: Object.entries(attrs).map(([k, v]) => attr(k, v)),
  status: {},
});
const trace = (...spans: unknown[]) => ({
  resourceSpans: [{ scopeSpans: [{ spans }] }],
});

const PERSONAL = {
  "gm.transcript": "my card number is 4111 1111 1111 1111",
  "gm.input": "caller said hello world",
  "stt.result": '[{"transcript":"secret words from the caller"}]',
  "verb.text": "Dear Alice Example, your balance is 100",
  from: "+4915112345678",
  to: "+4930987654321",
  callerName: "Alice Example",
  body: "INVITE sip:alice@example.test",
  "http.body": '{"ssn":"123-45-6789"}',
  originatingSipIp: "203.0.113.7",
  fsSipAddress: "198.51.100.9",
  apiBaseUrl: "https://internal.example.test",
  "elevenlabs.req_id": "req-leak-1",
};

describe("summarizeTrace: the happy path", () => {
  it("summarises a call: timeline, speech, listening and connect times", () => {
    const out = summarizeTrace(
      trace(
        span("incoming-call", 0, 20_000, {
          finalStatus: 200,
          "call.termination": "hangup by caller",
        }),
        span("call-status:trying", 5, 6),
        span("call-status:in-progress", 900, 901),
        span("call-status:completed", 19_990, 19_991, {
          callTerminationBy: "caller",
        }),
        span("gather:connecting", 1_000, 1_115.5, {
          "stt.vendor": "deepgram",
          "stt.connecting.success": true,
        }),
        span("verb:say", 1_200, 4_400),
        span("tts-generation", 1_210, 1_900, {
          "tts.vendor": "elevenlabs",
          "tts.model": "eleven_flash_v2_5",
          "tts.voice": "voiceId123",
          "tts.language": "en",
          "tts.characters": 51,
          "tts.cached": false,
          "tts.streaming": true,
          "tts.isFallback": false,
          time_to_first_byte_ms: "412.5",
        }),
        span(
          "verb:gather{inputs=speech,vendor=deepgram,language=en-US}",
          4_500,
          9_000,
          {
            "stt.vendor": "deepgram",
            "stt.model": "nova-3",
            "stt.isFallback": false,
          },
        ),
      ),
    );
    expect(out).toStrictEqual({
      startedAt: "2026-11-01T10:00:00.000Z",
      call: {
        durationMs: 20_000,
        finalStatus: 200,
        termination: "hangup by caller",
        terminatedBy: "caller",
        timeline: [
          { status: "trying", atMs: 5 },
          { status: "in-progress", atMs: 900 },
          { status: "completed", atMs: 19_990 },
        ],
      },
      speech: {
        count: 1,
        truncated: false,
        ttfbMs: { min: 412.5, median: 412.5, max: 412.5 },
        turns: [
          {
            atMs: 1_210,
            durationMs: 690,
            ttfbMs: 412.5,
            vendor: "elevenlabs",
            model: "eleven_flash_v2_5",
            voice: "voiceId123",
            language: "en",
            characters: 51,
            cached: false,
            streaming: true,
            fallback: false,
          },
        ],
      },
      listening: {
        count: 1,
        truncated: false,
        turns: [
          {
            atMs: 4_500,
            durationMs: 4_500,
            vendor: "deepgram",
            model: "nova-3",
            fallback: false,
          },
        ],
      },
      gatherConnect: {
        count: 1,
        truncated: false,
        turns: [
          { atMs: 1_000, durationMs: 115.5, vendor: "deepgram", success: true },
        ],
      },
      bargeIn: {
        observed: false,
        matchingSpans: 0,
        note: "No barge-in or voice-activity span or attribute appeared in this trace; that is not proof it did not happen.",
      },
      spans: { total: 8, read: 8, truncated: false },
    });
  });

  it("gives min, median and max time to first byte; the median of an even count is the mean of the middle two", () => {
    const spans = [100, 300, 200, 400].map((ttfb, i) =>
      span("tts-generation", i * 1000, i * 1000 + 500, {
        time_to_first_byte_ms: String(ttfb),
      }),
    );
    const out = summarizeTrace(trace(...spans));
    expect(out?.speech.ttfbMs).toStrictEqual({
      min: 100,
      median: 250,
      max: 400,
    });
    const odd = summarizeTrace(trace(...spans.slice(0, 3)));
    expect(odd?.speech.ttfbMs).toStrictEqual({
      min: 100,
      median: 200,
      max: 300,
    });
  });

  it("has no ttfb summary when no speech span carries one", () => {
    const out = summarizeTrace(trace(span("tts-generation", 0, 10)));
    expect(out?.speech.ttfbMs).toBeNull();
    expect(out?.speech.turns[0]).toStrictEqual({ atMs: 0, durationMs: 10 });
  });

  it("reports offsets from the earliest span when there is no incoming-call root", () => {
    const out = summarizeTrace(
      trace(span("tts-generation", 500, 600), span("verb:say", 450, 700)),
    );
    expect(out?.speech.turns[0].atMs).toBe(50);
    expect(out?.call.durationMs).toBeUndefined();
  });
});

describe("summarizeTrace: nothing personal reaches the result", () => {
  it("drops every personal attribute from every span, whatever the span", () => {
    const out = summarizeTrace(
      trace(
        span("incoming-call", 0, 1000, PERSONAL),
        span("call-status:completed", 900, 901, PERSONAL),
        span("tts-generation", 10, 20, {
          ...PERSONAL,
          "tts.vendor": "elevenlabs",
        }),
        span("verb:gather{inputs=speech}", 30, 40, PERSONAL),
        span("gather:streaming", 30, 40, PERSONAL),
        span("verb:sip:request", 50, 60, PERSONAL),
      ),
    );
    const text = JSON.stringify(out);
    for (const secret of [
      "4111",
      "hello world",
      "secret words",
      "Alice",
      "+4915112345678",
      "+4930987654321",
      "INVITE",
      "123-45-6789",
      "203.0.113.7",
      "198.51.100.9",
      "internal.example.test",
      "req-leak-1",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("never returns a span name: names carry voice ids and parameters", () => {
    const out = summarizeTrace(
      trace(
        span(
          "verb:config{set synthesizer{elevenlabs,en,eZm9vdjYgL9PZKtf7XMM,enterprise}}",
          0,
          1,
        ),
        span("verb:gather{inputs=speech,vendor=deepgram,language=en-US}", 2, 3),
      ),
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain("eZm9vdjYgL9PZKtf7XMM");
    expect(text).not.toContain("synthesizer");
    expect(text).not.toContain("inputs=speech");
  });

  it("omits an allow-listed field whose value is not a short plain token", () => {
    const out = summarizeTrace(
      trace(
        span("tts-generation", 0, 10, {
          "tts.vendor": "a@b.com",
          "tts.model": "x".repeat(65),
          "tts.voice": "<script>alert(1)</script>",
          "tts.language": "en US\nline two",
        }),
        span("verb:gather", 20, 30, { "stt.vendor": "+4915112345678" }),
      ),
    );
    expect(out?.speech.turns[0]).toStrictEqual({ atMs: 0, durationMs: 10 });
    expect(out?.listening.turns[0]).toStrictEqual({ atMs: 20, durationMs: 10 });
    const text = JSON.stringify(out);
    expect(text).not.toContain("a@b.com");
    expect(text).not.toContain("script");
  });

  it("omits a number that is not finite and non-negative, and a status that is not a token", () => {
    const out = summarizeTrace(
      trace(
        span("incoming-call", 0, 100, { finalStatus: -5 }),
        span("call-status:hello world\u0000", 1, 2),
        span("tts-generation", 0, 10, {
          "tts.characters": Number.POSITIVE_INFINITY,
          time_to_first_byte_ms: "not a number",
        }),
      ),
    );
    expect(out?.call.finalStatus).toBeUndefined();
    expect(out?.call.timeline).toStrictEqual([]);
    expect(out?.speech.turns[0]).toStrictEqual({ atMs: 0, durationMs: 10 });
  });
});

describe("summarizeTrace: limits and odd input", () => {
  it("counts every speech span but lists at most 50 turns, and says so", () => {
    const spans = Array.from({ length: 80 }, (_, i) =>
      span("tts-generation", i * 10, i * 10 + 5),
    );
    const out = summarizeTrace(trace(...spans));
    expect(out?.speech.count).toBe(80);
    expect(out?.speech.turns).toHaveLength(50);
    expect(out?.speech.truncated).toBe(true);
    expect(out?.speech.turns[0].atMs).toBe(0);
  });

  it("reads at most 5000 spans and says so", () => {
    const spans = Array.from({ length: 5_300 }, (_, i) =>
      span("other", i, i + 1),
    );
    const out = summarizeTrace(trace(...spans));
    expect(out?.spans).toStrictEqual({
      total: 5_300,
      read: 5_000,
      truncated: true,
    });
  });

  it("reports barge-in only as a count of matching spans, never their names or values", () => {
    const out = summarizeTrace(
      trace(
        span("vad-speech-start-while-speaking", 0, 1),
        span("verb:say", 2, 3, {
          bargeInDetected: true,
          "gm.transcript": "secret",
        }),
        span("verb:say", 4, 5),
      ),
    );
    expect(out?.bargeIn.observed).toBe(true);
    expect(out?.bargeIn.matchingSpans).toBe(2);
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(JSON.stringify(out)).not.toContain("vad-speech");
  });

  it.each([
    ["not an object", "text"],
    ["no resourceSpans", {}],
    ["resourceSpans is not a list", { resourceSpans: "x" }],
    ["null", null],
  ])("returns null for %s", (_l, input) => {
    expect(summarizeTrace(input)).toBeNull();
  });

  it("skips spans with unreadable times without throwing, and keeps the rest", () => {
    const bad = {
      name: "tts-generation",
      startTimeUnixNano: "abc",
      endTimeUnixNano: ns(5),
      attributes: [],
    };
    const worse = {
      name: "tts-generation",
      startTimeUnixNano: 7,
      attributes: "x",
    };
    const out = summarizeTrace(
      trace(bad, worse, null, "junk", span("tts-generation", 10, 20)),
    );
    expect(out?.speech.count).toBe(1);
    // the one readable span is also the earliest, so it sits at offset 0
    expect(out?.speech.turns).toStrictEqual([{ atMs: 0, durationMs: 10 }]);
  });
});
