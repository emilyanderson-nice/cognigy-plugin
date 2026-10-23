/**
 * Tests for the log reader orchestrator (readLogs): errors.
 * The client is a mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  PROJECT,
  SENTINEL_ERR,
  SENTINEL_KEY,
  ALL_SENTINELS,
  Mock,
  page,
  upstreamError,
  queue,
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

  describe("first-call failures", () => {
    it.each([400, 401, 403, 404, 429, 500])(
      "status %p gives an error result with that status and no upstream text",
      async (status) => {
        queue(client, [upstreamError(status)]);
        const r = await run();
        expect(typeof r.body.error).toBe("string");
        expect(r.body.status).toBe(status);
        expect(typeof r.body.error).toBe("string");
        expect((r.body.error as string).length).toBeGreaterThan(0);
        expect(sortedKeys(r.body)).toEqual(["error", "status"]);
        expect(client).toHaveBeenCalledTimes(1);
        const text = JSON.stringify(r);
        for (const s of ALL_SENTINELS) expect(text).not.toContain(s);
      },
    );

    it("a network error without a response gives status null", async () => {
      queue(client, [upstreamError(null, `ECONNRESET ${SENTINEL_ERR}`)]);
      const r = await run();
      expect(typeof r.body.error).toBe("string");
      expect(r.body.status).toBeNull();
      expect(JSON.stringify(r)).not.toContain(SENTINEL_ERR);
      expect(JSON.stringify(r)).not.toContain(SENTINEL_KEY);
    });

    it.each([400, 401, 403, 404, 429, 500, null])(
      "status %p: two different upstream messages give identical output",
      async (status) => {
        queue(client, [upstreamError(status, "first upstream message AAA")]);
        const a = await run();
        client = jest.fn() as Mock;
        queue(client, [upstreamError(status, "totally different text BBB")]);
        const b = await run();
        expect(b).toEqual(a);
      },
    );

    it("different statuses give different error text for 400, 401, 404, 429, 500", async () => {
      const texts: string[] = [];
      for (const status of [400, 401, 404, 429, 500]) {
        client = jest.fn() as Mock;
        queue(client, [upstreamError(status)]);
        texts.push(String((await run()).body.error));
      }
      expect(new Set(texts).size).toBe(5);
    });

    it("401 and 403 both say the key is not permitted (same text)", async () => {
      client = jest.fn() as Mock;
      queue(client, [upstreamError(401)]);
      const a = await run();
      client = jest.fn() as Mock;
      queue(client, [upstreamError(403)]);
      const b = await run();
      expect(a.body.error).toBe(b.body.error);
      expect(String(a.body.error)).toMatch(/permit/i);
    });

    it("404 mentions the v2.1 logs API and a recent Cognigy release", async () => {
      queue(client, [upstreamError(404)]);
      const r = await run();
      expect(String(r.body.error)).toMatch(/2\.1/);
      expect(String(r.body.error)).toMatch(/release/i);
    });

    it("429 says to retry later", async () => {
      queue(client, [upstreamError(429)]);
      const r = await run();
      expect(String(r.body.error)).toMatch(/retry/i);
    });

    it("an unusual status (502) gets the same generic text as 500", async () => {
      queue(client, [upstreamError(500)]);
      const a = await run();
      client = jest.fn() as Mock;
      queue(client, [upstreamError(502)]);
      const b = await run();
      expect(b.body.error).toBe(a.body.error);
      expect(b.body.status).toBe(502);
    });

    it("entries view failure behaves the same and leaks nothing", async () => {
      queue(client, [upstreamError(403)]);
      const r = await run({ view: "entries" });
      expect(typeof r.body.error).toBe("string");
      expect(r.body.status).toBe(403);
      for (const s of ALL_SENTINELS) expect(JSON.stringify(r)).not.toContain(s);
    });

    it("session path failure gives fixed text and status and leaks nothing", async () => {
      queue(client, [upstreamError(404)]);
      const r = await run({ sessionId: "s1" });
      expect(typeof r.body.error).toBe("string");
      expect(r.body.status).toBe(404);
      for (const s of ALL_SENTINELS) expect(JSON.stringify(r)).not.toContain(s);
    });
  });

  describe("partial failure on a later summary page", () => {
    it("page 2 failure returns page 1 data, truncated true, a warning hint, not an error", async () => {
      queue(client, [page(100, 1000), upstreamError(500)]);
      const r = await run();
      expect(client).toHaveBeenCalledTimes(2);
      expect(r.body.error).toBeUndefined();
      expect(r.body.sampled).toBe(100);
      expect(r.body.total).toBe(1000);
      expect(r.body.truncated).toBe(true);
      expect(typeof (r.hint as any)?.warning).toBe("string");
      expect(((r.hint as any).warning as string).length).toBeGreaterThan(0);
    });

    it("page 3 failure returns pages 1 and 2, truncated true", async () => {
      queue(client, [
        page(100, 1000),
        page(100, 1000, 100),
        upstreamError(429),
      ]);
      const r = await run();
      expect(client).toHaveBeenCalledTimes(3);
      expect(r.body.error).toBeUndefined();
      expect(r.body.sampled).toBe(200);
      expect(r.body.truncated).toBe(true);
      expect(typeof (r.hint as any)?.warning).toBe("string");
    });

    it("leaks nothing from the failed page", async () => {
      queue(client, [page(100, 1000), upstreamError(500)]);
      const r = await run();
      for (const s of ALL_SENTINELS) expect(JSON.stringify(r)).not.toContain(s);
    });
  });
});
