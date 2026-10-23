/**
 * Tests for the log reader orchestrator (readLogs): dates.
 * The client is a mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  NOW,
  DEFAULT_END,
  PROJECT,
  SENTINEL_TEXT,
  Mock,
  page,
  queue,
  expectExact,
  paramsOf,
  opts,
} from "./helpers/logFixtures.js";

describe("readLogs", () => {
  let client: Mock;

  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = (args: Record<string, unknown> = {}, o: any = opts) =>
    readLogs({ get: client } as any, { projectId: PROJECT, ...args } as any, o);

  describe("date validation (no client call)", () => {
    it.each([
      ["invalid string", { startDate: "not-a-date" }],
      ["bare word endDate", { endDate: "yesterday" }],
      ["date without T", { startDate: "2026-10-23" }],
      [
        "impossible date matching the pattern",
        { startDate: "2026-13-45T00:00:00Z" },
      ],
      ["invalid endDate pattern-match", { endDate: "2026-02-31T99:99:99Z" }],
    ])("%s returns an ISO 8601 error", async (_n, args) => {
      const r = await run(args);
      expect(typeof r.body.error).toBe("string");
      expect(String(r.body.error)).toMatch(/ISO 8601/);
      expect(client).not.toHaveBeenCalled();
    });

    it("startDate later than endDate is an error without a call", async () => {
      const r = await run({
        startDate: "2026-10-23T11:00:00.000Z",
        endDate: "2026-10-23T10:00:00.000Z",
      });
      expect(typeof r.body.error).toBe("string");
      expect(client).not.toHaveBeenCalled();
    });

    it("startDate later than the default endDate is an error without a call", async () => {
      const r = await run({ startDate: "2030-01-01T00:00:00.000Z" });
      expect(typeof r.body.error).toBe("string");
      expect(client).not.toHaveBeenCalled();
    });

    it("applies the same validation in entries view", async () => {
      const r = await run({ view: "entries", startDate: "garbage" });
      expect(typeof r.body.error).toBe("string");
      expect(client).not.toHaveBeenCalled();
    });
  });

  describe("date calendar and timezone rules (amendment A3)", () => {
    const FAR_END = "2030-01-01T00:00:00Z";
    const valid: Array<[string, string]> = [
      ["leap day 2028-02-29", "2028-02-29T10:00:00Z"],
      ["plain Z timestamp", "2026-10-23T10:00:00Z"],
      ["no seconds", "2026-10-23T10:00Z"],
      ["fractional seconds (3 digits)", "2026-10-23T10:00:00.123Z"],
      ["fractional seconds (9 digits)", "2026-10-23T10:00:00.123456789Z"],
      ["positive offset +02:00", "2026-10-23T10:00:00+02:00"],
      ["negative offset -05:30", "2026-10-23T10:00:00-05:30"],
      ["last second of the day", "2026-10-23T23:59:59Z"],
      ["midnight", "2026-10-23T00:00:00Z"],
      ["30-day month end", "2026-04-30T12:00:00Z"],
      ["31-day month end", "2026-12-31T12:00:00Z"],
    ];
    it.each(valid)("accepts %s", async (_label, value) => {
      queue(client, [page(1, 1)]);
      const r = await run({ startDate: value, endDate: FAR_END });
      expectExact(
        [
          typeof r.body.error === "string",
          client.mock.calls.length,
          client.mock.calls.length === 1 ? paramsOf(client, 0).startDate : null,
        ],
        [false, 1, value],
        {
          what: `startDate ${value}`,
          why: "A3: an ISO date with explicit timezone and real calendar fields is accepted and sent unchanged",
          fix: "validate with ^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})$ plus real calendar checks",
        },
      );
    });

    const invalid: Array<[string, string]> = [
      ["2026-02-30 (Feb 30)", "2026-02-30T10:00:00Z"],
      ["2026-02-31 (Feb 31)", "2026-02-31T10:00:00Z"],
      ["2026-04-31 (April 31)", "2026-04-31T10:00:00Z"],
      ["2025-02-29 (not a leap year)", "2025-02-29T10:00:00Z"],
      ["2100-02-29 (century not a leap year)", "2100-02-29T10:00:00Z"],
      ["hour 24", "2026-01-15T24:00:00Z"],
      ["minute 60", "2026-10-23T10:60:00Z"],
      ["second 60", "2026-10-23T10:00:60Z"],
      ["month 13", "2026-13-01T10:00:00Z"],
      ["month 00", "2026-00-10T10:00:00Z"],
      ["day 00", "2026-10-00T10:00:00Z"],
      ["day 32", "2026-10-32T10:00:00Z"],
      ["offset without colon", "2026-10-23T10:00:00+0200"],
      ["10 fractional digits", "2026-10-23T10:00:00.1234567890Z"],
    ];
    const fields = ["startDate", "endDate"] as const;
    for (const field of fields) {
      it.each(invalid)(`rejects ${field} %s`, async (_label, value) => {
        const r = await run({ [field]: value });
        expectExact(
          [
            typeof r.body.error === "string",
            /ISO 8601/.test(String(r.body.error)),
            client.mock.calls.length,
          ],
          [true, true, 0],
          {
            what: `${field} ${value}`,
            why: "A3: calendar fields must be real; invalid dates are an ISO 8601 error with zero client calls",
            fix: "check month 1-12, day <= days in month (leap years), hour 0-23, minute 0-59, second 0-59 before any call",
          },
        );
      });
    }

    it.each(fields)(
      "rejects a timezone-less %s with an error that mentions the timezone",
      async (field) => {
        const r = await run({ [field]: "2026-10-23T10:00:00" });
        expectExact(
          [
            typeof r.body.error === "string",
            /ISO 8601/.test(String(r.body.error)),
            /timezone/i.test(String(r.body.error)),
            client.mock.calls.length,
          ],
          [true, true, true, 0],
          {
            what: `timezone-less ${field}`,
            why: "A3: an explicit timezone (Z or +hh:mm) is REQUIRED and the error must say so",
            fix: "require (Z|[+-]\\d{2}:\\d{2}) and mention 'timezone' in the error text",
          },
        );
      },
    );

    it.each(fields)(
      "echoes a 100-character junk %s sliced to 40 characters and nothing else",
      async (field) => {
        const junk = `${"J".repeat(40)}${"K".repeat(55)}${SENTINEL_TEXT}`;
        expectExact(junk.length > 40, true, {
          what: "fixture",
          why: "junk is longer than 40",
          fix: "fix the fixture",
        });
        const r = await run({ [field]: junk });
        const error = String(r.body.error);
        expectExact(
          [
            typeof r.body.error === "string",
            error.includes("J".repeat(40)),
            error.includes("K"),
            error.includes(SENTINEL_TEXT),
            Object.keys(r.body),
            client.mock.calls.length,
          ],
          [true, true, false, false, ["error"], 0],
          {
            what: `100-character invalid ${field}`,
            why: "A3: the error echoes the offending value sliced to 40 characters; no more of it, and no other body key",
            fix: "include String(value).slice(0, 40) in the error and return only { error }",
          },
        );
      },
    );

    it("echoes a short invalid value in full", async () => {
      const r = await run({ startDate: "yesterday" });
      expectExact(
        [String(r.body.error).includes("yesterday"), Object.keys(r.body)],
        [true, ["error"]],
        {
          what: "short invalid startDate",
          why: "values up to 40 chars are echoed whole",
          fix: "slice(0, 40) only cuts longer values",
        },
      );
    });
  });

  describe("timezone offset range (amendment A10)", () => {
    const badOffsets = ["+99:99", "+24:00", "+05:60", "-99:99", "-24:00"];
    const good: Array<[string, string, string]> = [
      ["+23:59", "2026-10-22T00:00:00+23:59", "2026-10-25T10:00:00+23:59"],
      ["-12:00", "2026-10-22T00:00:00-12:00", "2026-10-25T10:00:00-12:00"],
    ];
    const GOOD_START = "2026-10-22T10:00:00Z";
    const GOOD_END = "2026-10-25T10:00:00Z";
    const placements: Array<[string, (v: string) => Record<string, string>]> = [
      ["startDate", (v) => ({ startDate: v })],
      ["endDate only", (v) => ({ endDate: v })],
      ["both", (v) => ({ startDate: v, endDate: v })],
      [
        "startDate with a good endDate",
        (v) => ({ startDate: v, endDate: GOOD_END }),
      ],
      [
        "endDate with a good startDate",
        (v) => ({ startDate: GOOD_START, endDate: v }),
      ],
    ];

    for (const offset of badOffsets) {
      it.each(placements)(
        `rejects offset ${offset} as %s: ISO error, zero calls, no throw`,
        async (_label, build) => {
          const value = `2026-10-23T10:00:00${offset}`;
          const result = await run(build(value)).catch((e: unknown) => ({
            threw: String(e),
          }));
          expectExact(
            [
              "threw" in result,
              "body" in result &&
                /ISO 8601/.test(String((result as any).body.error)),
              client.mock.calls.length,
            ],
            [false, true, 0],
            {
              what: `offset ${offset} as ${_label}`,
              why: "A10: an explicit offset needs hours 00-23 and minutes 00-59 and Date.parse must be finite; readLogs must never throw on any date input",
              fix: "validate offset hours/minutes and Number.isFinite(Date.parse(value)) before computing defaults; return { body: { error } } instead of letting toISOString throw",
            },
          );
        },
      );
    }

    it("endDate-only with +99:99 resolves (does not reject) to the ISO error body", async () => {
      await expect(
        run({ endDate: "2026-10-25T10:00:00+99:99" }),
      ).resolves.toEqual({
        body: { error: expect.stringMatching(/ISO 8601/) },
      });
      expect(client).not.toHaveBeenCalled();
    });

    it.each(good)(
      "accepts offset %s as startDate, endDate and both, sent unchanged",
      async (_offset, start, end) => {
        queue(client, [page(1, 1), page(1, 1), page(1, 1)]);
        await run({ startDate: start });
        await run({ endDate: end });
        await run({ startDate: start, endDate: end });
        expectExact(
          [
            client.mock.calls.length,
            paramsOf(client, 0).startDate,
            paramsOf(client, 1).endDate,
            paramsOf(client, 2).startDate,
            paramsOf(client, 2).endDate,
          ],
          [3, start, end, start, end],
          {
            what: `valid offset ${_offset}`,
            why: "A10: the extreme valid offsets +23:59 and -12:00 are accepted and the supplied value is sent unchanged",
            fix: "accept hours 00-23 and minutes 00-59 in the offset",
          },
        );
      },
    );
  });

  describe("partial window defaults (amendment A5)", () => {
    it("only endDate: startDate is endDate minus 3 600 000 ms exactly", async () => {
      queue(client, [page(1, 1)]);
      const endDate = "2026-10-23T11:00:00.000Z";
      const r = await run({ endDate });
      expectExact(
        [
          paramsOf(client, 0).startDate,
          paramsOf(client, 0).endDate,
          r.body.window,
        ],
        [
          "2026-10-23T10:00:00.000Z",
          endDate,
          { from: "2026-10-23T10:00:00.000Z", to: endDate },
        ],
        {
          what: "only endDate supplied",
          why: "A5: start = end - 3_600_000 ms, not now - 3_600_000 ms",
          fix: "derive the default start from the effective endDate",
        },
      );
    });

    it("only endDate with an offset: start is computed from the instant and expressed in UTC ISO", async () => {
      queue(client, [page(1, 1)]);
      const endDate = "2026-10-23T11:00:00+02:00";
      await run({ endDate });
      expectExact(
        [paramsOf(client, 0).startDate, paramsOf(client, 0).endDate],
        ["2026-10-23T08:00:00.000Z", endDate],
        {
          what: "only endDate with +02:00 offset",
          why: "A5: start = new Date(Date.parse(endDate) - 3_600_000).toISOString(); endDate is passed as given",
          fix: "compute from Date.parse(endDate)",
        },
      );
    });

    it("only endDate in entries view uses the same derived start", async () => {
      queue(client, [page(1, 1)]);
      await run({ view: "entries", endDate: "2026-10-23T11:00:00.000Z" });
      expectExact(paramsOf(client, 0).startDate, "2026-10-23T10:00:00.000Z", {
        what: "only endDate, entries view",
        why: "A5 applies to every view on the window path",
        fix: "share the date resolution between views",
      });
    });

    it("only endDate far in the past does not error (start derived from it, not from now)", async () => {
      queue(client, [page(1, 1)]);
      const r = await run({ endDate: "2026-01-01T00:00:00.000Z" });
      expectExact(
        [typeof r.body.error === "string", paramsOf(client, 0).startDate],
        [false, "2025-12-31T23:00:00.000Z"],
        {
          what: "endDate months before now",
          why: "A5: deriving start from now would make start later than end and wrongly error",
          fix: "start = endDate - 3_600_000 ms",
        },
      );
    });

    it("only startDate: endDate is now + 60 000 ms", async () => {
      queue(client, [page(1, 1)]);
      const startDate = "2026-10-23T10:00:00.000Z";
      const r = await run({ startDate });
      expectExact(
        [
          paramsOf(client, 0).startDate,
          paramsOf(client, 0).endDate,
          r.body.window,
        ],
        [startDate, DEFAULT_END, { from: startDate, to: DEFAULT_END }],
        {
          what: "only startDate supplied",
          why: "A5: end defaults to now + 60_000 ms",
          fix: "keep the default end when only start is given",
        },
      );
    });

    it("only startDate exactly at the default end is allowed (not later than it)", async () => {
      queue(client, [page(1, 1)]);
      const r = await run({ startDate: DEFAULT_END });
      expectExact(
        [typeof r.body.error === "string", client.mock.calls.length],
        [false, 1],
        {
          what: "startDate == default endDate",
          why: "only a start LATER than the end is an error",
          fix: "compare start > end, not >=",
        },
      );
    });

    it("only startDate 1 ms after the default end is an error without a call", async () => {
      const r = await run({
        startDate: new Date(NOW + 60_001).toISOString(),
      });
      expectExact(
        [typeof r.body.error === "string", client.mock.calls.length],
        [true, 0],
        {
          what: "startDate after now + 60000",
          why: "A5: a start later than the default end is the legitimate start > end error",
          fix: "validate start <= end after defaults are applied",
        },
      );
    });

    it("both dates supplied are used as given", async () => {
      queue(client, [page(1, 1)]);
      await run({
        startDate: "2026-10-23T09:00:00.000Z",
        endDate: "2026-10-23T09:30:00.000Z",
      });
      expectExact(
        [paramsOf(client, 0).startDate, paramsOf(client, 0).endDate],
        ["2026-10-23T09:00:00.000Z", "2026-10-23T09:30:00.000Z"],
        {
          what: "both dates supplied",
          why: "A5: defaults apply only to the missing one",
          fix: "do not rewrite supplied dates",
        },
      );
    });
  });

  describe("window sort validation (amendment A8)", () => {
    it.each(["timestamp:asc", "timestamp:desc"])(
      "passes %s through to the platform in summary and entries view",
      async (sort) => {
        queue(client, [page(1, 1)]);
        await run({ sort });
        client = jest.fn() as Mock;
        queue(client, [page(1, 1)]);
        await run({ sort, view: "entries" });
        expectExact(
          [paramsOf(client, 0).sort, client.mock.calls.length],
          [sort, 1],
          {
            what: `sort ${sort}`,
            why: "A8: only timestamp:asc and timestamp:desc are allowed on the window path and are sent unchanged",
            fix: "validate with ^timestamp:(asc|desc)$ and forward args.sort",
          },
        );
      },
    );

    it.each([
      "lastChanged:desc",
      "timestamp:sideways",
      "name",
      "Timestamp:asc",
      "timestamp:asc,name:desc",
    ])(
      "rejects sort %p with an error naming the allowed values and no call",
      async (sort) => {
        for (const view of ["summary", "entries"]) {
          const r = await run({ sort, view });
          const error = String(r.body.error);
          expectExact(
            [
              typeof r.body.error === "string",
              error.includes("timestamp:asc"),
              error.includes("timestamp:desc"),
              client.mock.calls.length,
            ],
            [true, true, true, 0],
            {
              what: `window sort ${JSON.stringify(sort)} (${view} view)`,
              why: "A8: any sort not matching ^timestamp:(asc|desc)$ is an error that names the allowed values, before any call",
              fix: "validate sort on the window path and return { error } listing timestamp:asc and timestamp:desc",
            },
          );
        }
      },
    );

    it("the session path still rejects any sort, even a valid window value, without a call", async () => {
      const r = await run({ sessionId: "s1", sort: "timestamp:desc" });
      expectExact(
        [
          typeof r.body.error === "string",
          /sort/.test(String(r.body.error)),
          client.mock.calls.length,
        ],
        [true, true, 0],
        {
          what: "sessionId with sort timestamp:desc",
          why: "the tail endpoint ignores sort, so the session path rejects it entirely",
          fix: "keep sort in the list of unsupported session parameters",
        },
      );
    });
  });
});
