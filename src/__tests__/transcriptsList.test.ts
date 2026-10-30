/**
 * listConversations: the platform returns every conversation of a project and
 * ignores limit/skip/sort/channel/dates, so the plugin filters, sorts and pages
 * itself. The client is a mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, expect, jest } from "@jest/globals";

import {
  listConversations,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_LIST_ROWS,
} from "../tools/transcripts/list.js";

const PROJECT = "507f1f77bcf86cd799439011";

type Get = (url: string, config?: any) => Promise<any>;

const mockClient = (response: unknown) => {
  const get = jest.fn<Get>().mockResolvedValue(response);
  return { client: { get }, get };
};

const failingClient = (error: unknown) => {
  const get = jest.fn<Get>().mockRejectedValue(error);
  return { client: { get }, get };
};

/** A platform list row. `n` makes `_id` and (by default) startTime unique. */
const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  _id: `session-${String(n).padStart(4, "0")}`,
  channel: "webchat",
  flowName: "Main",
  startTime: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
  endTime: new Date(Date.UTC(2026, 9, 1, 0, 5, n)).toISOString(),
  messages: 4,
  projectId: PROJECT,
  projectName: "Secret Project Name",
  endpointName: "Endpoint A",
  ratings: [1],
  rating: 5,
  ratingComments: ["RATING-COMMENT-SECRET"],
  ratingComment: "RATING-COMMENT-SECRET",
  ...overrides,
});

const idsOf = (r: { body: Record<string, unknown> }) =>
  (r.body.items as any[]).map((i) => i.sessionId);

const many = (count: number) =>
  Array.from({ length: count }, (_, i) => row(i + 1));

describe("listConversations: validation before any request", () => {
  it.each([undefined, ""])(
    "refuses projectId %p without a request",
    async (projectId) => {
      const { client, get } = mockClient({ items: [] });
      await expect(listConversations(client, { projectId })).rejects.toThrow(
        new Error("projectId is required for resourceType 'conversation'."),
      );
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty-string endDate without a request", async () => {
    const { client, get } = mockClient({ items: [] });
    await expect(
      listConversations(client, { projectId: PROJECT, endDate: "" }),
    ).rejects.toThrow(
      new Error("endDate must be an ISO 8601 date or datetime."),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["not a date", "2026-13-45", ""])(
    "refuses unparseable startDate %p without a request",
    async (startDate) => {
      const { client, get } = mockClient({ items: [] });
      await expect(
        listConversations(client, { projectId: PROJECT, startDate }),
      ).rejects.toThrow(
        new Error("startDate must be an ISO 8601 date or datetime."),
      );
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("refuses unparseable endDate without a request", async () => {
    const { client, get } = mockClient({ items: [] });
    await expect(
      listConversations(client, {
        projectId: PROJECT,
        endDate: "yesterday-ish",
      }),
    ).rejects.toThrow(
      new Error("endDate must be an ISO 8601 date or datetime."),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("exports the documented constants", () => {
    expect(DEFAULT_LIST_LIMIT).toBe(25);
    expect(MAX_LIST_LIMIT).toBe(100);
    expect(MAX_LIST_ROWS).toBe(5000);
  });
});

describe("listConversations: the one request", () => {
  it("sends exactly one request with only projectId", async () => {
    const { client, get } = mockClient({ items: [row(1)] });
    await listConversations(client, {
      projectId: PROJECT,
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      channel: "webchat",
      flowName: "Main",
      minMessages: 1,
      limit: 10,
      skip: 5,
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe("/v2.0/conversations");
    expect(get.mock.calls[0][1]).toEqual({ params: { projectId: PROJECT } });
    expect(Object.keys(get.mock.calls[0][1].params)).toEqual(["projectId"]);
  });

  it("sends contactIds when it is a non-empty array", async () => {
    const { client, get } = mockClient({ items: [] });
    await listConversations(client, {
      projectId: PROJECT,
      contactIds: ["c1", "c2"],
    });
    expect(get.mock.calls[0][1]).toEqual({
      params: { projectId: PROJECT, contactIds: ["c1", "c2"] },
    });
  });

  it("omits contactIds when the array is empty", async () => {
    const { client, get } = mockClient({ items: [] });
    await listConversations(client, { projectId: PROJECT, contactIds: [] });
    expect(get.mock.calls[0][1]).toEqual({ params: { projectId: PROJECT } });
  });

  it("uses the response itself when it is an array", async () => {
    const { client } = mockClient([row(2), row(1)]);
    const r = await listConversations(client, { projectId: PROJECT });
    expect(idsOf(r)).toEqual(["session-0002", "session-0001"]);
    expect(r.body.total).toBe(2);
  });
});

describe("listConversations: item shape", () => {
  it("returns exactly the documented keys in the documented order", async () => {
    const { client } = mockClient({ items: [row(1)] });
    const r = await listConversations(client, { projectId: PROJECT });
    const item = (r.body.items as any[])[0];
    expect(Object.keys(item)).toEqual([
      "sessionId",
      "channel",
      "flowName",
      "endpointName",
      "startTime",
      "endTime",
      "messages",
      "rating",
    ]);
    expect(item).toEqual({
      sessionId: "session-0001",
      channel: "webchat",
      flowName: "Main",
      endpointName: "Endpoint A",
      startTime: "2026-10-01T00:00:01.000Z",
      endTime: "2026-10-01T00:05:01.000Z",
      messages: 4,
      rating: 5,
    });
  });

  it("never returns comments, project name or unknown upstream keys", async () => {
    const { client } = mockClient({
      items: [
        row(1, {
          contactId: "CONTACT-SECRET",
          endpointUrlToken: "TOKEN-SECRET",
          extraUnknown: "EXTRA-SECRET",
        }),
      ],
    });
    const r = await listConversations(client, { projectId: PROJECT });
    const text = JSON.stringify(r);
    for (const secret of [
      "CONTACT-SECRET",
      "TOKEN-SECRET",
      "EXTRA-SECRET",
      "RATING-COMMENT-SECRET",
      "Secret Project Name",
      "ratingComment",
      "projectName",
      "contactId",
      "endpointUrlToken",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("omits keys whose source is undefined and keeps null as null", async () => {
    const { client } = mockClient({
      items: [
        {
          _id: "s1",
          channel: "webchat",
          startTime: "2026-10-01T00:00:00.000Z",
          rating: null,
          // flowName, endpointName, endTime, messages undefined
        },
      ],
    });
    const r = await listConversations(client, { projectId: PROJECT });
    const item = (r.body.items as any[])[0];
    expect(Object.keys(item)).toEqual([
      "sessionId",
      "channel",
      "startTime",
      "rating",
    ]);
    expect(item.rating).toBeNull();
  });
});

describe("listConversations: date filters", () => {
  const start = "2026-10-01T10:00:00.000Z";
  const end = "2026-10-01T12:00:00.000Z";
  const ms = (iso: string, delta: number) =>
    new Date(Date.parse(iso) + delta).toISOString();
  const rows = [
    row(1, { _id: "before", startTime: ms(start, -1) }),
    row(2, { _id: "at-start", startTime: start }),
    row(3, { _id: "inside", startTime: "2026-10-01T11:00:00.000Z" }),
    row(4, { _id: "at-end", startTime: end }),
    row(5, { _id: "after", startTime: ms(end, 1) }),
    row(6, { _id: "unparseable", startTime: "garbage" }),
    row(7, { _id: "missing", startTime: undefined }),
  ];

  it("includes rows equal to startDate and endDate, excludes one ms outside", async () => {
    const { client } = mockClient({ items: rows });
    const r = await listConversations(client, {
      projectId: PROJECT,
      startDate: start,
      endDate: end,
    });
    expect(idsOf(r)).toEqual(["at-end", "inside", "at-start"]);
    expect(r.body.total).toBe(3);
  });

  it("startDate alone excludes earlier rows, unparseable and missing times", async () => {
    const { client } = mockClient({ items: rows });
    const r = await listConversations(client, {
      projectId: PROJECT,
      startDate: start,
    });
    expect(idsOf(r)).toEqual(["after", "at-end", "inside", "at-start"]);
  });

  it("endDate alone excludes later rows, unparseable and missing times", async () => {
    const { client } = mockClient({ items: rows });
    const r = await listConversations(client, {
      projectId: PROJECT,
      endDate: end,
    });
    expect(idsOf(r)).toEqual(["at-end", "inside", "at-start", "before"]);
  });

  it("compares instants, not strings (offset datetimes)", async () => {
    const { client } = mockClient({
      items: [
        row(1, { _id: "z", startTime: "2026-10-01T10:00:00.000Z" }),
        row(2, { _id: "plus2", startTime: "2026-10-01T10:00:00.000+02:00" }),
      ],
    });
    // 10:00+02:00 is 08:00Z, so it is before a 09:00Z startDate; 10:00Z is not.
    const r = await listConversations(client, {
      projectId: PROJECT,
      startDate: "2026-10-01T09:00:00Z",
    });
    expect(idsOf(r)).toEqual(["z"]);
  });

  it("accepts a date-only startDate", async () => {
    const { client } = mockClient({
      items: [
        row(1, { _id: "old", startTime: "2026-09-30T23:59:59.000Z" }),
        row(2, { _id: "new", startTime: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    const r = await listConversations(client, {
      projectId: PROJECT,
      startDate: "2026-10-01",
    });
    expect(idsOf(r)).toEqual(["new"]);
  });
});

describe("listConversations: other filters and combination", () => {
  const items = [
    row(1, { _id: "a", channel: "webchat", flowName: "Main", messages: 1 }),
    row(2, { _id: "b", channel: "Webchat", flowName: "Main", messages: 5 }),
    row(3, { _id: "c", channel: "webchat", flowName: "main", messages: 5 }),
    row(4, { _id: "d", channel: "webchat", flowName: "Main", messages: 5 }),
    row(5, { _id: "e", channel: "voice", flowName: "Main", messages: 9 }),
    row(6, {
      _id: "f",
      channel: "webchat",
      flowName: "Main",
      messages: undefined,
    }),
    row(7, { _id: "g", channel: "webchat", flowName: "Main", messages: "5" }),
  ];

  it("channel matches exactly and case-sensitively", async () => {
    const { client } = mockClient({ items });
    const r = await listConversations(client, {
      projectId: PROJECT,
      channel: "webchat",
    });
    expect(idsOf(r)).toEqual(["g", "f", "d", "c", "a"]);
  });

  it("flowName matches exactly and case-sensitively", async () => {
    const { client } = mockClient({ items });
    const r = await listConversations(client, {
      projectId: PROJECT,
      flowName: "main",
    });
    expect(idsOf(r)).toEqual(["c"]);
  });

  it("minMessages keeps rows with messages >= n; missing or non-numeric counts as 0", async () => {
    const { client } = mockClient({ items });
    const five = await listConversations(client, {
      projectId: PROJECT,
      minMessages: 5,
    });
    expect(idsOf(five)).toEqual(["e", "d", "c", "b"]);
    const zero = await listConversations(client, {
      projectId: PROJECT,
      minMessages: 0,
    });
    expect(zero.body.total).toBe(7);
  });

  it("combines all filters with AND", async () => {
    const { client } = mockClient({ items });
    const r = await listConversations(client, {
      projectId: PROJECT,
      channel: "webchat",
      flowName: "Main",
      minMessages: 5,
      startDate: "2026-10-01T00:00:04.000Z",
      endDate: "2026-10-01T00:00:06.000Z",
    });
    expect(idsOf(r)).toEqual(["d"]);
    expect(r.body.total).toBe(1);
  });
});

describe("listConversations: sorting", () => {
  it("sorts newest first by instant, not by string", async () => {
    const { client } = mockClient({
      items: [
        row(1, { _id: "x", startTime: "2026-10-01T10:00:00.000+02:00" }), // 08:00Z
        row(2, { _id: "y", startTime: "2026-10-01T09:00:00.000Z" }),
        row(3, { _id: "z", startTime: "2026-10-01T07:00:00.000Z" }),
      ],
    });
    const r = await listConversations(client, { projectId: PROJECT });
    expect(idsOf(r)).toEqual(["y", "x", "z"]);
  });

  it("breaks ties by descending _id and puts unparseable or missing times last", async () => {
    const same = "2026-10-01T10:00:00.000Z";
    const { client } = mockClient({
      items: [
        row(1, { _id: "a", startTime: same }),
        row(2, { _id: "bad-1", startTime: "garbage" }),
        row(3, { _id: "c", startTime: same }),
        row(4, { _id: "b", startTime: same }),
        row(5, { _id: "bad-2", startTime: undefined }),
        row(6, { _id: "newer", startTime: "2026-10-02T00:00:00.000Z" }),
      ],
    });
    const r = await listConversations(client, { projectId: PROJECT });
    expect(idsOf(r)).toEqual(["newer", "c", "b", "a", "bad-2", "bad-1"]);
  });

  it("is deterministic regardless of input order", async () => {
    const input = many(10);
    const forward = await listConversations(
      mockClient({ items: input }).client,
      {
        projectId: PROJECT,
      },
    );
    const reversed = await listConversations(
      mockClient({ items: [...input].reverse() }).client,
      { projectId: PROJECT },
    );
    expect(idsOf(reversed)).toEqual(idsOf(forward));
    expect(idsOf(forward)).toEqual([
      "session-0010",
      "session-0009",
      "session-0008",
      "session-0007",
      "session-0006",
      "session-0005",
      "session-0004",
      "session-0003",
      "session-0002",
      "session-0001",
    ]);
  });
});

describe("listConversations: paging", () => {
  it("defaults to skip 0 and limit 25", async () => {
    const { client } = mockClient({ items: many(60) });
    const r = await listConversations(client, { projectId: PROJECT });
    expect((r.body.items as any[]).length).toBe(25);
    expect(r.body.skip).toBe(0);
    expect(r.body.limit).toBe(25);
    expect(r.body.total).toBe(60);
    expect(idsOf(r)[0]).toBe("session-0060");
    expect(idsOf(r)[24]).toBe("session-0036");
  });

  it("returns the page at skip with the given limit", async () => {
    const { client } = mockClient({ items: many(60) });
    const r = await listConversations(client, {
      projectId: PROJECT,
      skip: 10,
      limit: 3,
    });
    expect(idsOf(r)).toEqual(["session-0050", "session-0049", "session-0048"]);
    expect(r.body.skip).toBe(10);
    expect(r.body.limit).toBe(3);
  });

  it("clamps a limit above 100 to 100 without error", async () => {
    const { client } = mockClient({ items: many(150) });
    const r = await listConversations(client, {
      projectId: PROJECT,
      limit: 500,
    });
    expect((r.body.items as any[]).length).toBe(100);
    expect(r.body.limit).toBe(100);
    expect(r.body.total).toBe(150);
  });

  it("accepts a limit of exactly 100", async () => {
    const { client } = mockClient({ items: many(150) });
    const r = await listConversations(client, {
      projectId: PROJECT,
      limit: 100,
    });
    expect(r.body.limit).toBe(100);
    expect((r.body.items as any[]).length).toBe(100);
  });

  it("skip past the end gives no items but keeps total", async () => {
    const { client } = mockClient({ items: many(5) });
    const r = await listConversations(client, { projectId: PROJECT, skip: 50 });
    expect(r.body.items).toEqual([]);
    expect(r.body.total).toBe(5);
    expect(r.body.skip).toBe(50);
    expect(r.body.limit).toBe(25);
  });

  it("body has exactly items, total, skip, limit when not truncated", async () => {
    const { client } = mockClient({ items: many(3) });
    const r = await listConversations(client, { projectId: PROJECT });
    expect(Object.keys(r.body).sort()).toEqual([
      "items",
      "limit",
      "skip",
      "total",
    ]);
  });
});

describe("listConversations: MAX_LIST_ROWS truncation", () => {
  it("considers only the first 5000 rows and says so", async () => {
    const { client } = mockClient({ items: many(5001) });
    const r = await listConversations(client, { projectId: PROJECT });
    expect(r.body.truncated).toBe(true);
    expect(r.body.total).toBe(5000);
    expect(String(r.hint?.warning)).toContain("5000");
    expect(String(r.hint?.warning).toLowerCase()).toContain("total");
    expect(String(r.hint?.action)).toContain("contactIds");
  });

  it("the row dropped is the last one in platform order (the first 5000 are kept)", async () => {
    // platform order is newest first in practice; the plugin trusts the order
    // it receives and cuts at the 5000th row, then sorts.
    const rows = many(5001); // session-0001 ... session-5001 in this order
    const { client } = mockClient({ items: rows });
    const r = await listConversations(client, {
      projectId: PROJECT,
      limit: 100,
    });
    expect(idsOf(r)[0]).toBe("session-5000");
    expect(idsOf(r)).not.toContain("session-5001");
  });

  it("exactly 5000 rows is not truncated", async () => {
    const { client } = mockClient({ items: many(5000) });
    const r = await listConversations(client, { projectId: PROJECT });
    expect(r.body.truncated).toBeUndefined();
    expect("truncated" in r.body).toBe(false);
    expect(r.body.total).toBe(5000);
  });
});

describe("listConversations: hints", () => {
  it("names the next page with skip: <skip + items.length>", async () => {
    const { client } = mockClient({ items: many(60) });
    const r = await listConversations(client, { projectId: PROJECT });
    expect(String(r.hint?.action)).toContain("skip: 25");
  });

  it("uses the effective skip and page size for the next page", async () => {
    const { client } = mockClient({ items: many(60) });
    const r = await listConversations(client, {
      projectId: PROJECT,
      skip: 10,
      limit: 20,
    });
    expect(String(r.hint?.action)).toContain("skip: 30");
  });

  it("gives no next-page hint on the last page", async () => {
    const { client } = mockClient({ items: many(30) });
    const r = await listConversations(client, {
      projectId: PROJECT,
      skip: 25,
    });
    expect(String(r.hint?.action ?? "")).not.toContain("skip:");
  });

  it("explains an empty result (no match, maybe no collection)", async () => {
    const { client } = mockClient({ items: [] });
    const r = await listConversations(client, { projectId: PROJECT });
    expect(r.body.total).toBe(0);
    const action = String(r.hint?.action).toLowerCase();
    expect(action).toContain("no conversation matched");
    expect(action).toContain("collect");
  });

  it("filters that match nothing give the same empty-result hint", async () => {
    const { client } = mockClient({ items: many(3) });
    const r = await listConversations(client, {
      projectId: PROJECT,
      channel: "nothing",
    });
    expect(r.body.items).toEqual([]);
    expect(r.body.total).toBe(0);
    expect(String(r.hint?.action).toLowerCase()).toContain(
      "no conversation matched",
    );
  });
});

describe("listConversations: error mapping", () => {
  const SECRET = "UPSTREAM-SECRET-ERROR-TEXT apiKey=abc123";

  it("maps a numeric status to the fixed message with the status", async () => {
    const { client } = failingClient(
      Object.assign(new Error(SECRET), { status: 403 }),
    );
    const err = await listConversations(client, { projectId: PROJECT }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Could not read conversations (HTTP 403).");
    expect(err.message).not.toContain("SECRET");
  });

  it("reads response.status too", async () => {
    const { client } = failingClient({
      message: SECRET,
      response: { status: 502, data: SECRET },
    });
    const err = await listConversations(client, { projectId: PROJECT }).catch(
      (e) => e,
    );
    expect(err.message).toBe("Could not read conversations (HTTP 502).");
  });

  it("without a numeric status gives the plain message", async () => {
    const { client } = failingClient(new Error(SECRET));
    const err = await listConversations(client, { projectId: PROJECT }).catch(
      (e) => e,
    );
    expect(err.message).toBe("Could not read conversations.");
    expect(err.message).not.toContain("UPSTREAM");
  });

  it("a non-numeric status is ignored", async () => {
    const { client } = failingClient({ message: SECRET, status: "403" });
    const err = await listConversations(client, { projectId: PROJECT }).catch(
      (e) => e,
    );
    expect(err.message).toBe("Could not read conversations.");
  });

  it("a non-Error rejection is mapped as well", async () => {
    const { client } = failingClient(SECRET);
    const err = await listConversations(client, { projectId: PROJECT }).catch(
      (e) => e,
    );
    expect(err.message).toBe("Could not read conversations.");
  });
});
