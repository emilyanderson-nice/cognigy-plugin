/**
 * Fixes from the independent review of the voice_call change: the registry must
 * rebuild a runtime when only the Voice Gateway credentials change, the base URL
 * must not carry userinfo, a query or a fragment, a very large trace must not
 * throw, trace numbers are rounded the same way everywhere, the call timeline is
 * capped, and paging works from an offset into a page.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { createEnvironmentRegistry } from "../environments/registry.js";
import { loadProfiles, type Profile } from "../profiles/profiles.js";
import { summarizeTrace } from "../voicegateway/traceSummary.js";
import {
  listVoiceCalls,
  type VoiceGatewayContext,
} from "../voicegateway/calls.js";

const API_URL = "https://api-dev.cognigy.ai";
const VG_URL = "https://api-vg-dev.example.test";

const setWith = (extra: Record<string, string> = {}) =>
  loadProfiles({
    fileProfiles: {
      profiles: {
        dev: { apiBaseUrl: API_URL, apiKey: "cognigy-key-REG-0001", ...extra },
      },
      problems: [],
    },
  });

describe("registry: Voice Gateway credentials are part of the runtime", () => {
  function registryOver(sets: ReturnType<typeof setWith>[]) {
    let i = 0;
    const createRuntime = jest.fn((p: Profile) => ({
      profile: p,
      client: {},
      handlers: { handleToolCall: async () => ({}) },
    }));
    const registry = createEnvironmentRegistry({
      loadProfiles: () => sets[Math.min(i++, sets.length - 1)],
      createRuntime,
    });
    return { registry, createRuntime };
  }

  it("reuses the runtime when nothing changed", () => {
    const same = setWith({
      voiceGatewayBaseUrl: VG_URL,
      voiceGatewayApiKey: "vg-key-REG-AAAA1111",
    });
    const { registry, createRuntime } = registryOver([same, same]);
    registry.resolve("dev");
    registry.resolve("dev");
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "credentials added to an existing profile",
      setWith(),
      setWith({
        voiceGatewayBaseUrl: VG_URL,
        voiceGatewayApiKey: "vg-key-REG-AAAA1111",
      }),
    ],
    [
      "the Voice Gateway key rotated",
      setWith({
        voiceGatewayBaseUrl: VG_URL,
        voiceGatewayApiKey: "vg-key-REG-AAAA1111",
      }),
      setWith({
        voiceGatewayBaseUrl: VG_URL,
        voiceGatewayApiKey: "vg-key-REG-BBBB2222",
      }),
    ],
    [
      "the Voice Gateway URL changed",
      setWith({
        voiceGatewayBaseUrl: VG_URL,
        voiceGatewayApiKey: "vg-key-REG-AAAA1111",
      }),
      setWith({
        voiceGatewayBaseUrl: "https://api-vg-other.example.test",
        voiceGatewayApiKey: "vg-key-REG-AAAA1111",
      }),
    ],
    [
      "credentials removed",
      setWith({
        voiceGatewayBaseUrl: VG_URL,
        voiceGatewayApiKey: "vg-key-REG-AAAA1111",
      }),
      setWith(),
    ],
  ])("builds a new runtime when %s", (_label, before, after) => {
    const { registry, createRuntime } = registryOver([before, after]);
    registry.resolve("dev");
    registry.resolve("dev");
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });
});

describe("Voice Gateway base URL: only an origin and a path", () => {
  const problem = (url: string) =>
    loadProfiles({
      fileProfiles: {
        profiles: {
          dev: {
            apiBaseUrl: API_URL,
            apiKey: "cognigy-key-URL-0001",
            voiceGatewayBaseUrl: url,
            voiceGatewayApiKey: "vg-key-URL-AAAA1111",
          },
        },
        problems: [],
      },
    }).problems.find((p) => p.name === "dev")?.reason;

  it.each([
    ["userinfo", "https://user:secretpw@api-vg-dev.example.test/v1"],
    ["a username only", "https://user@api-vg-dev.example.test/v1"],
    ["a query", "https://api-vg-dev.example.test/v1?zzqueryval=1"],
    ["a fragment", "https://api-vg-dev.example.test/v1#zzfragval"],
  ])(
    "refuses a URL with %s, naming the field and quoting no value",
    (_l, url) => {
      const reason = problem(url) ?? "";
      expect(reason).toContain(
        "voiceGatewayBaseUrl must be an https URL without credentials, a query or a fragment.",
      );
      expect(reason).not.toContain("secretpw");
      expect(reason).not.toContain("zzqueryval");
      expect(reason).not.toContain("zzfragval");
    },
  );

  it("still accepts a host, a host with /v1 and a path", () => {
    for (const url of [
      VG_URL,
      `${VG_URL}/v1`,
      `${VG_URL}/v1/`,
      `${VG_URL}/prefix/v1`,
    ]) {
      expect(problem(url)).toBeUndefined();
    }
  });
});

describe("summarizeTrace: large input and consistent numbers", () => {
  const mk = (
    name: string,
    startMs: number,
    endMs: number,
    attrs: unknown[] = [],
  ) => ({
    name,
    startTimeUnixNano: String(
      1_000_000_000_000n + BigInt(startMs) * 1_000_000n,
    ),
    endTimeUnixNano: String(1_000_000_000_000n + BigInt(endMs) * 1_000_000n),
    attributes: attrs,
  });
  const trace = (spans: unknown[]) => ({
    resourceSpans: [{ scopeSpans: [{ spans }] }],
  });

  it("does not throw on a trace with hundreds of thousands of spans, and reports the real total", () => {
    const spans = Array.from({ length: 300_000 }, (_, i) =>
      mk("other", i, i + 1),
    );
    const out = summarizeTrace(trace(spans));
    expect(out?.spans).toStrictEqual({
      total: 300_000,
      read: 5_000,
      truncated: true,
    });
  });

  it("rounds minimum, median and maximum time to first byte to one decimal alike", () => {
    const ttfb = (v: string) => [
      { key: "time_to_first_byte_ms", value: { stringValue: v } },
    ];
    const out = summarizeTrace(
      trace([
        mk("tts-generation", 0, 10, ttfb("100.123456")),
        mk("tts-generation", 20, 30, ttfb("200.987654")),
        mk("tts-generation", 40, 50, ttfb("300.555555")),
      ]),
    );
    expect(out?.speech.ttfbMs).toStrictEqual({
      min: 100.1,
      median: 201,
      max: 300.6,
    });
  });

  it("lists at most 50 call-status entries and says when it cut", () => {
    // status names are lowercase letters and hyphens only
    const name = (i: number) =>
      `s${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
    const spans = Array.from({ length: 80 }, (_, i) =>
      mk(`call-status:${name(i)}`, i, i + 1),
    );
    const out = summarizeTrace(trace(spans));
    expect(out?.call.timeline).toHaveLength(50);
    expect(out?.call.timelineTruncated).toBe(true);
    const few = summarizeTrace(trace(spans.slice(0, 3)));
    expect(few?.call).not.toHaveProperty("timelineTruncated");
  });
});

describe("listVoiceCalls: an offset into a page with a filter and a limit", () => {
  it("returns the right rows and resumes after the last one shown", async () => {
    const SID = "11111111-2222-3333-4444-555555555555";
    // 100 rows: inbound at even positions, outbound at odd
    const rows = Array.from({ length: 100 }, (_, i) => ({
      call_sid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      trace_id: "0123456789abcdef0123456789abcdef",
      sip_callid: `call-${i}`,
      direction: i % 2 === 0 ? "inbound" : "outbound",
      answered: true,
      attempted_at: "2026-11-01T10:00:00.000Z",
      duration: 5,
    }));
    const vgGet = jest.fn(async () => ({ total: 400, data: rows }));
    const ctx: VoiceGatewayContext = {
      cognigy: { get: async () => ({ voiceGatewayAccount: SID }) },
      vg: { get: vgGet },
      accountCache: {},
    };
    // page 2 (skip 100..199) is requested; offset 10 -> rows 110.. ; inbound only
    const r = await listVoiceCalls(ctx, {
      skip: 110,
      limit: 3,
      direction: "inbound",
    });
    const ids = (r.body.items as { sipCallId: string }[]).map(
      (i) => i.sipCallId,
    );
    // the response is the fake's page 2; rows after offset 10 are call-10 ...
    expect(ids).toStrictEqual(["call-10", "call-12", "call-14"]);
    // resumes right after the last shown row (index 4 in the offset slice)
    expect(r.hint?.action).toContain("skip: 115");
    expect(r.body.read).toBe(90);
  });
});
