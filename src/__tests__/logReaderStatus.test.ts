/**
 * Tests for the log reader orchestrator (readLogs): status extraction from the
 * REAL client error shape (amendments A9, A11). The real client rejects with a
 * plain Error carrying .status/.code/.traceId/.details and NO .response, so
 * every fixed per-status text must fire for that shape too. The client is a
 * mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  PROJECT,
  ERROR_LEAK_SENTINELS,
  SENTINEL_ERR,
  Mock,
  page,
  upstreamError,
  clientError,
  queue,
  expectExact,
  opts,
} from "./helpers/logFixtures.js";

type View = "summary" | "entries" | "session";
const VIEWS: View[] = ["summary", "entries", "session"];
const VIEW_ARGS: Record<View, Record<string, unknown>> = {
  summary: {},
  entries: { view: "entries" },
  session: { sessionId: "s1" },
};

describe("readLogs status extraction", () => {
  let client: Mock;

  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  /** Run one first-call failure and return the result. */
  const fail = async (err: Error, view: View) => {
    client = jest.fn() as Mock;
    queue(client, [err]);
    return readLogs(
      { get: client } as any,
      { projectId: PROJECT, ...VIEW_ARGS[view] } as any,
      opts,
    );
  };

  const spec = (what: string) => ({
    what,
    why: "A9: status comes from err.response.status first, else err.status (integer 100..599 only); the fixed text is chosen by status; nothing from the upstream error is ever output",
    fix: "derive the status from both error shapes and map it to the fixed text; output only { error, status }",
  });

  describe.each(VIEWS)("%s path", (view) => {
    it.each([400, 401, 403, 404, 429, 500, 502])(
      "client-shaped status %p gives that status, the same fixed text as a response-shaped error, only {error,status} and no leak",
      async (status) => {
        const clientShaped = await fail(clientError(status), view);
        const responseShaped = await fail(upstreamError(status), view);
        expectExact(
          [
            clientShaped.body,
            Object.keys(clientShaped.body).sort(),
            client.mock.calls.length,
            ERROR_LEAK_SENTINELS.filter((s) =>
              JSON.stringify(clientShaped).includes(s),
            ),
          ],
          [responseShaped.body, ["error", "status"], 1, []],
          spec(`${view} view, client-shaped ${status}`),
        );
        expect(clientShaped.body.status).toBe(status);
        expect(typeof clientShaped.body.error).toBe("string");
        expect(clientShaped).not.toHaveProperty("isError");
      },
    );

    it.each([400, 401, 403, 404, 429, 500, 502])(
      "client-shaped status %p: two different upstream messages give identical output",
      async (status) => {
        const a = await fail(clientError(status, "first message AAA"), view);
        const b = await fail(clientError(status, "other text BBB"), view);
        expectExact(b, a, spec(`${view} view, ${status}, message-independent`));
      },
    );

    it.each([
      [401, /permit/i],
      [403, /permit/i],
      [404, /2\.1/],
      [404, /release/i],
      [429, /retry/i],
      [400, /query|reject/i],
    ] as Array<[number, RegExp]>)(
      "client-shaped %p text matches %p",
      async (status, re) => {
        const r = await fail(clientError(status), view);
        expectExact(
          re.test(String(r.body.error)),
          true,
          spec(`${status} text`),
        );
      },
    );

    it("client-shaped 502 and 500 share the generic text; 400, 401, 404, 429 and generic are five distinct texts", async () => {
      const texts: string[] = [];
      for (const status of [400, 401, 404, 429, 500]) {
        texts.push(String((await fail(clientError(status), view)).body.error));
      }
      const r502 = await fail(clientError(502), view);
      expectExact(
        [new Set(texts).size, r502.body.error, r502.body.status],
        [5, texts[4], 502],
        spec(`${view} view generic text`),
      );
    });

    it.each([
      ["99 (below range)", 99],
      ["600 (above range)", 600],
      ['"403" (a string)', "403"],
      ["403.5 (not an integer)", 403.5],
      ["NaN", NaN],
      ["undefined", undefined],
      ["null", null],
      ["Infinity", Infinity],
    ] as Array<[string, unknown]>)(
      "client-shaped .status %s gives status null and the generic text",
      async (_label, junk) => {
        const r = await fail(clientError(junk), view);
        const generic = await fail(clientError(500), view);
        expectExact(
          [
            r.body,
            ERROR_LEAK_SENTINELS.filter((s) => JSON.stringify(r).includes(s)),
          ],
          [{ error: generic.body.error, status: null }, []],
          spec(`${view} view, junk .status ${_label}`),
        );
      },
    );

    it("when both are present, response.status wins over .status", async () => {
      const err: any = clientError(403);
      err.response = { status: 404, data: { detail: SENTINEL_ERR } };
      const r = await fail(err, view);
      const expected = await fail(upstreamError(404), view);
      expectExact(r.body, expected.body, spec(`${view} view, precedence`));
      expect(r.body.status).toBe(404);
    });

    it("an out-of-range response.status gives status null", async () => {
      const err: any = upstreamError(600);
      const r = await fail(err, view);
      expectExact(r.body.status, null, spec(`${view} view, response 600`));
    });
  });

  describe("A11: no isError field anywhere", () => {
    it("neither an error result nor a success result has an isError property", async () => {
      const failed = await fail(clientError(500), "summary");
      client = jest.fn() as Mock;
      queue(client, [page(1, 1)]);
      const ok = await readLogs(
        { get: client } as any,
        { projectId: PROJECT } as any,
        opts,
      );
      expectExact(
        [
          "isError" in failed,
          "isError" in ok,
          typeof failed.body.error,
          ok.body.error,
        ],
        [false, false, "string", undefined],
        {
          what: "LogReadResult shape",
          why: "A11: isError is removed; failures are recognized by a body.error string, successes have no error key",
          fix: "drop isError from LogReadResult and every return; keep { body, hint? }",
        },
      );
    });
  });
});
