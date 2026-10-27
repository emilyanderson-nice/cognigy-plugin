/**
 * M1: msgChars sets the per-message cap of the log reader's entries view
 * (default 500, range 100..4000). The client is a mock; nothing here touches a
 * real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import { scrubText } from "../tools/logScrub.js";
import { listResourcesSchema } from "../schemas/tools.js";
import {
  ALL_SENTINELS,
  DEFAULT_END,
  DEFAULT_START,
  PROJECT,
  Mock,
  hostileItem,
  item,
  paramsOf,
  queue,
  expectExact,
  opts,
} from "./helpers/logFixtures.js";

/** Text with no maskable content, exactly n characters, no edge whitespace. */
const words = (n: number) =>
  `${"abcd ".repeat(Math.ceil(n / 5))}`.slice(0, n - 1) + "e";
const cutTo = (s: string, n: number) => `${s.slice(0, n - 1)}…`;
const spec = (what: string, why: string, fix: string) => ({ what, why, fix });
const WHY_CAP =
  "M1: in the entries view the per-message cap is msgChars (default 500); a truncated text is exactly msgChars characters and ends with the single character …";
const FIX_CAP =
  "pass args.msgChars (default 500) as the cap of toLogEntry/scrubText for the entries view; keep the slice(0, cap - 1) + '…' rule";

describe("readLogs msgChars (M1)", () => {
  let client: Mock;

  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = (args: Record<string, unknown> = {}) =>
    readLogs(
      { get: client } as any,
      { projectId: PROJECT, view: "entries", ...args } as any,
      opts,
    );
  const msgOf = (r: any, i = 0) => (r.body.entries as any[])[i].msg as string;
  const one = (msg: string) => ({ items: [item(1, { msg })], total: 1 });

  describe("default behavior is byte-identical", () => {
    it("a 600-character message is cut at 500 with a single ellipsis when msgChars is omitted", async () => {
      const m = words(600);
      queue(client, [one(m)]);
      const r = await run();
      expectExact(
        [msgOf(r).length, msgOf(r)],
        [500, cutTo(m, 500)],
        spec("default cap", WHY_CAP, FIX_CAP),
      );
    });

    it("omitting msgChars gives exactly the same result as msgChars 500", async () => {
      const m = words(600);
      queue(client, [one(m)]);
      const a = await run();
      client = jest.fn() as Mock;
      queue(client, [one(m)]);
      const b = await run({ msgChars: 500 });
      expectExact(
        JSON.stringify(b),
        JSON.stringify(a),
        spec("500 equals default", WHY_CAP, FIX_CAP),
      );
    });

    it("msgChars is not sent upstream (window path params are exactly as before)", async () => {
      queue(client, [one("hi")]);
      await run({ msgChars: 1000 });
      expectExact(
        paramsOf(client, 0),
        {
          startDate: DEFAULT_START,
          endDate: DEFAULT_END,
          limit: 25,
          sort: "timestamp:desc",
        },
        spec(
          "window params",
          "M1: msgChars is local only",
          "do not forward it",
        ),
      );
    });
  });

  describe("cap lengths and the ellipsis rule", () => {
    it.each([
      [100, 600],
      [1000, 1200],
      [3000, 3500],
      [4000, 4500],
    ])(
      "msgChars %p cuts a %p-character message to exactly that many characters",
      async (cap, len) => {
        const m = words(len);
        queue(client, [one(m)]);
        const r = await run({ msgChars: cap });
        expectExact(
          [msgOf(r).length, msgOf(r).endsWith("…"), msgOf(r)],
          [cap, true, cutTo(m, cap)],
          spec(`msgChars ${cap}`, WHY_CAP, FIX_CAP),
        );
      },
    );

    it.each([
      [100, 100],
      [100, 99],
      [1000, 1000],
      [4000, 4000],
      [500, 500],
    ])(
      "msgChars %p leaves a %p-character message untouched",
      async (cap, len) => {
        const m = words(len);
        queue(client, [one(m)]);
        const r = await run({ msgChars: cap });
        expectExact(
          msgOf(r),
          m,
          spec(`msgChars ${cap}, message of ${len}`, WHY_CAP, FIX_CAP),
        );
      },
    );

    it("applies to every entry on the session path with view entries", async () => {
      const a = words(1500);
      const b = words(40);
      queue(client, [
        {
          items: [item(1, { msg: a }), item(2, { msg: b })],
          total: -1,
        },
      ]);
      const r = await run({ sessionId: "s1", msgChars: 1000 });
      expectExact(
        [msgOf(r, 0), msgOf(r, 1), paramsOf(client, 0)],
        [cutTo(a, 1000), b, { sessionId: "s1" }],
        spec("session path msgChars", WHY_CAP, FIX_CAP),
      );
    });
  });

  describe("summary view ignores msgChars", () => {
    it("summary output is identical with and without it", async () => {
      const m = words(1500);
      const pages = () => [
        { items: [item(1, { msg: m }), item(2, { msg: m })], total: 2 },
      ];
      queue(client, pages());
      const a = await run({ view: "summary" });
      client = jest.fn() as Mock;
      queue(client, pages());
      const b = await run({ view: "summary", msgChars: 4000 });
      expectExact(
        JSON.stringify(b),
        JSON.stringify(a),
        spec(
          "summary with msgChars",
          "M1: msgChars is ignored by the summary view like limit/skip",
          "do not read args.msgChars on the summary path",
        ),
      );
    });
  });

  describe("scrubbing happens before truncation", () => {
    const token = "Z".repeat(50);
    const email = "john.doe@example.com";

    it.each([
      [1000, 490],
      [4000, 1990],
    ])(
      "a 50-character token straddling the msgChars %p boundary is masked, not cut",
      async (cap, pairs) => {
        queue(client, [one(`${"a ".repeat(pairs)}${token}`)]);
        const r = await run({ msgChars: cap });
        expectExact(
          msgOf(r),
          `${"a ".repeat(pairs)}<token>`,
          spec(
            `token at cap ${cap}`,
            "M1: the token is masked before truncation, so a token straddling the cap never leaks a partial run",
            "keep the pre-regex input cut above msgChars (a margin beyond the cap) so a straddling token is still seen whole",
          ),
        );
      },
    );

    it.each([
      [1000, 495],
      [4000, 1995],
    ])(
      "an email straddling the msgChars %p boundary is masked, not cut",
      async (cap, pairs) => {
        queue(client, [one(`${"a ".repeat(pairs)}${email}`)]);
        const r = await run({ msgChars: cap });
        expectExact(
          msgOf(r),
          `${"a ".repeat(pairs)}<email>`,
          spec(
            `email at cap ${cap}`,
            "M1: the email is masked before truncation",
            "keep the pre-regex input cut above msgChars",
          ),
        );
      },
    );

    it("personal-data sentinels stay out of entries at msgChars 4000 (window and session)", async () => {
      queue(client, [{ items: [hostileItem(1), hostileItem(2)], total: 2 }]);
      const w = await run({ msgChars: 4000 });
      client = jest.fn() as Mock;
      queue(client, [{ items: [hostileItem(1, "v2")], total: -1 }]);
      const s = await run({ sessionId: "s1", msgChars: 4000 });
      const json = JSON.stringify([w, s]);
      expectExact(
        ALL_SENTINELS.filter((x) => json.includes(x)),
        [],
        spec(
          "sentinel leak",
          "M1: msgChars only widens the message cap; meta.text, meta.URLToken and other meta stay out",
          "do not change the entry allowlist",
        ),
      );
    });
  });

  describe("schema", () => {
    const parse = (v: unknown) =>
      listResourcesSchema.safeParse({
        resourceType: "log",
        projectId: PROJECT,
        msgChars: v,
      }).success;

    it.each([100, 500, 1000, 4000])("accepts %p", (v) => {
      expect(parse(v)).toBe(true);
    });

    it.each([99, 4001, 1.5, "500", NaN, 0, -100])("rejects %p", (v) => {
      expect(parse(v)).toBe(false);
    });

    it("msgChars stays optional", () => {
      expect(
        listResourcesSchema.safeParse({
          resourceType: "log",
          projectId: PROJECT,
        }).success,
      ).toBe(true);
    });
  });

  // The bound catches catastrophic (quadratic or worse) backtracking, which costs seconds at this size.
  // It is deliberately loose: the same cases take about 30 ms here but measured 154.6 ms on a shared CI runner.
  describe("hostile 4000-character inputs scrub quickly", () => {
    const shapes: Array<[string, string]> = [
      ["a run of letters", "a".repeat(4000)],
      ["a- repeated", "a-".repeat(2000)],
      ["a. repeated", "a.".repeat(2000)],
      ["a@ repeated", "a@".repeat(2000)],
    ];
    const median = (fn: () => unknown) => {
      const times: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now();
        fn();
        times.push(performance.now() - t0);
      }
      return times.sort((x, y) => x - y)[3];
    };

    it.each(shapes)("scrubText: %s, median under 500 ms", (label, text) => {
      const ms = median(() => scrubText(text, 4000));
      expectExact(
        ms < 500,
        true,
        spec(
          `scrubText ${label}`,
          "M1: hostile 4000-character inputs must scrub in under 500 ms median (no catastrophic backtracking)",
          `tighten the regexes so ${label} is linear; measured median ${ms.toFixed(1)} ms`,
        ),
      );
    });

    it.each(shapes)(
      "entries path (toLogEntry via readLogs, msgChars 4000): %s, median under 500 ms",
      async (label, text) => {
        const times: number[] = [];
        for (let i = 0; i < 7; i++) {
          const c = jest.fn() as Mock;
          queue(c, [one(text)]);
          const t0 = performance.now();
          await readLogs(
            { get: c } as any,
            {
              projectId: PROJECT,
              view: "entries",
              msgChars: 4000,
            } as any,
            opts,
          );
          times.push(performance.now() - t0);
        }
        const ms = times.sort((x, y) => x - y)[3];
        expectExact(
          ms < 500,
          true,
          spec(
            `entries path ${label}`,
            "M1: the entries path must also stay under 500 ms median",
            `tighten the regexes; measured median ${ms.toFixed(1)} ms`,
          ),
        );
      },
    );
  });
});
