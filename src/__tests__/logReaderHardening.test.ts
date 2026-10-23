/**
 * Tests for readLogs hardening (amendments A14a-A14d): per-call timeout, status
 * boundaries and body-less network errors, summary hint about limit/skip, and
 * the skip bound. The client is a mock; nothing touches a real environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  DEFAULT_END,
  DEFAULT_START,
  PROJECT,
  LOGS_URL,
  TAIL_URL,
  V2_HEADERS,
  ERROR_LEAK_SENTINELS,
  SENTINEL_ERR,
  SENTINEL_KEY,
  Mock,
  page,
  upstreamError,
  clientError,
  queue,
  expectExact,
  paramsOf,
  opts,
} from "./helpers/logFixtures.js";
import {
  rawAxiosError,
  tlsText,
  timeoutText,
  dnsText,
  unreachableText,
} from "./helpers/netErrors.js";

describe("readLogs hardening", () => {
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
  const configOf = (call: number) => client.mock.calls[call][1] as any;

  describe("A14a: every get carries timeout 10000", () => {
    const spec = (what: string) => ({
      what,
      why: "A14a: each client.get passes timeout: 10000 in its axios config so one slow page is bounded",
      fix: "add timeout: 10000 to the config object of every client.get in readLogs (window pages, entries, tail), next to params",
    });

    it("summary view: all three window pages", async () => {
      queue(client, [
        page(100, 500, 0),
        page(100, 500, 100),
        page(100, 500, 200),
      ]);
      await run();
      expectExact(
        [
          client.mock.calls.length,
          [0, 1, 2].map((i) => client.mock.calls[i][0]),
          [0, 1, 2].map((i) => configOf(i).timeout),
        ],
        [3, [LOGS_URL, LOGS_URL, LOGS_URL], [10000, 10000, 10000]],
        spec("summary pages 1-3 timeout"),
      );
      expect(paramsOf(client, 0)).toEqual({
        startDate: DEFAULT_START,
        endDate: DEFAULT_END,
        limit: 100,
        sort: "timestamp:desc",
      });
      // C3: total 500 > 300, so pages 2 and 3 are spread: floor(400/2)=200 and 400
      expect(paramsOf(client, 1).skip).toBe(200);
      expect(paramsOf(client, 2).skip).toBe(400);
    });

    it("entries view: the single call", async () => {
      queue(client, [page(5, 5)]);
      await run({ view: "entries", limit: 10, skip: 20 });
      expectExact(
        [client.mock.calls.length, configOf(0).timeout],
        [1, 10000],
        spec("entries timeout"),
      );
      expect(paramsOf(client, 0).limit).toBe(10);
      expect(paramsOf(client, 0).skip).toBe(20);
    });

    it.each(["summary", "entries"])(
      "session (tail) path, %s view: timeout and headers both present",
      async (view) => {
        queue(client, [page(5, -1)]);
        await run({ sessionId: "s1", view });
        expectExact(
          [client.mock.calls[0][0], configOf(0).timeout, configOf(0).headers],
          [TAIL_URL, 10000, V2_HEADERS],
          spec(`tail ${view} timeout`),
        );
        expect(paramsOf(client, 0)).toEqual({ sessionId: "s1" });
      },
    );
  });

  describe("A14b/C2: status boundaries and raw network errors", () => {
    const VIEWS: Array<[string, Record<string, unknown>]> = [
      ["summary", {}],
      ["entries", { view: "entries" }],
      ["session", { sessionId: "s1" }],
    ];
    const fail = async (err: Error, args: Record<string, unknown>) => {
      client = jest.fn() as Mock;
      queue(client, [err]);
      return run(args);
    };
    const spec = (what: string) => ({
      what,
      why: "A14b/C2: only integers 100..599 are reported as status; a raw AxiosError without response names its allowlisted network code with a fixed class text; no upstream message is ever output",
      fix: "statusOf: accept 100 <= n <= 599 (Number.isInteger) and nothing else",
    });

    describe.each(VIEWS)("%s", (_v, args) => {
      it.each([100, 599])(
        "status %p (inclusive boundary) is reported as is with the generic text, both error shapes",
        async (status) => {
          const generic = await fail(clientError(500), args);
          const a = await fail(clientError(status), args);
          const b = await fail(upstreamError(status), args);
          expectExact(
            [a.body, b.body],
            [
              { error: generic.body.error, status },
              { error: generic.body.error, status },
            ],
            spec(`${_v} status ${status}`),
          );
        },
      );

      it.each([99, 600])(
        "status %p (just outside) gives status null with the generic text, both error shapes",
        async (status) => {
          const generic = await fail(clientError(500), args);
          const a = await fail(clientError(status), args);
          const b = await fail(upstreamError(status), args);
          expectExact(
            [a.body, b.body],
            [
              { error: generic.body.error, status: null },
              { error: generic.body.error, status: null },
            ],
            spec(`${_v} status ${status}`),
          );
        },
      );

      it.each([
        ["ECONNABORTED", timeoutText("ECONNABORTED")],
        ["ENOTFOUND", dnsText("ENOTFOUND")],
        ["ECONNREFUSED", unreachableText("ECONNREFUSED")],
        ["SELF_SIGNED_CERT_IN_CHAIN", tlsText("SELF_SIGNED_CERT_IN_CHAIN")],
      ])(
        "a raw AxiosError %s (no response) gives its fixed class text, status null and the code, and leaks no message",
        async (code, text) => {
          const r = await fail(rawAxiosError(code), args);
          expectExact(
            [
              r.body,
              Object.keys(r.body),
              [...ERROR_LEAK_SENTINELS, SENTINEL_ERR, SENTINEL_KEY].filter(
                (s) => JSON.stringify(r).includes(s),
              ),
              client.mock.calls.length,
            ],
            [
              { error: text, status: null, code },
              ["error", "status", "code"],
              [],
              1,
            ],
            spec(`${_v} ${code}`),
          );
        },
      );
    });
  });

  describe("A14c: summary view ignores limit and skip and says so", () => {
    const spec = (what: string) => ({
      what,
      why: "A14c: a summary given limit/skip still succeeds, ignores them, and its hint.action says limit and skip apply only to view 'entries'; without them the hint does not mention it",
      fix: "append a sentence like \"limit and skip apply only to view: 'entries'; use that view to page\" to hint.action only when args.limit or args.skip was supplied",
    });
    const mentions = (action: unknown) => {
      const a = String(action).toLowerCase();
      return [
        /\blimit\b/.test(a),
        /\bskip\b/.test(a),
        /entries/.test(a),
        /only/.test(a),
      ];
    };

    it.each([
      ["limit", { limit: 50 }],
      ["skip", { skip: 10 }],
      ["limit and skip", { limit: 50, skip: 10 }],
    ] as Array<[string, Record<string, unknown>]>)(
      "supplied %s: succeeds, params unchanged, hint says they apply only to entries",
      async (_label, extra) => {
        queue(client, [page(3, 3)]);
        const r = await run(extra);
        expect(r.body.error).toBeUndefined();
        expect(r.body.view).toBe("summary");
        expectExact(
          paramsOf(client, 0),
          {
            startDate: DEFAULT_START,
            endDate: DEFAULT_END,
            limit: 100,
            sort: "timestamp:desc",
          },
          spec(`${_label}: params`),
        );
        expectExact(
          mentions(r.hint?.action),
          [true, true, true, true],
          spec(`${_label}: hint.action text`),
        );
      },
    );

    it("a truncated summary given limit also carries the note next to the narrowing advice", async () => {
      queue(client, [page(100, 900), page(100, 900), page(100, 900)]);
      const r = await run({ limit: 5 });
      const a = String(r.hint?.action).toLowerCase();
      expectExact(
        [mentions(r.hint?.action), /search/.test(a), /sessionid/.test(a)],
        [[true, true, true, true], true, true],
        spec("truncated summary hint with limit"),
      );
    });

    it.each([
      ["nothing supplied", {}],
      ["only filters", { search: "x", logLevel: ["error"] }],
    ] as Array<[string, Record<string, unknown>]>)(
      "%s: hint.action does not mention limit or skip",
      async (_label, extra) => {
        queue(client, [page(3, 3)]);
        const r = await run(extra);
        const a = String(r.hint?.action).toLowerCase();
        expectExact([/\blimit\b/.test(a), /\bskip\b/.test(a)], [false, false], {
          ...spec(`${_label}: hint.action text`),
          fix: "mention limit/skip only when the caller supplied them",
        });
      },
    );
  });

  describe("A14d: skip must be an integer 0..100000 on the window path", () => {
    const spec = (what: string) => ({
      what,
      why: "A14d: skip outside 0..100000 (or not an integer) is rejected before any call with an error naming the maximum; 0 and 100000 are accepted, 0 stays omitted from params",
      fix: "validate Number.isInteger(skip) && skip >= 0 && skip <= 100000 up front; return { error: '... skip ... at most 100000 ...' } with zero client calls",
    });

    describe.each([
      ["summary", {}],
      ["entries", { view: "entries" }],
    ] as Array<[string, Record<string, unknown>]>)("%s view", (_v, args) => {
      it.each([
        ["100001", 100001],
        ["1e308", 1e308],
        ["1.5", 1.5],
        ["-1", -1],
        ["NaN", NaN],
        ["Infinity", Infinity],
      ])(
        "skip %s: error naming the maximum, zero client calls",
        async (_label, skip) => {
          const r = await run({ ...args, skip });
          expectExact(
            [
              client.mock.calls.length,
              typeof r.body.error,
              /100[,_ ]?000/.test(String(r.body.error)),
              /skip/i.test(String(r.body.error)),
            ],
            [0, "string", true, true],
            spec(`${_v} view, skip ${_label}`),
          );
        },
      );

      it("skip 0 is accepted and omitted from params", async () => {
        queue(client, [page(2, 2)]);
        const r = await run({ ...args, skip: 0 });
        expectExact(
          [
            r.body.error,
            "skip" in paramsOf(client, 0),
            client.mock.calls.length,
          ],
          [undefined, false, 1],
          spec(`${_v} view, skip 0`),
        );
      });

      it("skip 100000 is accepted", async () => {
        queue(client, [page(2, 2)]);
        const r = await run({ ...args, skip: 100000 });
        expectExact(
          [r.body.error, client.mock.calls.length],
          [undefined, 1],
          spec(`${_v} view, skip 100000`),
        );
      });
    });

    it("entries view sends skip 100000 as given", async () => {
      queue(client, [page(2, 2)]);
      await run({ view: "entries", skip: 100000 });
      expectExact(paramsOf(client, 0).skip, 100000, spec("entries skip value"));
    });
  });
});
