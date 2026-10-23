/**
 * Tests for the log reader orchestrator (readLogs): window.
 * The client is a mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  NOW,
  DEFAULT_END,
  DEFAULT_START,
  PROJECT,
  LOGS_URL,
  Mock,
  item,
  items,
  page,
  upstreamError,
  queue,
  expectExact,
  paramsOf,
  sortedKeys,
  opts,
} from "./helpers/logFixtures.js";

describe("readLogs", () => {
  let client: Mock;

  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = (args: Record<string, unknown> = {}, o: any = opts) =>
    readLogs({ get: client } as any, { projectId: PROJECT, ...args } as any, o);

  describe("window path, summary view", () => {
    it("sends exactly the default params on page 1: no skip/type/filter/flowName", async () => {
      queue(client, [page(5, 5)]);
      await run();
      expect(client).toHaveBeenCalledTimes(1);
      expect(client.mock.calls[0][0]).toBe(LOGS_URL);
      expect(paramsOf(client, 0)).toEqual({
        startDate: DEFAULT_START,
        endDate: DEFAULT_END,
        limit: 100,
        sort: "timestamp:desc",
      });
      expect(sortedKeys(paramsOf(client, 0))).toEqual([
        "endDate",
        "limit",
        "sort",
        "startDate",
      ]);
    });

    it("maps logLevel to type, search to filter, flowName, and honours a custom sort", async () => {
      queue(client, [page(1, 1)]);
      await run({
        logLevel: ["error", "warn"],
        search: "timeout",
        flowName: "Main",
        sort: "timestamp:asc",
      });
      expect(paramsOf(client, 0)).toEqual({
        startDate: DEFAULT_START,
        endDate: DEFAULT_END,
        limit: 100,
        sort: "timestamp:asc",
        type: ["error", "warn"],
        filter: "timeout",
        flowName: "Main",
      });
    });

    it("passes explicit valid dates through unchanged and reports them as the window", async () => {
      queue(client, [page(1, 1)]);
      const startDate = "2026-10-23T10:00:00.000Z";
      const endDate = "2026-10-23T11:00:00.000Z";
      const r = await run({ startDate, endDate });
      expect(paramsOf(client, 0).startDate).toBe(startDate);
      expect(paramsOf(client, 0).endDate).toBe(endDate);
      expect(r.body.window).toEqual({ from: startDate, to: endDate });
    });

    it("reports the default window in the body", async () => {
      queue(client, [page(1, 1)]);
      const r = await run();
      expect(r.body.window).toEqual({ from: DEFAULT_START, to: DEFAULT_END });
    });

    it("a short first page with a larger total is truncated: one call, sample warning, narrowing hint (amendment A1)", async () => {
      queue(client, [page(40, 1000)]);
      const r = await run();
      expectExact(
        [
          client.mock.calls.length,
          r.body.sampled,
          r.body.total,
          r.body.truncated,
          typeof r.body.error === "string",
          /sample/i.test(r.hint?.warning ?? ""),
          /search/.test(r.hint?.action ?? ""),
        ],
        [1, 40, 1000, true, false, true, true],
        {
          what: "page(40 items, total 1000) summary",
          why: "A1: truncated = pagesSkippedOrFailed || (total !== null && total > entries.length); 40 of 1000 is a sample",
          fix: "pass truncated: skipped || (total !== null && total > entries.length) to summarizeEntries and build the sample warning from it",
        },
      );
    });

    it("a short first page whose total equals the sampled count is complete: truncated false, no warning (amendment A1)", async () => {
      queue(client, [page(40, 40)]);
      const r = await run();
      expectExact(
        [
          client.mock.calls.length,
          r.body.sampled,
          r.body.truncated,
          r.hint?.warning,
        ],
        [1, 40, false, undefined],
        {
          what: "page(40 items, total 40) summary",
          why: "A1: total == sampled means nothing is missing",
          fix: "only mark truncated when total > entries.length or a page was skipped/failed",
        },
      );
    });

    it("a short first page with total null is not truncated (amendment A1)", async () => {
      queue(client, [page(40, -1)]);
      const r = await run();
      expectExact(
        [r.body.total, r.body.sampled, r.body.truncated, r.hint?.warning],
        [null, 40, false, undefined],
        {
          what: "page(40 items, total -1) summary",
          why: "A1: an unknown total cannot prove truncation when the page was short",
          fix: "treat total null as 'not larger'",
        },
      );
    });

    it("a full page with total null and the page cap reached is truncated (amendment A1)", async () => {
      queue(client, [
        page(100, undefined),
        page(100, undefined, 100),
        page(100, undefined, 200),
      ]);
      const r = await run();
      expectExact(
        [
          client.mock.calls.length,
          r.body.total,
          r.body.sampled,
          r.body.truncated,
        ],
        [3, null, 300, true],
        {
          what: "3 full pages, total unknown",
          why: "A1: more pages may exist but the cap stopped reading, so the result is a sample",
          fix: "mark truncated when the loop ended by cap while the last page was full",
        },
      );
    });

    it("a deadline stop before page 2 with total larger than gathered is truncated (amendment A1)", async () => {
      let t = NOW;
      queue(client, [page(100, 250), page(100, 250, 100)], () => {
        t += 20_000;
      });
      const r = await run({}, { now: () => t, deadlineMs: 10_000 });
      expectExact(
        [
          client.mock.calls.length,
          r.body.sampled,
          r.body.total,
          r.body.truncated,
        ],
        [1, 100, 250, true],
        {
          what: "deadline reached after page 1 of 250",
          why: "A1 + deadline rule: page 2 was skipped and total 250 > 100",
          fix: "stop at the deadline and report truncated true",
        },
      );
    });

    it("a failed page 2 with total larger than gathered is truncated with a warning (amendment A1)", async () => {
      queue(client, [page(100, 130), upstreamError(500)]);
      const r = await run();
      expectExact(
        [
          r.body.sampled,
          r.body.truncated,
          typeof r.hint?.warning,
          typeof r.body.error === "string",
        ],
        [100, true, "string", false],
        {
          what: "page 2 failure on a 130-entry window",
          why: "a failed later page counts as skipped",
          fix: "set truncated when a later page fails",
        },
      );
    });

    it("a full first page that reaches the total exactly is complete (amendment A1 boundary)", async () => {
      queue(client, [page(100, 100)]);
      const r = await run();
      expectExact(
        [client.mock.calls.length, r.body.truncated, r.hint?.warning],
        [1, false, undefined],
        {
          what: "page(100 items, total 100)",
          why: "entries gathered reach total, so nothing is missing and no second call is made",
          fix: "stop when entries.length >= total",
        },
      );
    });

    it("levels named constructor/__proto__ become own numeric keys end to end (amendment A2)", async () => {
      queue(client, [
        {
          items: [
            item(1, { type: "__proto__" }),
            item(2, { type: "constructor" }),
            item(3, { type: "constructor" }),
          ],
          total: 3,
        },
      ]);
      const r = await run();
      const levels = r.body.levels as Record<string, number>;
      expectExact(
        [
          Object.entries(levels).sort(([a], [b]) => (a < b ? -1 : 1)),
          Object.getOwnPropertyDescriptor(levels, "__proto__")?.value,
          Object.values(levels).reduce((a, b) => a + b, 0),
          r.body.sampled,
        ],
        [
          [
            ["__proto__", 1],
            ["constructor", 2],
          ],
          1,
          3,
          3,
        ],
        {
          what: "summary levels for prototype-named levels",
          why: "A2: levels is built with a Map and Object.fromEntries; sampled equals the sum of the values",
          fix: "do not tally into a plain object literal",
        },
      );
    });

    it("stops when gathered entries reach total on a full page, truncated false", async () => {
      queue(client, [page(100, 200), page(100, 200, 100)]);
      const r = await run();
      expect(client).toHaveBeenCalledTimes(2);
      expect(r.body.sampled).toBe(200);
      expect(r.body.total).toBe(200);
      expect(r.body.truncated).toBe(false);
    });

    it("stops after a short second page, exactly 2 calls", async () => {
      queue(client, [page(100, 150), page(50, 150, 100)]);
      const r = await run();
      expect(client).toHaveBeenCalledTimes(2);
      expect(r.body.sampled).toBe(150);
      expect(r.body.truncated).toBe(false);
    });

    it("advances skip by 100 for pages 2 and 3 and sends no skip on page 1", async () => {
      queue(client, [
        page(100, 1000),
        page(100, 1000, 100),
        page(100, 1000, 200),
      ]);
      await run();
      expect(client).toHaveBeenCalledTimes(3);
      const base = {
        startDate: DEFAULT_START,
        endDate: DEFAULT_END,
        limit: 100,
        sort: "timestamp:desc",
      };
      expect(paramsOf(client, 0)).toEqual(base);
      expect(sortedKeys(paramsOf(client, 0))).not.toContain("skip");
      expect(paramsOf(client, 1)).toEqual({ ...base, skip: 100 });
      expect(paramsOf(client, 2)).toEqual({ ...base, skip: 200 });
      for (const c of client.mock.calls) expect(c[0]).toBe(LOGS_URL);
    });

    it("caps at 3 pages even when more are available and marks truncated true", async () => {
      queue(client, [
        page(100, 1000),
        page(100, 1000, 100),
        page(100, 1000, 200),
        page(100, 1000, 300),
      ]);
      const r = await run();
      expect(client).toHaveBeenCalledTimes(3);
      expect(r.body.sampled).toBe(300);
      expect(r.body.total).toBe(1000);
      expect(r.body.truncated).toBe(true);
    });

    it("takes total from page 1 only", async () => {
      queue(client, [page(100, 500), page(100, 5, 100), page(10, 7, 200)]);
      const r = await run();
      expect(r.body.total).toBe(500);
    });

    it("total is null when the first page total is -1 or absent", async () => {
      queue(client, [page(3, -1)]);
      const a = await run();
      expect(a.body.total).toBeNull();

      client = jest.fn() as Mock;
      queue(client, [page(3, undefined)]);
      const b = await run();
      expect(b.body.total).toBeNull();
    });

    it("stops at the deadline using the injected clock and marks truncated true", async () => {
      let t = NOW;
      queue(
        client,
        [page(100, 1000), page(100, 1000, 100), page(100, 1000, 200)],
        () => {
          t += 6_000;
        },
      );
      const r = await run({}, { now: () => t, deadlineMs: 10_000 });
      // after call 1 elapsed 6000 < 10000 -> page 2; after call 2 elapsed 12000 >= 10000 -> stop
      expect(client).toHaveBeenCalledTimes(2);
      expect(r.body.sampled).toBe(200);
      expect(r.body.truncated).toBe(true);
    });

    it("always performs page 1 even with a zero deadline, then stops", async () => {
      let t = NOW;
      queue(client, [page(100, 1000), page(100, 1000, 100)], () => {
        t += 1;
      });
      const r = await run({}, { now: () => t, deadlineMs: 0 });
      expect(client).toHaveBeenCalledTimes(1);
      expect(r.body.sampled).toBe(100);
      expect(r.body.truncated).toBe(true);
    });

    it("continues to the next page while elapsed stays below the deadline", async () => {
      let t = NOW;
      queue(
        client,
        [page(100, 1000), page(100, 1000, 100), page(100, 1000, 200)],
        () => {
          t += 4_000;
        },
      );
      // elapsed after call 1 = 4000, after call 2 = 8000: both < 10000, so page 3 is read
      const r = await run({}, { now: () => t, deadlineMs: 10_000 });
      expectExact([client.mock.calls.length, r.body.sampled], [3, 300], {
        what: "deadline 10000 ms with 4000 ms per call",
        why: "the deadline check stops only when now() - start >= deadlineMs; 4000 and 8000 are below it",
        fix: "check elapsed >= deadlineMs before each further page",
      });
    });

    it("stops when elapsed equals the deadline exactly (boundary is >=)", async () => {
      let t = NOW;
      queue(
        client,
        [page(100, 1000), page(100, 1000, 100), page(100, 1000, 200)],
        () => {
          t += 5_000;
        },
      );
      // elapsed after call 1 = 5000 (< 10000, continue), after call 2 = 10000 (== deadline, stop)
      const r = await run({}, { now: () => t, deadlineMs: 10_000 });
      expectExact(
        [client.mock.calls.length, r.body.sampled, r.body.truncated],
        [2, 200, true],
        {
          what: "deadline 10000 ms with 5000 ms per call",
          why: "elapsed == deadlineMs must stop (>=, not >)",
          fix: "compare with >= deadlineMs",
        },
      );
    });

    it("builds the body only from allowed keys (no upstream spreading)", async () => {
      queue(client, [page(5, 5)]);
      const r = await run();
      expect(sortedKeys(r.body)).toEqual(
        [
          "view",
          "window",
          "total",
          "sampled",
          "levels",
          "span",
          "topMessages",
          "flows",
          "truncated",
        ].sort(),
      );
      expect(r.body.view).toBe("summary");
      expect(JSON.stringify(r)).not.toContain("SHOULD_NOT_APPEAR_IN_OUTPUT");
    });

    it("summarises both entry shapes end to end (v1 top-level type, v2 metadata.type)", async () => {
      const v1 = item(1, { type: "error" });
      const v2 = {
        ...item(2),
        type: undefined,
        metadata: { type: "warn", projectId: PROJECT },
      };
      delete (v2 as any).type;
      queue(client, [
        { items: [v1, v2, item(3, { type: "error" })], total: 3 },
      ]);
      const r = await run();
      expect(r.body.levels).toEqual({ error: 2, warn: 1 });
      expect(r.body.sampled).toBe(3);
    });
  });
});
