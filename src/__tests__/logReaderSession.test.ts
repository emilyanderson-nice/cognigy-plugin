/**
 * Tests for the log reader orchestrator (readLogs): session.
 * The client is a mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  NOW,
  PROJECT,
  TAIL_URL,
  V2_HEADERS,
  Mock,
  items,
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

  describe("session path", () => {
    const tailItems = (n: number, level = "error") =>
      Array.from({ length: n }, (_, i) => ({
        _id: `t${i}`,
        timestamp: new Date(NOW - i * 1000).toISOString(),
        msg: `tail message ${i % 2}`,
        metadata: { type: level, projectId: PROJECT, organizationId: "o" },
        meta: { flowId: "fA" },
      }));

    it("rejects every unsupported parameter, naming each one, with no call", async () => {
      const r = await run({
        sessionId: "s1",
        search: "a",
        startDate: "2026-10-23T10:00:00.000Z",
        endDate: "2026-10-23T11:00:00.000Z",
        sort: "timestamp:asc",
        skip: 5,
        limit: 10,
      });
      expect(typeof r.body.error).toBe("string");
      for (const name of [
        "search",
        "startDate",
        "endDate",
        "sort",
        "skip",
        "limit",
      ]) {
        expect(String(r.body.error)).toContain(name);
      }
      expect(client).not.toHaveBeenCalled();
    });

    it.each([
      ["search", "a"],
      ["startDate", "2026-10-23T10:00:00.000Z"],
      ["endDate", "2026-10-23T11:00:00.000Z"],
      ["sort", "timestamp:asc"],
      ["skip", 5],
      ["limit", 10],
    ])("rejects %s alone and names it", async (name, value) => {
      const r = await run({ sessionId: "s1", [name]: value });
      expect(typeof r.body.error).toBe("string");
      expect(String(r.body.error)).toContain(name);
      expect(client).not.toHaveBeenCalled();
    });

    it("does not name parameters that were not supplied", async () => {
      const r = await run({ sessionId: "s1", search: "a" });
      for (const name of ["startDate", "endDate", "sort", "skip", "limit"]) {
        expect(String(r.body.error)).not.toContain(name);
      }
    });

    it("calls tail with exactly sessionId and the v2 header when no filters are given", async () => {
      queue(client, [{ items: tailItems(3), total: -1 }]);
      await run({ sessionId: "s1" });
      expect(client).toHaveBeenCalledTimes(1);
      expect(client.mock.calls[0][0]).toBe(TAIL_URL);
      const cfg = client.mock.calls[0][1] as any;
      expect(cfg.params).toEqual({ sessionId: "s1" });
      expect(sortedKeys(cfg.params)).toEqual(["sessionId"]);
      expect(cfg.headers).toEqual(V2_HEADERS);
    });

    it("sends logLevel as type and flowName on tail", async () => {
      queue(client, [{ items: tailItems(2), total: -1 }]);
      await run({
        sessionId: "s1",
        logLevel: ["error", "warn"],
        flowName: "Main",
        view: "entries",
      });
      const cfg = client.mock.calls[0][1] as any;
      expect(cfg.params).toEqual({
        sessionId: "s1",
        type: ["error", "warn"],
        flowName: "Main",
      });
      expect(cfg.headers).toEqual(V2_HEADERS);
    });

    it("summary view: total null, window null, truncated false below 100 entries", async () => {
      queue(client, [{ items: tailItems(99), total: -1 }]);
      const r = await run({ sessionId: "s1" });
      expect(r.body.view).toBe("summary");
      expect(r.body.total).toBeNull();
      expect(r.body.window).toBeNull();
      expect(r.body.sampled).toBe(99);
      expect(r.body.truncated).toBe(false);
      expect(r.body.levels).toEqual({ error: 99 });
    });

    it("summary view: truncated true when exactly 100 entries came back", async () => {
      queue(client, [{ items: tailItems(100), total: -1 }]);
      const r = await run({ sessionId: "s1" });
      expect(r.body.sampled).toBe(100);
      expect(r.body.truncated).toBe(true);
      expect(String((r.hint as any).warning)).toMatch(/sample/i);
      expect(client).toHaveBeenCalledTimes(1);
    });

    it("entries view returns all entries with v2 level mapping, total and window null", async () => {
      queue(client, [{ items: tailItems(100, "warn"), total: -1 }]);
      const r = await run({ sessionId: "s1", view: "entries" });
      expect(r.body.view).toBe("entries");
      expect(r.body.total).toBeNull();
      expect(r.body.window).toBeNull();
      expect(r.body.returned).toBe(100);
      const entries = r.body.entries as any[];
      expect(entries.length).toBe(100);
      expect(entries[0].level).toBe("warn");
      expect(entries[0].msg).toBe("tail message 0");
    });
  });
});
