/**
 * B4: the log reader hint states which time window was used and how to look
 * further back. The client is a mock; nothing here touches a real Cognigy
 * environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  DEFAULT_END,
  DEFAULT_START,
  PROJECT,
  Mock,
  item,
  page,
  queue,
  paramsOf,
  opts,
  expectExact,
} from "./helpers/logFixtures.js";

const DEFAULT_SENTENCE =
  "Showing the last hour by default; pass startDate (log retention is typically about 24 hours) to look further back.";
const END_ONLY_SENTENCE =
  "Showing the hour before endDate by default; pass startDate (log retention is typically about 24 hours) to look further back.";
const BANNED = [
  "kept about",
  "only returned when asked",
  "lags a few seconds",
  "retained about",
];
const START = "2026-10-23T10:00:00.000Z";
const END = "2026-10-23T11:00:00.000Z";

const spec = (what: string, why: string, fix: string) => ({ what, why, fix });
const WHY_DEFAULT =
  "B4: with neither startDate nor endDate, hint.action must end its own text with the exact default-window sentence, before any paging note";
const FIX_DEFAULT =
  "append the exact sentence to hint.action after the existing action text and before the paging note when args.startDate and args.endDate are both absent (window path only)";

describe("readLogs window hint (B4)", () => {
  let client: Mock;

  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = (args: Record<string, unknown> = {}) =>
    readLogs(
      { get: client } as any,
      { projectId: PROJECT, ...args } as any,
      opts,
    );
  const action = (r: { hint?: { action?: unknown } }) => String(r.hint?.action);
  const count = (haystack: string, needle: string) =>
    haystack.split(needle).length - 1;

  type Variant = [string, Record<string, unknown>, unknown];
  const variants: Variant[] = [
    ["summary, normal", {}, page(3, 3)],
    ["summary, empty", {}, { items: [], total: 0 }],
    [
      "summary, truncated",
      {},
      [page(100, 900), page(100, 900, 100), page(100, 900, 200)],
    ],
    ["entries, normal", { view: "entries" }, page(3, 3)],
    ["entries, empty", { view: "entries" }, { items: [], total: 0 }],
    ["entries, truncated", { view: "entries" }, page(25, 500)],
  ];
  const responses = (r: unknown) => (Array.isArray(r) ? r : [r]);

  describe("(a) neither startDate nor endDate", () => {
    it.each(variants)(
      "%s: hint.action contains the default-window sentence exactly once",
      async (label, args, resp) => {
        queue(client, responses(resp));
        const r = await run(args);
        expectExact(
          count(action(r), DEFAULT_SENTENCE),
          1,
          spec(
            `${label}: occurrences of the default sentence`,
            WHY_DEFAULT,
            FIX_DEFAULT,
          ),
        );
      },
    );

    it.each(
      variants.filter(([label]) => !label.startsWith("entries, truncated")),
    )(
      "%s: hint.action ENDS with the sentence when no paging note applies",
      async (label, args, resp) => {
        queue(client, responses(resp));
        const r = await run(args);
        expectExact(
          action(r).endsWith(DEFAULT_SENTENCE),
          true,
          spec(
            `${label}: hint.action ends with the sentence`,
            WHY_DEFAULT,
            FIX_DEFAULT,
          ),
        );
      },
    );

    it("a truncated summary keeps its narrowing advice BEFORE the sentence", async () => {
      queue(client, responses(variants[2][2]));
      const a = action(await run());
      const at = a.indexOf(DEFAULT_SENTENCE);
      expectExact(
        [
          at > 0,
          a.slice(0, at).includes("sessionId"),
          a.slice(0, at).includes("search"),
        ],
        [true, true, true],
        spec(
          "truncated summary: narrowing advice precedes the sentence",
          "B4: the sentence goes after the existing action text",
          "append the sentence to the end of the existing action text, do not prepend it",
        ),
      );
    });
  });

  describe("(b) only endDate supplied", () => {
    it.each([
      ["summary", {}],
      ["entries", { view: "entries" }],
    ] as Array<[string, Record<string, unknown>]>)(
      "%s: hint.action ends with the hour-before-endDate sentence and not the default one",
      async (label, extra) => {
        queue(client, [page(3, 3)]);
        const r = await run({ ...extra, endDate: END });
        expectExact(
          [
            action(r).endsWith(END_ONLY_SENTENCE),
            action(r).includes(DEFAULT_SENTENCE),
          ],
          [true, false],
          spec(
            `${label}: end-only hint`,
            "B4: with only endDate the window is the hour before endDate, so the hint must say that, not 'last hour'",
            "use the exact end-only sentence when args.endDate is set and args.startDate is not",
          ),
        );
      },
    );
  });

  describe("(c) startDate supplied", () => {
    it.each([
      ["summary, startDate", {}, { startDate: START }],
      ["summary, both", {}, { startDate: START, endDate: END }],
      ["entries, startDate", { view: "entries" }, { startDate: START }],
      [
        "entries, both",
        { view: "entries" },
        { startDate: START, endDate: END },
      ],
    ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>)(
      "%s: neither sentence appears",
      async (label, extra, dates) => {
        queue(client, [page(3, 3)]);
        const r = await run({ ...extra, ...dates });
        expectExact(
          [
            action(r).includes(DEFAULT_SENTENCE),
            action(r).includes(END_ONLY_SENTENCE),
          ],
          [false, false],
          spec(
            `${label}: window sentences`,
            "B4: an explicit startDate means the caller chose the window, so no default-window sentence applies",
            "emit the sentences only when args.startDate is absent",
          ),
        );
        expect(action(r)).toContain("typically about 24 hours");
      },
    );
  });

  describe("(d) session path", () => {
    it.each(["summary", "entries"])(
      "%s view with sessionId: neither sentence appears",
      async (view) => {
        queue(client, [{ items: [item(1)], total: -1 }]);
        const r = await run({ sessionId: "s1", view });
        expectExact(
          [
            action(r).includes(DEFAULT_SENTENCE),
            action(r).includes(END_ONLY_SENTENCE),
          ],
          [false, false],
          spec(
            `${view} sessionId: window sentences`,
            "B4: the session path does not use a time window, so no window sentence applies",
            "never add the window sentences on the sessionId path",
          ),
        );
        expect(action(r)).toContain("typically about 24 hours");
      },
    );
  });

  describe("(e) summary with limit/skip and no dates", () => {
    it.each([
      ["limit", { limit: 50 }],
      ["skip", { skip: 10 }],
      ["limit and skip", { limit: 50, skip: 10 }],
    ] as Array<[string, Record<string, unknown>]>)(
      "supplied %s: the sentence comes first, then the paging note",
      async (label, extra) => {
        queue(client, [page(3, 3)]);
        const a = action(await run(extra));
        const at = a.indexOf(DEFAULT_SENTENCE);
        const afterSentence = a.slice(at + DEFAULT_SENTENCE.length);
        expectExact(
          [
            count(a, DEFAULT_SENTENCE),
            /\blimit\b/i.test(afterSentence),
            /\bskip\b/i.test(afterSentence),
            /\blimit\b|\bskip\b/i.test(a.slice(0, Math.max(at, 0))),
          ],
          [1, true, true, false],
          spec(
            `${label}: sentence then paging note`,
            "B4: the default-window sentence precedes the fixed paging note, which always names both limit and skip whenever either was supplied",
            "build the action as existing text, then the window sentence, then the unchanged paging note (it names both words regardless of which was supplied)",
          ),
        );
      },
    );

    it("a truncated summary with limit orders: narrowing advice, sentence, paging note", async () => {
      queue(client, responses(variants[2][2]));
      const a = action(await run({ limit: 5 }));
      const at = a.indexOf(DEFAULT_SENTENCE);
      const limitAt = a.search(/\blimit\b/i);
      expectExact(
        [at > a.indexOf("sessionId"), limitAt >= at + DEFAULT_SENTENCE.length],
        [true, true],
        spec(
          "truncated summary with limit: ordering",
          "B4: sentence after existing text, before the paging note",
          "place the sentence between the narrowing advice and the paging note",
        ),
      );
    });
  });

  describe("(f) the default window is unchanged", () => {
    it.each([
      ["summary", {}],
      ["entries", { view: "entries" }],
    ] as Array<[string, Record<string, unknown>]>)(
      "%s: request params still span now-1h to now+60s",
      async (label, extra) => {
        queue(client, [page(3, 3)]);
        await run(extra);
        const p = paramsOf(client, 0);
        expectExact(
          [p.startDate, p.endDate],
          [DEFAULT_START, DEFAULT_END],
          spec(
            `${label}: request window`,
            "B4: only the hint changes; the default window stays now-1h .. now+60s",
            "do not alter window computation",
          ),
        );
      },
    );
  });

  describe("(g) existing guarantees", () => {
    const all: Array<[string, Record<string, unknown>, unknown]> = [
      ...variants,
      ["summary, end only", { endDate: END }, page(3, 3)],
      ["summary, start only", { startDate: START }, page(3, 3)],
      ["summary, limit+skip", { limit: 5, skip: 1 }, page(3, 3)],
      ["session", { sessionId: "s1" }, { items: [item(1)], total: -1 }],
    ];

    it.each(all)(
      "%s: keeps 'typically about 24 hours'",
      async (_l, args, resp) => {
        queue(client, responses(resp));
        expect(action(await run(args))).toContain("typically about 24 hours");
      },
    );

    it.each(all)(
      "%s: no banned phrase in warning or action",
      async (label, args, resp) => {
        queue(client, responses(resp));
        const r = await run(args);
        const text = `${(r.hint as any)?.warning ?? ""} ${action(r)}`;
        expectExact(
          BANNED.filter((b) => text.includes(b)),
          [],
          spec(
            `${label}: banned phrases`,
            "B4: the earlier wording was retired; the new sentence must not reintroduce it",
            "remove the banned phrase from the hint text",
          ),
        );
      },
    );

    it("the new sentences contain neither the word limit nor skip", () => {
      for (const s of [DEFAULT_SENTENCE, END_ONLY_SENTENCE]) {
        expect([/\blimit\b/i.test(s), /\bskip\b/i.test(s)]).toEqual([
          false,
          false,
        ]);
      }
    });

    it.each([
      ["summary", {}],
      ["entries", { view: "entries" }],
    ] as Array<[string, Record<string, unknown>]>)(
      "%s with nothing supplied: no limit/skip word outside the new sentence",
      async (label, extra) => {
        queue(client, [page(3, 3)]);
        const a = action(await run(extra)).replace(DEFAULT_SENTENCE, "");
        expectExact(
          [/\blimit\b/i.test(a), /\bskip\b/i.test(a)],
          [false, false],
          spec(
            `${label}: limit/skip words`,
            "A14c: limit/skip are mentioned only when the caller supplied them",
            "keep the paging note conditional on args.limit or args.skip",
          ),
        );
      },
    );
  });
});
