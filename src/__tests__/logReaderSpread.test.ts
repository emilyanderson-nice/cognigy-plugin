/**
 * C3: the window-path summary spreads pages 2 and 3 across the matching
 * entries (newest, middle, oldest) when the total is known and above 300.
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
  TAIL_URL,
  Mock,
  item,
  page,
  upstreamError,
  queue,
  expectExact,
  paramsOf,
  sortedKeys,
  opts,
} from "./helpers/logFixtures.js";

const BASE = {
  startDate: DEFAULT_START,
  endDate: DEFAULT_END,
  limit: 100,
  sort: "timestamp:desc",
};
const WHY =
  "C3: with a known total above 300, pages 2 and 3 use skip floor((total-100)/2) and total-100; otherwise paging is consecutive (100, 200)";
const FIX =
  "compute page offsets from page 1's numeric total when it exceeds SUMMARY_PAGE_SIZE * SUMMARY_MAX_PAGES; keep consecutive offsets for total <= 300 or unknown; page 1 never sends skip";

describe("readLogs summary spread sampling (C3)", () => {
  let client: Mock;

  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = (args: Record<string, unknown> = {}, o: any = opts) =>
    readLogs({ get: client } as any, { projectId: PROJECT, ...args } as any, o);

  /** The skip value of each request, `undefined` when the key is absent. */
  const skips = () =>
    client.mock.calls.map((_c, i) => paramsOf(client, i).skip as unknown);

  const fullPages = (total: unknown, skipList: number[]) =>
    skipList.map((s) => ({
      items: page(100, 0, s).items,
      ...(total === undefined ? {} : { total }),
    }));

  describe("request sequences", () => {
    it.each([
      [31073, [undefined, 15486, 30973]],
      [301, [undefined, 100, 201]],
      [400, [undefined, 150, 300]],
      [1000, [undefined, 450, 900]],
      [500, [undefined, 200, 400]],
    ] as Array<[number, Array<number | undefined>]>)(
      "total %p: skips are %p",
      async (total, expected) => {
        queue(client, fullPages(total, [0, 100, 200]));
        await run();
        expectExact(skips(), expected, {
          what: `summary request skips for total ${total}`,
          why: WHY,
          fix: FIX,
        });
      },
    );

    it.each([
      [300, "total 300 (equal to the cap)"],
      [250, "total 250"],
      [null, "total null"],
      [-1, "total -1"],
      [undefined, "total missing"],
    ] as Array<[number | null | undefined, string]>)(
      "%p: consecutive paging, skips none, 100, 200 (%s)",
      async (total, label) => {
        queue(client, fullPages(total, [0, 100, 200]));
        await run();
        expectExact(skips(), [undefined, 100, 200], {
          what: `summary request skips for ${label}`,
          why: WHY,
          fix: FIX,
        });
      },
    );

    it("total 300 stops after three consecutive pages, complete and not truncated", async () => {
      queue(client, fullPages(300, [0, 100, 200]));
      const r = await run();
      expectExact(
        [client.mock.calls.length, r.body.sampled, r.body.truncated],
        [3, 300, false],
        { what: "total 300 summary", why: WHY, fix: FIX },
      );
    });

    it("total 250 stops after a short third page, consecutive, not truncated", async () => {
      queue(client, [page(100, 250), page(100, 250, 100), page(50, 250, 200)]);
      const r = await run();
      expectExact(
        [skips(), r.body.sampled, r.body.truncated],
        [[undefined, 100, 200], 250, false],
        { what: "total 250 summary", why: WHY, fix: FIX },
      );
    });

    it("every spread request keeps the URL, limit 100, sort, dates and filters", async () => {
      queue(client, fullPages(31073, [0, 15486, 30973]));
      await run({ logLevel: ["error"], search: "x", flowName: "F" });
      const extra = { type: ["error"], filter: "x", flowName: "F" };
      expectExact(
        [
          client.mock.calls.map((c) => c[0]),
          paramsOf(client, 0),
          paramsOf(client, 1),
          paramsOf(client, 2),
        ],
        [
          [LOGS_URL, LOGS_URL, LOGS_URL],
          { ...BASE, ...extra },
          { ...BASE, ...extra, skip: 15486 },
          { ...BASE, ...extra, skip: 30973 },
        ],
        { what: "spread request params", why: WHY, fix: FIX },
      );
    });
  });

  describe("unchanged behavior", () => {
    it("the entries view makes one call and never spreads", async () => {
      queue(client, [page(25, 31073)]);
      await run({ view: "entries" });
      expectExact([client.mock.calls.length, skips()], [1, [undefined]], {
        what: "entries view with total 31073",
        why: WHY,
        fix: FIX,
      });
    });

    it("the session path makes one tail call with only sessionId", async () => {
      queue(client, [{ items: [item(1)], total: 31073 }]);
      await run({ sessionId: "s1" });
      expectExact(
        [
          client.mock.calls.length,
          client.mock.calls[0][0],
          paramsOf(client, 0),
        ],
        [1, TAIL_URL, { sessionId: "s1" }],
        { what: "session path", why: WHY, fix: FIX },
      );
    });

    it("the deadline stops a spread summary after page 2 (elapsed equals the deadline)", async () => {
      let t = NOW;
      queue(client, fullPages(1000, [0, 450, 900]), () => {
        t += 5_000;
      });
      const r = await run({}, { now: () => t, deadlineMs: 10_000 });
      expectExact(
        [skips(), r.body.sampled, r.body.truncated],
        [[undefined, 450], 200, true],
        { what: "deadline with spread paging", why: WHY, fix: FIX },
      );
    });

    it("a failed page 3 returns pages 1 and 2 as a truncated partial result", async () => {
      queue(client, [
        page(100, 1000),
        page(100, 1000, 450),
        upstreamError(500),
      ]);
      const r = await run();
      expectExact(
        [
          skips(),
          r.body.error,
          r.body.sampled,
          r.body.truncated,
          typeof r.hint?.warning,
        ],
        [[undefined, 450, 900], undefined, 200, true, "string"],
        { what: "failed spread page 3", why: WHY, fix: FIX },
      );
    });

    it("a failed page 2 returns page 1 as a truncated partial result with one later request only", async () => {
      queue(client, [page(100, 1000), upstreamError(429)]);
      const r = await run();
      expectExact(
        [skips(), r.body.error, r.body.sampled, r.body.truncated],
        [[undefined, 450], undefined, 100, true],
        { what: "failed spread page 2", why: WHY, fix: FIX },
      );
    });

    it("truncated stays true and total comes from page 1 only", async () => {
      queue(client, [
        page(100, 31073),
        page(100, 5, 15486),
        page(100, 7, 30973),
      ]);
      const r = await run();
      expectExact(
        [r.body.total, r.body.sampled, r.body.truncated],
        [31073, 300, true],
        { what: "spread summary totals", why: WHY, fix: FIX },
      );
    });

    it("the body keeps exactly the documented summary keys", async () => {
      queue(client, fullPages(31073, [0, 15486, 30973]));
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
    });

    it("span covers the entries of all three slices (newest of slice 1, oldest of slice 3)", async () => {
      queue(client, fullPages(31073, [0, 15486, 30973]));
      const r = await run();
      // item(i) is stamped NOW - i seconds; slice 1 holds 0..99, slice 3 holds 30973..31072
      expectExact(
        r.body.span,
        {
          from: new Date(NOW - 31072 * 1000).toISOString(),
          to: new Date(NOW).toISOString(),
        },
        {
          what: "span of a spread summary",
          why: "C3: span is computed over every sampled entry, so it reaches from the oldest slice to the newest",
          fix: "feed the entries of all pages to summarizeEntries",
        },
      );
    });
  });

  describe("C3 refinement: offsets and when the spread wording applies", () => {
    const SPREAD_PHRASE = "newest, middle and oldest";
    const refSpec = (what: string) => ({
      what,
      why: "C3: spread wording only when pages 2 and 3 were both requested with spread offsets, both returned at least one item and nothing failed; offsets use Math.floor(total) first",
      fix: "gate the spread warning on both later pages being read non-empty; otherwise use the consecutive-style sample warning (no 'spread', no 'newest, middle and oldest'); floor the total before computing offsets",
    });
    const noSpread = (w: string) =>
      !w.includes(SPREAD_PHRASE) && !/spread/i.test(w);
    const empty = (total: number) => ({ items: [], total });

    it.each([
      [302, [undefined, 101, 202]],
      [399, [undefined, 149, 299]],
      [1000.5, [undefined, 450, 900]],
    ] as Array<[number, Array<number | undefined>]>)(
      "total %p: skips are %p",
      async (total, expected) => {
        queue(client, fullPages(total, [0, 100, 200]));
        await run();
        expectExact(skips(), expected, refSpec(`skips for total ${total}`));
      },
    );

    it("an empty page 2 stops the sample: skips none, 450, sampled 100, old warning wording", async () => {
      queue(client, [page(100, 1000), empty(1000)]);
      const r = await run();
      expectExact(
        [skips(), r.body.sampled, noSpread(String(r.hint?.warning))],
        [[undefined, 450], 100, true],
        refSpec("page 2 returned 0 items"),
      );
    });

    it("a short page 2 ends paging (page 3 never requested): sampled 140, old warning wording", async () => {
      queue(client, [page(100, 1000), page(40, 1000, 450)]);
      const r = await run();
      const w = String(r.hint?.warning);
      expectExact(
        [skips(), r.body.sampled, /sample/i.test(w), noSpread(w)],
        [[undefined, 450], 140, true, true],
        refSpec("page 2 returned 40 items"),
      );
    });

    it("positive control: a short but non-empty page 3 after two full pages keeps the spread wording", async () => {
      queue(client, [
        page(100, 1000),
        page(100, 1000, 450),
        page(40, 1000, 900),
      ]);
      const r = await run();
      const w = String(r.hint?.warning);
      expectExact(
        [
          skips(),
          r.body.sampled,
          w.includes("SAMPLE"),
          w.includes(SPREAD_PHRASE),
          w.includes("counts describe the sample only"),
        ],
        [[undefined, 450, 900], 240, true, true, true],
        refSpec("page 3 returned 40 items"),
      );
    });

    it("an empty page 3 uses the old warning wording without the spread phrases", async () => {
      queue(client, [page(100, 1000), page(100, 1000, 450), empty(1000)]);
      const r = await run();
      const w = String(r.hint?.warning);
      expectExact(
        [skips(), r.body.sampled, /sample/i.test(w), noSpread(w)],
        [[undefined, 450, 900], 200, true, true],
        refSpec("page 3 returned 0 items"),
      );
    });
  });

  describe("warning wording", () => {
    const spreadWarning = async () => {
      queue(client, fullPages(31073, [0, 15486, 30973]));
      return String((await run()).hint?.warning);
    };

    it("a spread sample names SAMPLE, newest/middle/oldest and that counts describe the sample only", async () => {
      const w = await spreadWarning();
      expectExact(
        [
          w.includes("SAMPLE"),
          w.includes("newest, middle and oldest"),
          w.includes("counts describe the sample only"),
        ],
        [true, true, true],
        {
          what: "spread sample warning phrases",
          why: "C3: the warning must say the sample is spread and that counts describe only the sample",
          fix: "use a spread-specific warning containing the three exact phrases when pages were spread",
        },
      );
    });

    it("a spread sample warning still gives the sample size and the total", async () => {
      const w = await spreadWarning();
      expectExact([/\b300\b/.test(w), /31,?073/.test(w)], [true, true], {
        what: "spread warning numbers",
        why: "C3: the warning keeps stating how many entries were sampled and out of how many",
        fix: "include sampled count and total in the spread warning",
      });
    });

    it.each([
      [
        "unknown total, cap reached",
        () => queue(client, fullPages(undefined, [0, 100, 200])),
      ],
      [
        "total 250, deadline after page 1",
        () => queue(client, [page(100, 250), page(100, 250, 100)]),
      ],
    ] as Array<[string, () => void]>)(
      "%s: consecutive paging keeps the old warning, without the spread phrases",
      async (_label, setup) => {
        setup();
        let t = NOW;
        const slow = _label.includes("deadline");
        const r = await run(
          {},
          slow
            ? {
                now: () => (t += 20_000),
                deadlineMs: 10_000,
              }
            : opts,
        );
        const w = String(r.hint?.warning);
        expectExact(
          [
            r.body.truncated,
            /sample/i.test(w),
            w.includes("newest, middle and oldest"),
            w.includes("counts describe the sample only"),
          ],
          [true, true, false, false],
          {
            what: `${_label}: warning`,
            why: "C3: only a spread sample uses the spread wording; consecutive paging keeps today's wording (which names a sample)",
            fix: "choose the spread warning only when pages 2 and 3 used spread offsets",
          },
        );
      },
    );
  });
});
