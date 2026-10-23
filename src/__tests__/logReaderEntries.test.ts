/**
 * Tests for the log reader orchestrator (readLogs): entries.
 * The client is a mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import {
  readLogs,
  SUMMARY_PAGE_SIZE,
  SUMMARY_MAX_PAGES,
  DEFAULT_DEADLINE_MS,
  ENTRIES_DEFAULT_LIMIT,
  ENTRIES_MAX_LIMIT,
} from "../tools/logReader.js";
import {
  DEFAULT_END,
  DEFAULT_START,
  PROJECT,
  LOGS_URL,
  Mock,
  item,
  items,
  page,
  queue,
  paramsOf,
  sortedKeys,
  opts,
  e,
} from "./helpers/logFixtures.js";

describe("readLogs", () => {
  let client: Mock;

  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = (args: Record<string, unknown> = {}, o: any = opts) =>
    readLogs({ get: client } as any, { projectId: PROJECT, ...args } as any, o);

  describe("constants", () => {
    it("exports the documented limits", () => {
      expect(SUMMARY_PAGE_SIZE).toBe(100);
      expect(SUMMARY_MAX_PAGES).toBe(3);
      expect(DEFAULT_DEADLINE_MS).toBe(20_000);
      expect(ENTRIES_DEFAULT_LIMIT).toBe(25);
      expect(ENTRIES_MAX_LIMIT).toBe(100);
    });
  });

  describe("window path, entries view", () => {
    it("makes one call with default limit 25 and no skip", async () => {
      queue(client, [page(10, 10)]);
      const r = await run({ view: "entries" });
      expect(client).toHaveBeenCalledTimes(1);
      expect(client.mock.calls[0][0]).toBe(LOGS_URL);
      expect(paramsOf(client, 0)).toEqual({
        startDate: DEFAULT_START,
        endDate: DEFAULT_END,
        limit: 25,
        sort: "timestamp:desc",
      });
      expect(sortedKeys(paramsOf(client, 0))).not.toContain("skip");
      expect(r.body.view).toBe("entries");
    });

    it.each([
      [undefined, 25],
      [0, 1],
      [-5, 1],
      [1, 1],
      [40, 40],
      [100, 100],
      [101, 100],
      [500, 100],
    ])("limit %p is sent as %p", async (given, sent) => {
      queue(client, [page(1, 1)]);
      await run({ view: "entries", limit: given });
      expect(paramsOf(client, 0).limit).toBe(sent);
    });

    it("passes skip through and sends filters", async () => {
      queue(client, [page(2, 90)]);
      await run({
        view: "entries",
        skip: 50,
        logLevel: ["fatal"],
        search: "x",
        flowName: "F",
        sort: "timestamp:asc",
      });
      expect(paramsOf(client, 0)).toEqual({
        startDate: DEFAULT_START,
        endDate: DEFAULT_END,
        limit: 25,
        sort: "timestamp:asc",
        type: ["fatal"],
        filter: "x",
        flowName: "F",
        skip: 50,
      });
    });

    it("omits skip when it is 0", async () => {
      queue(client, [page(2, 2)]);
      await run({ view: "entries", skip: 0 });
      expect(sortedKeys(paramsOf(client, 0))).not.toContain("skip");
    });

    it("returns exactly the documented body keys with the page total and returned count", async () => {
      queue(client, [page(3, 77)]);
      const r = await run({ view: "entries" });
      expect(sortedKeys(r.body)).toEqual(
        ["view", "window", "total", "returned", "entries"].sort(),
      );
      expect(r.body.total).toBe(77);
      expect(r.body.returned).toBe(3);
      expect(r.body.window).toEqual({ from: DEFAULT_START, to: DEFAULT_END });
      expect((r.body.entries as any[]).length).toBe(3);
    });

    it("maps v1 and v2 entry shapes to normalised entries", async () => {
      const v2 = {
        _id: "x",
        timestamp: "2026-10-23T11:59:00.000Z",
        msg: "from v2",
        metadata: { type: "info", projectId: PROJECT, organizationId: "o" },
      };
      const v1 = item(1, { msg: "from v1", type: "debug" });
      queue(client, [{ items: [v1, v2], total: 2 }]);
      const r = await run({ view: "entries" });
      const entries = r.body.entries as any[];
      expect(entries[0].level).toBe("debug");
      expect(entries[0].msg).toBe("from v1");
      expect(entries[1].level).toBe("info");
      expect(entries[1].msg).toBe("from v2");
    });

    it("entries contain only allowed fields", async () => {
      queue(client, [page(4, 4)]);
      const r = await run({ view: "entries" });
      const allowed = [
        "timestamp",
        "level",
        "msg",
        "flowId",
        "flowName",
        "channel",
        "traceId",
      ];
      for (const e of r.body.entries as any[]) {
        for (const k of Object.keys(e)) expect(allowed).toContain(k);
      }
      expect(JSON.stringify(r)).not.toContain("SHOULD_NOT_APPEAR_IN_OUTPUT");
    });
  });

  describe("hints", () => {
    it("every success mentions 24 hours retention in hint.action", async () => {
      queue(client, [page(3, 3)]);
      const summary = await run();
      expect(String((summary.hint as any).action)).toContain("24 hours");

      client = jest.fn() as Mock;
      queue(client, [page(3, 3)]);
      const entries = await run({ view: "entries" });
      expect(String((entries.hint as any).action)).toContain("24 hours");

      client = jest.fn() as Mock;
      queue(client, [{ items: [item(1)], total: -1 }]);
      const session = await run({ sessionId: "s" });
      expect(String((session.hint as any).action)).toContain("24 hours");
    });

    it("a complete non-empty result has no warning", async () => {
      queue(client, [page(3, 3)]);
      const r = await run();
      expect(r.hint?.warning).toBeUndefined();
    });

    it("a truncated summary warns that it is a SAMPLE and tells how to narrow", async () => {
      queue(client, [
        page(100, 1000),
        page(100, 1000, 100),
        page(100, 1000, 200),
      ]);
      const r = await run();
      expect(String((r.hint as any).warning)).toMatch(/sample/i);
      const action = String((r.hint as any).action);
      for (const word of ["search", "logLevel", "flowName", "sessionId"]) {
        expect(action).toContain(word);
      }
      expect(action).toContain("24 hours");
    });

    it("an entries view whose total equals the returned count has no warning", async () => {
      queue(client, [page(3, 3)]);
      const r = await run({ view: "entries" });
      expect(r.hint?.warning).toBeUndefined();
    });

    it("an empty result says so and suggests widening the window or checking the project", async () => {
      queue(client, [{ items: [], total: 0 }]);
      const r = await run();
      expect(r.body.error).toBeUndefined();
      expect(r.body.sampled).toBe(0);
      const text = `${(r.hint as any)?.warning ?? ""} ${(r.hint as any)?.action ?? ""}`;
      expect(text).toMatch(/no log|no entr|empty|zero|0 /i);
      expect(text).toMatch(/widen|wider|longer|window/i);
      expect(text).toMatch(/project|environment/i);
      expect(text).toContain("24 hours");
    });

    it("an empty entries view is also flagged", async () => {
      queue(client, [{ items: [], total: 0 }]);
      const r = await run({ view: "entries" });
      expect(r.body.returned).toBe(0);
      expect(r.body.entries).toEqual([]);
      const text = `${(r.hint as any)?.warning ?? ""} ${(r.hint as any)?.action ?? ""}`;
      expect(text).toMatch(/widen|wider|longer|window/i);
    });
  });
});
