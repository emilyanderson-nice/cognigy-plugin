/**
 * Tests for the log reader orchestrator (readLogs): security.
 * The client is a mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  PROJECT,
  SENTINEL_ERR,
  ALL_SENTINELS,
  Mock,
  items,
  page,
  hostileItem,
  upstreamError,
  queue,
  opts,
} from "./helpers/logFixtures.js";

describe("readLogs", () => {
  let client: Mock;

  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = (args: Record<string, unknown> = {}, o: any = opts) =>
    readLogs({ get: client } as any, { projectId: PROJECT, ...args } as any, o);

  describe("security: no user text, URLToken, upstream error text or key in ANY output", () => {
    const expectClean = (r: unknown) => {
      const text = JSON.stringify(r);
      for (const s of ALL_SENTINELS) {
        expect(text).not.toContain(s);
      }
    };
    const hostilePage = (n: number, shape: "v1" | "v2" = "v1") => ({
      items: Array.from({ length: n }, (_, i) => hostileItem(i, shape)),
      total: n,
    });

    it("summary view (v1 shape)", async () => {
      queue(client, [hostilePage(5)]);
      const r = await run();
      expect(r.body.sampled).toBe(5);
      expectClean(r);
    });

    it("summary view (v2 shape)", async () => {
      queue(client, [hostilePage(5, "v2")]);
      const r = await run();
      expect(r.body.levels).toEqual({ error: 5 });
      expectClean(r);
    });

    it("entries view (v1 shape) keeps the allowed meta and drops the rest", async () => {
      queue(client, [hostilePage(3)]);
      const r = await run({ view: "entries" });
      const first = (r.body.entries as any[])[0];
      expect(first.flowId).toBe("flowA");
      expect(first.channel).toBe("webchat");
      expect(first.level).toBe("error");
      expectClean(r);
    });

    it("entries view (v2 shape)", async () => {
      queue(client, [hostilePage(3, "v2")]);
      const r = await run({ view: "entries" });
      expectClean(r);
    });

    it("session path summary", async () => {
      queue(client, [hostilePage(4, "v2")]);
      const r = await run({ sessionId: "s1" });
      expect(r.body.sampled).toBe(4);
      expectClean(r);
    });

    it("session path entries", async () => {
      queue(client, [hostilePage(4, "v2")]);
      const r = await run({ sessionId: "s1", view: "entries" });
      expect(r.body.returned).toBe(4);
      expectClean(r);
    });

    it("partial failure after hostile page 1", async () => {
      queue(client, [
        {
          items: Array.from({ length: 100 }, (_, i) => hostileItem(i)),
          total: 500,
        },
        upstreamError(500),
      ]);
      const r = await run();
      expect(r.body.truncated).toBe(true);
      expectClean(r);
    });

    it.each([400, 401, 403, 404, 429, 500, null])(
      "first-call error with status %p",
      async (status) => {
        queue(client, [upstreamError(status)]);
        const r = await run();
        expect(typeof r.body.error).toBe("string");
        expectClean(r);
      },
    );

    it("a hostile search term is not echoed in an error body", async () => {
      queue(client, [upstreamError(400, `bad filter ${SENTINEL_ERR}`)]);
      const r = await run({ search: "anything" });
      expectClean(r);
    });
  });
});
