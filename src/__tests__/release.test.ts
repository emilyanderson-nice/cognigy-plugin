import { describe, it, expect, afterEach, jest } from "@jest/globals";
import {
  compareRelease,
  createReleaseDetector,
  parseRelease,
  type HttpGetter,
  type ParsedRelease,
} from "../profiles/release.js";
import { eq, ok } from "./helpers/specAssert.js";

const OPENAPI_PATH = "/openapi/openapi-viewer.json";
const SECRET = "secret-xyz";

function rel(year: number, week: number, patch: number): ParsedRelease {
  return { year, week, patch, raw: `${year}.${week}.${patch}` };
}

/** Fake client: records every requested URL; handler decides the outcome. */
function fakeClient(handler: (url: string) => unknown): {
  client: HttpGetter;
  calls: string[];
} {
  const calls: string[] = [];
  const client: HttpGetter = {
    async get<T = unknown>(url: string): Promise<T> {
      calls.push(url);
      return (await handler(url)) as T;
    },
  };
  return { client, calls };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const doc = (version: unknown): unknown => ({
  info: { title: "Cognigy", version },
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("parseRelease (Module C, calendar version parsing)", () => {
  it.each([
    ["2026.21.0", 2026, 21, 0],
    ["2026.1.10", 2026, 1, 10],
    ["2025.52.3", 2025, 52, 3],
    ["2026.05.3", 2026, 5, 3],
  ])("parses %s", (input, year, week, patch) => {
    const parsed = parseRelease(input);
    eq(
      parsed,
      { year, week, patch, raw: input },
      `parseRelease(${JSON.stringify(input)})`,
      "C-parse: YYYY.W.P is a calendar release",
      "Return numeric year, week and patch and keep the original text in raw.",
    );
  });

  it("trims surrounding whitespace before parsing", () => {
    const parsed = parseRelease("  2026.21.0 \n");
    eq(
      parsed,
      { year: 2026, week: 21, patch: 0, raw: "2026.21.0" },
      'parseRelease("  2026.21.0 \\n")',
      "H1: input is trimmed and raw is the TRIMMED text",
      "Ignore surrounding whitespace, also in raw.",
    );
  });

  it.each([
    ["week 1 (lowest)", "2026.1.0", 1],
    ["week 53 (highest)", "2026.53.0", 53],
    ["year 2000 (lowest)", "2000.10.0", 10],
    ["year 2999 (highest)", "2999.10.0", 10],
    ["patch 9999 (highest)", "2026.10.9999", 10],
  ])("accepts the boundary %s", (_label, input, week) => {
    const parsed = parseRelease(input);
    eq(
      parsed?.week,
      week,
      `parseRelease(${input})`,
      "H1: week 1-53, year 2000-2999, patch 0-9999 are valid",
      "Accept values on the documented boundaries.",
    );
  });

  it.each([
    ["week 0", "2026.0.0"],
    ["week 00", "2026.00.0"],
    ["week 54", "2026.54.0"],
    ["week 99", "2026.99.0"],
    ["year 1999", "1999.10.0"],
    ["year 3000", "3000.10.0"],
    ["patch 10000", "2026.10.10000"],
    ["huge patch", "2026.10.99999999999999999999"],
  ])("rejects out-of-range %s", (_label, input) => {
    eq(
      parseRelease(input),
      undefined,
      `parseRelease(${input})`,
      "H1: week must be 1-53, year 2000-2999, patch < 10000",
      "Return undefined for implausible calendar values.",
    );
  });

  it.each([
    [""],
    ["   "],
    ["v4"],
    ["v2026.21.0"],
    ["2026.21"],
    ["2026.21.0.1"],
    ["26.21.0"],
    ["20260.21.0"],
    ["2026.123.0"],
    ["2026.21.x"],
    ["2026.-1.0"],
    ["2026.21.-1"],
    ["4.0.0"],
    ["2026.21.0-beta"],
    ["2026 21 0"],
  ])("rejects %j", (input) => {
    eq(
      parseRelease(input),
      undefined,
      `parseRelease(${JSON.stringify(input)})`,
      "C-parse: anything not /^\\d{4}\\.\\d{1,2}\\.\\d+$/ is not a calendar release",
      "Return undefined (never throw, never guess) for non-calendar versions.",
    );
  });
});

describe("compareRelease (Module C, ordering)", () => {
  it.each([
    ["equal releases", rel(2026, 21, 0), rel(2026, 21, 0), 0],
    ["older year", rel(2025, 52, 9), rel(2026, 1, 0), -1],
    ["newer year", rel(2027, 1, 0), rel(2026, 52, 9), 1],
    ["older week", rel(2026, 20, 5), rel(2026, 21, 0), -1],
    ["newer week", rel(2026, 22, 0), rel(2026, 21, 9), 1],
    ["older patch", rel(2026, 21, 0), rel(2026, 21, 1), -1],
    ["newer patch", rel(2026, 21, 2), rel(2026, 21, 1), 1],
    ["numeric (not lexical) week", rel(2026, 9, 0), rel(2026, 10, 0), -1],
    ["numeric (not lexical) patch", rel(2026, 21, 9), rel(2026, 21, 10), -1],
  ])("%s", (label, a, b, expected) => {
    eq(
      compareRelease(a, b),
      expected,
      `compareRelease(${a.raw}, ${b.raw}) [${label}]`,
      "C-compare: order by year, then week, then patch, numerically",
      "Return exactly -1, 0 or 1 using calendar ordering.",
    );
    eq(
      compareRelease(b, a),
      -expected === 0 ? 0 : -expected,
      `compareRelease(${b.raw}, ${a.raw}) [${label}, swapped]`,
      "C-compare: ordering is antisymmetric",
      "Swapping the arguments flips the sign.",
    );
  });
});

describe("createReleaseDetector.detect: results", () => {
  it("reads info.version from the OpenAPI document with exactly one request", async () => {
    const { client, calls } = fakeClient(() => doc("2026.21.0"));
    const result = await createReleaseDetector(client).detect();
    eq(
      calls,
      [OPENAPI_PATH],
      "detect() request",
      "C-detect: one GET to the OpenAPI viewer document",
      "Request /openapi/openapi-viewer.json exactly once.",
    );
    eq(
      result,
      {
        release: { year: 2026, week: 21, patch: 0, raw: "2026.21.0" },
        source: "openapi",
      },
      "detect() with a valid calendar version",
      "C-detect: a valid version yields source=openapi and the parsed release",
      "Return the parsed release, source openapi, and no error.",
    );
  });

  it.each([
    ["non-calendar version", doc("v4")],
    ["two-part version", doc("2026.21")],
    ["numeric version", doc(20260521)],
    ["null version", doc(null)],
    ["missing version", { info: {} }],
    ["missing info", {}],
    ["null info", { info: null }],
    ["string body", "not an object"],
    ["null body", null],
    ["number body", 42],
    ["array body", []],
  ])(
    "returns source=unknown with an error string for %s",
    async (label, body) => {
      const { client } = fakeClient(() => body);
      const result = await createReleaseDetector(client).detect();
      eq(
        [
          result.source,
          result.release,
          typeof result.error,
          (result.error ?? "").length > 0,
        ],
        ["unknown", undefined, "string", true],
        `detect() with ${label}`,
        "C-detect: invalid or missing version => unknown + error, never a guess",
        "Return source unknown, no release, and a non-empty error message.",
      );
    },
  );

  it("never returns or logs the response body", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => jest.spyOn(console, m).mockImplementation(() => undefined),
    );
    const body = {
      info: { version: "2026.21.0", description: "BODY-MARKER-1" },
      paths: { "/BODY-MARKER-2": {} },
    };
    const bad = {
      info: { version: "BODY-MARKER-3" },
      paths: { "/BODY-MARKER-4": {} },
    };
    const good = await createReleaseDetector(
      fakeClient(() => body).client,
    ).detect();
    const invalid = await createReleaseDetector(
      fakeClient(() => bad).client,
    ).detect();
    const text = JSON.stringify([good, invalid]);
    ok(
      !text.includes("BODY-MARKER"),
      "detect() results contain response body text",
      "C-body: never return the response body",
      "no part of the OpenAPI document in the result or error",
      text,
      "Return only the parsed release or a fixed safe error.",
    );
    ok(
      spies.every((s) => s.mock.calls.length === 0),
      "detect() console output",
      "C-body: never log",
      "no console calls",
      JSON.stringify(spies.map((s) => s.mock.calls.length)),
      "Do not log anything during detection.",
    );
  });
});

describe("createReleaseDetector.detect: failures never reject and never leak", () => {
  it("resolves to unknown when get rejects, without leaking header text", async () => {
    const { client } = fakeClient(() => {
      throw new Error(`boom X-API-Key: ${SECRET}`);
    });
    const result = await createReleaseDetector(client).detect();
    eq(
      [result.source, result.release, typeof result.error],
      ["unknown", undefined, "string"],
      "detect() when get rejects",
      "C-detect: detect() never rejects",
      "Resolve with source unknown and an error string.",
    );
    ok(
      !JSON.stringify(result).includes(SECRET) &&
        !(result.error ?? "").includes("X-API-Key"),
      "detect() error text after a failing get",
      "C-secrecy: error must not contain header content",
      `no "${SECRET}" and no "X-API-Key" in the result`,
      JSON.stringify(result),
      "Replace the thrown message with a fixed safe string.",
    );
  });

  it("handles a client whose get throws synchronously", async () => {
    const client: HttpGetter = {
      get: (() => {
        throw new Error(`sync X-API-Key: ${SECRET}`);
      }) as HttpGetter["get"],
    };
    const result = await createReleaseDetector(client).detect();
    ok(
      result.source === "unknown" && !JSON.stringify(result).includes(SECRET),
      "detect() when get throws synchronously",
      "C-detect: detect() never rejects or leaks",
      "resolved unknown result without the secret",
      JSON.stringify(result),
      "Guard against both sync throws and rejected promises.",
    );
  });

  it("handles a non-Error rejection value without leaking it", async () => {
    const { client } = fakeClient(() => Promise.reject(`X-API-Key: ${SECRET}`));
    const result = await createReleaseDetector(client).detect();
    ok(
      result.source === "unknown" && !JSON.stringify(result).includes(SECRET),
      "detect() when get rejects with a string",
      "C-secrecy: nothing thrown may be echoed",
      "unknown result without the secret",
      JSON.stringify(result),
      "Never echo the rejection value.",
    );
  });

  it("includes only the numeric HTTP status from a thrown error", async () => {
    const { client } = fakeClient(() => {
      throw Object.assign(new Error(`HTTP 401 X-API-Key: ${SECRET}`), {
        status: 401,
      });
    });
    const result = await createReleaseDetector(client).detect();
    ok(
      (result.error ?? "").includes("401") &&
        !JSON.stringify(result).includes(SECRET),
      "detect() error for an error carrying status 401",
      "C-secrecy: at most the HTTP status number is exposed",
      'error contains "401" and not the secret',
      JSON.stringify(result),
      "Report a fixed message plus the numeric status only.",
    );
  });

  it("does not report a non-numeric status", async () => {
    const { client } = fakeClient(() => {
      throw Object.assign(new Error("x"), { status: `X-API-Key: ${SECRET}` });
    });
    const result = await createReleaseDetector(client).detect();
    ok(
      !JSON.stringify(result).includes(SECRET),
      "detect() error for an error with a string status",
      "C-secrecy: only a numeric status may be included",
      "no secret in the result",
      JSON.stringify(result),
      "Ignore status values that are not numbers.",
    );
  });
});

describe("createReleaseDetector.detect: memoisation", () => {
  it("shares one in-flight request between concurrent calls", async () => {
    const gate = deferred<unknown>();
    const { client, calls } = fakeClient(() => gate.promise);
    const detector = createReleaseDetector(client);
    const pending = [detector.detect(), detector.detect(), detector.detect()];
    gate.resolve(doc("2026.21.0"));
    const results = await Promise.all(pending);
    eq(
      calls.length,
      1,
      "get() call count for three concurrent detect() calls",
      "C-memo: concurrent calls share one request",
      "Issue a single request and share its outcome.",
    );
    const expected = {
      release: { year: 2026, week: 21, patch: 0, raw: "2026.21.0" },
      source: "openapi",
    };
    eq(
      results,
      [expected, expected, expected],
      "concurrent detect() results",
      "C-memo: all callers receive the same outcome",
      "Every concurrent caller resolves to the shared result.",
    );
  });

  it("caches a successful result for the detector's lifetime", async () => {
    const { client, calls } = fakeClient(() => doc("2026.21.0"));
    const detector = createReleaseDetector(client);
    const first = await detector.detect();
    const second = await detector.detect();
    const third = await detector.detect();
    eq(
      calls.length,
      1,
      "get() call count after three sequential successful detect() calls",
      "C-memo: success is cached",
      "Do not request again once a release was detected.",
    );
    eq(
      [second, third],
      [first, first],
      "cached detect() results",
      "C-memo: cached results equal the first",
      "Return the cached release unchanged.",
    );
  });

  it("negatively caches a failure for the default 30000 ms (injected clock), then retries once", async () => {
    let clock = 1_000_000;
    let attempt = 0;
    const { client, calls } = fakeClient(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return doc("2026.22.1");
    });
    const detector = createReleaseDetector(client, { now: () => clock });
    const first = await detector.detect();
    clock += 29_999;
    const within = await detector.detect();
    eq(
      [calls.length, within],
      [1, first],
      "detect() 29999 ms after a failure (default TTL)",
      "H2: a failure is cached for failureTtlMs (default 30000) and returned unchanged",
      "Do not call get again inside the TTL; return the same unknown result.",
    );
    clock += 2;
    const after = await detector.detect();
    eq(
      [first.source, calls.length, after.source, after.release?.raw],
      ["unknown", 2, "openapi", "2026.22.1"],
      "detect() 30001 ms after a failure",
      "H2: after the TTL exactly one new request is made",
      "Retry once the failure TTL has elapsed.",
    );
    clock += 1_000_000_000;
    await detector.detect();
    eq(
      calls.length,
      2,
      "detect() long after a success",
      "H2: success is cached for the detector's lifetime",
      "Never re-request after success, whatever the clock says.",
    );
  });

  it("honours a custom failureTtlMs", async () => {
    let clock = 0;
    const { client, calls } = fakeClient(() => {
      throw new Error("down");
    });
    const detector = createReleaseDetector(client, {
      failureTtlMs: 1000,
      now: () => clock,
    });
    await detector.detect();
    clock = 999;
    await detector.detect();
    const insideCalls = calls.length;
    clock = 1001;
    await detector.detect();
    eq(
      [insideCalls, calls.length],
      [1, 2],
      "detect() with failureTtlMs=1000 at 999 ms and 1001 ms",
      "H2: the TTL option controls negative caching",
      "Use the configured TTL, measured with the injected clock.",
    );
  });

  it("starts a new TTL window after each failed retry", async () => {
    let clock = 0;
    const { client, calls } = fakeClient(() => {
      throw new Error("down");
    });
    const detector = createReleaseDetector(client, {
      failureTtlMs: 1000,
      now: () => clock,
    });
    await detector.detect(); // t=0
    clock = 1500;
    await detector.detect(); // retry at 1500
    clock = 2400; // 900 ms after the retry: still inside the new window
    await detector.detect();
    const insideCalls = calls.length;
    clock = 2600; // 1100 ms after the retry
    await detector.detect();
    eq(
      [insideCalls, calls.length],
      [2, 3],
      "detect() windows after repeated failures",
      "H2: each failure is cached from the time it happened",
      "Measure the TTL from the most recent failure.",
    );
  });

  it("negatively caches an unknown result caused by an invalid version too", async () => {
    let clock = 0;
    let attempt = 0;
    const { client, calls } = fakeClient(() => {
      attempt += 1;
      return attempt === 1 ? { info: {} } : doc("2026.21.0");
    });
    const detector = createReleaseDetector(client, {
      failureTtlMs: 1000,
      now: () => clock,
    });
    const first = await detector.detect();
    clock = 500;
    const within = await detector.detect();
    clock = 1500;
    const after = await detector.detect();
    eq(
      [first.source, within, calls.length, after.source],
      ["unknown", first, 2, "openapi"],
      "detect() with invalid version, then valid version after the TTL",
      "H2: every unknown result is negatively cached",
      "Treat invalid versions like failures for caching.",
    );
  });

  it("applies a failure TTL with the real clock by default (immediate second call does not refetch)", async () => {
    const { client, calls } = fakeClient(() => {
      throw new Error("down");
    });
    const detector = createReleaseDetector(client);
    await detector.detect();
    await detector.detect();
    eq(
      calls.length,
      1,
      "two immediate detect() calls after a failure (no options)",
      "H2: default failureTtlMs is 30000",
      "Do not hammer the API after a failure.",
    );
  });

  it("shares a failing in-flight request, then negatively caches it until the TTL passes", async () => {
    let clock = 0;
    const gate = deferred<unknown>();
    let attempt = 0;
    const { client, calls } = fakeClient(() => {
      attempt += 1;
      return attempt === 1 ? gate.promise : doc("2026.21.0");
    });
    const detector = createReleaseDetector(client, {
      failureTtlMs: 1000,
      now: () => clock,
    });
    const concurrent = [detector.detect(), detector.detect()];
    gate.reject(new Error("fail"));
    const failed = await Promise.all(concurrent);
    clock = 10;
    const within = await detector.detect();
    clock = 1500;
    const retried = await detector.detect();
    eq(
      [failed.map((r) => r.source), within, calls.length, retried.source],
      [["unknown", "unknown"], failed[0], 2, "openapi"],
      "concurrent failure, then call inside and after the TTL",
      "C-memo/H2: in-flight sharing, then negative caching, then retry",
      "Share the failing request, hold the failure for the TTL, then retry once.",
    );
  });

  it("uses a fixed, key-free error text regardless of what the client threw", async () => {
    const texts: Array<string | undefined> = [];
    for (const thrown of [
      new Error("alpha X-API-Key: secret-xyz"),
      new Error("beta"),
      "gamma",
    ]) {
      const { client } = fakeClient(() => {
        throw thrown;
      });
      texts.push((await createReleaseDetector(client).detect()).error);
    }
    ok(
      texts.every(
        (t) =>
          typeof t === "string" &&
          t.length > 0 &&
          t === texts[0] &&
          !t.includes("secret-xyz"),
      ),
      "detect() error text for three different failures",
      "H3: error text is fixed and key-free",
      "the same non-empty safe string each time",
      JSON.stringify(texts),
      "Never derive the error text from the thrown message.",
    );
  });

  it("keeps caches independent per detector", async () => {
    const a = fakeClient(() => doc("2026.21.0"));
    const b = fakeClient(() => doc("2027.2.0"));
    const da = createReleaseDetector(a.client);
    const db = createReleaseDetector(b.client);
    const ra = await da.detect();
    const rb = await db.detect();
    eq(
      [ra.release?.raw, rb.release?.raw, a.calls.length, b.calls.length],
      ["2026.21.0", "2027.2.0", 1, 1],
      "two detectors on two clients",
      "C-memo: the cache lives per detector",
      "Do not share cached results across detectors.",
    );
    expect(ra).not.toEqual(rb);
  });
});
