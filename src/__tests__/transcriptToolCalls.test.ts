/**
 * Tool calls in a conversation: the transcript has only an empty bot row marked
 * finishReason "tool_calls" (T9); the tool name exists only in the project log,
 * in the line the tool's Log node writes (T10). These tests pin how markers and
 * log lines are found, parsed and paired, and that nothing but allow-listed
 * tokens reaches the output. Every client is a mock.
 */
import { describe, it, expect, jest } from "@jest/globals";

import { fetchSessionLogLines } from "../tools/logReader.js";
import { getResourceSchema } from "../schemas/tools.js";
import {
  collectToolCalls,
  findToolCallMarkers,
  pairToolCalls,
  parseToolCallLine,
} from "../tools/transcripts/toolCalls.js";
import { readConversation } from "../tools/transcripts/read.js";

const PROJECT = "507f1f77bcf86cd799439011";
const OTHER_PROJECT = "507f1f77bcf86cd799439012";
const SESSION = "session-abc";
const UUID_A = "b014954f-1666-48a4-8f8e-aa8d06e34bb3";
const UUID_B = "7a1d0c52-93e1-4f77-b0a2-5c8e1f6d9a10";

const line = (tool: string, args: string, inputId?: string) =>
  `Flow Node - [tool-call] ${tool} args=[${args}]${inputId ? ` inputId=${inputId}` : ""}`;

describe("parseToolCallLine", () => {
  it("reads the tool, its argument names and the inputId from the real line", () => {
    expect(
      parseToolCallLine(line("get_order_status", "orderNumber", UUID_A)),
    ).toStrictEqual({
      tool: "get_order_status",
      argNames: ["orderNumber"],
      inputId: UUID_A,
    });
  });

  it("reads a line written before the inputId was added (no inputId key)", () => {
    expect(
      parseToolCallLine(line("get_order_status", "orderNumber, zip")),
    ).toStrictEqual({
      tool: "get_order_status",
      argNames: ["orderNumber", "zip"],
    });
  });

  it("treats args=[none] as no arguments", () => {
    expect(parseToolCallLine(line("ping", "none", UUID_A))).toStrictEqual({
      tool: "ping",
      argNames: [],
      inputId: UUID_A,
    });
  });

  it("accepts the line without the 'Flow Node - ' prefix", () => {
    expect(parseToolCallLine("[tool-call] ping args=[a]")).toStrictEqual({
      tool: "ping",
      argNames: ["a"],
    });
  });

  it.each([
    ["not a tool-call line", "hello"],
    ["a tool name with a space", line("bad name", "a")],
    ["a tool name with a bracket", "[tool-call] a] args=[x]"],
    ["an empty tool name", "[tool-call]  args=[a]"],
    ["a tool name over 64 characters", line("t".repeat(65), "a")],
    ["text after the argument list", `${line("ping", "a")} extra`],
    ["a malformed inputId", line("ping", "a", "not-a-uuid")],
    ["no bracketed argument list", "[tool-call] ping args=a"],
    ["a second line smuggled after a newline", `${line("ping", "a")}\nmore`],
  ])("rejects %s", (_name, text) => {
    expect(parseToolCallLine(text)).toBeNull();
  });

  it("keeps at most 20 argument names", () => {
    const names = Array.from({ length: 25 }, (_, i) => `p${i}`);
    const parsed = parseToolCallLine(line("ping", names.join(", ")));
    expect(parsed?.argNames).toStrictEqual(names.slice(0, 20));
  });

  it("keeps an argument name of 40 characters and replaces one of 41", () => {
    const ok = "a".repeat(40);
    const long = "b".repeat(41);
    expect(
      parseToolCallLine(line("ping", `${ok}, ${long}`))?.argNames,
    ).toStrictEqual([ok, "<name>"]);
  });

  it("replaces argument names that look like an address or markup", () => {
    expect(
      parseToolCallLine(line("ping", "a@b.com, <script>, x y"))?.argNames,
    ).toStrictEqual(["<name>", "<name>", "<name>"]);
  });

  it("replaces an argument name that is not a plain identifier", () => {
    expect(
      parseToolCallLine(line("ping", "ok, bad<x>, user.name")),
    ).toStrictEqual({
      tool: "ping",
      argNames: ["ok", "<name>", "user.name"],
    });
  });
});

describe("findToolCallMarkers", () => {
  const marker = (over: Record<string, unknown> = {}) => ({
    type: "output",
    source: "bot",
    timestamp: "2026-10-01T10:00:02.000Z",
    inputId: UUID_A,
    inputText: "",
    inputData: { _cognigy: { _finishReason: "tool_calls" } },
    ...over,
  });

  it("returns one marker per tool_calls row, with its index, timestamp and inputId", () => {
    const rows = [
      { type: "input", source: "user", timestamp: "2026-10-01T10:00:01.000Z" },
      marker(),
      marker({ timestamp: "2026-10-01T10:00:05.000Z" }),
    ];
    expect(findToolCallMarkers(rows)).toStrictEqual([
      {
        messageIndex: 1,
        timestamp: "2026-10-01T10:00:02.000Z",
        timestampMs: Date.parse("2026-10-01T10:00:02.000Z"),
        inputId: UUID_A,
      },
      {
        messageIndex: 2,
        timestamp: "2026-10-01T10:00:05.000Z",
        timestampMs: Date.parse("2026-10-01T10:00:05.000Z"),
        inputId: UUID_A,
      },
    ]);
  });

  it.each([
    [
      "a stop row",
      marker({ inputData: { _cognigy: { _finishReason: "stop" } } }),
    ],
    ["an input row", marker({ type: "input", source: "user" })],
    ["no inputData", marker({ inputData: undefined })],
    ["inputData as a string", marker({ inputData: "tool_calls" })],
    ["inputData as null", marker({ inputData: null })],
    [
      "_cognigy as an array",
      marker({ inputData: { _cognigy: ["tool_calls"] } }),
    ],
    [
      "a finish reason that is not a string",
      marker({ inputData: { _cognigy: { _finishReason: ["tool_calls"] } } }),
    ],
    [
      "a finish reason with extra text",
      marker({ inputData: { _cognigy: { _finishReason: "tool_calls!" } } }),
    ],
  ])("ignores %s", (_name, row) => {
    expect(findToolCallMarkers([row])).toStrictEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["a number", 7],
    ["longer than 64 characters", "x".repeat(65)],
    ["holding a space", "has space"],
  ])("drops an inputId that is %s", (_name, inputId) => {
    const [m] = findToolCallMarkers([marker({ inputId })]);
    expect(m.inputId).toBeUndefined();
  });

  it("re-formats the time: only an ISO date leaves the module, never the row's own string", () => {
    const [m] = findToolCallMarkers([
      marker({ timestamp: "Thu, 01 Oct 2026 10:00:02 GMT" }),
    ]);
    expect(m.timestamp).toBe("2026-10-01T10:00:02.000Z");
    expect(m.timestampMs).toBe(Date.UTC(2026, 9, 1, 10, 0, 2));
  });

  it.each([
    ["before the year 2000", "1999-12-31T23:59:59.000Z"],
    ["at the largest date a Date can hold", "+275760-09-13T00:00:00.000Z"],
    ["after the year 2100", "2100-01-01T00:00:01.000Z"],
  ])("treats a time %s as unreadable", (_name, timestamp) => {
    const [m] = findToolCallMarkers([marker({ timestamp })]);
    expect(m).toStrictEqual({ messageIndex: 0, inputId: UUID_A });
  });

  it("keeps a marker whose timestamp cannot be read, without a time", () => {
    const [m] = findToolCallMarkers([marker({ timestamp: "not a time" })]);
    expect(m.messageIndex).toBe(0);
    expect(m.timestampMs).toBeUndefined();
  });
});

describe("pairToolCalls", () => {
  const m = (
    messageIndex: number,
    timestampMs: number | undefined,
    inputId?: string,
  ) => ({
    messageIndex,
    timestamp: timestampMs === undefined ? undefined : `t${timestampMs}`,
    timestampMs,
    ...(inputId ? { inputId } : {}),
  });
  const l = (
    timestampMs: number,
    tool: string,
    argNames: string[] = [],
    inputId?: string,
  ) => ({ timestampMs, tool, argNames, ...(inputId ? { inputId } : {}) });

  it("pairs by inputId in time order when the counts match, whatever order the lines arrive in", () => {
    const r = pairToolCalls(
      [m(1, 1000, UUID_A), m(3, 2000, UUID_A)],
      [l(2008, "second", ["b"], UUID_A), l(1010, "first", ["a"], UUID_A)],
    );
    expect(r.toolCalls).toStrictEqual([
      {
        messageIndex: 1,
        timestamp: "t1000",
        tool: "first",
        argNames: ["a"],
        matched: "inputId",
      },
      {
        messageIndex: 3,
        timestamp: "t2000",
        tool: "second",
        argNames: ["b"],
        matched: "inputId",
      },
    ]);
    expect(r.unmatchedLogLines).toBe(0);
  });

  it("pairs nothing when a turn has fewer log lines than tool calls", () => {
    const r = pairToolCalls(
      [m(1, 1000, UUID_A), m(3, 2000, UUID_A)],
      [l(1010, "only", ["a"], UUID_A)],
    );
    expect(
      r.toolCalls.map((t) => [t.tool, t.argNames, t.matched]),
    ).toStrictEqual([
      [null, [], "ambiguous"],
      [null, [], "ambiguous"],
    ]);
    expect(r.unmatchedLogLines).toBe(1);
  });

  it("pairs nothing when a turn has more log lines than tool calls", () => {
    const r = pairToolCalls(
      [m(1, 1000, UUID_A)],
      [l(1010, "a", [], UUID_A), l(1500, "b", [], UUID_A)],
    );
    expect(r.toolCalls[0].tool).toBeNull();
    expect(r.toolCalls[0].matched).toBe("ambiguous");
    expect(r.unmatchedLogLines).toBe(2);
  });

  it("matches an inputId whatever its letter case in the row and in the log", () => {
    const r = pairToolCalls(
      [m(1, 1000, UUID_A.toUpperCase())],
      [l(1010, "x", [], UUID_A)],
    );
    expect(r.toolCalls[0].tool).toBe("x");
    expect(r.toolCalls[0].matched).toBe("inputId");
  });

  it("settles a turn that has lines exactly and another that has none by time", () => {
    const r = pairToolCalls(
      [m(1, 1000, UUID_A), m(3, 5000, UUID_B)],
      [l(1010, "first", [], UUID_A), l(5008, "legacy")],
    );
    expect(r.toolCalls.map((t) => [t.tool, t.matched])).toStrictEqual([
      ["first", "inputId"],
      ["legacy", "time"],
    ]);
    expect(r.unmatchedLogLines).toBe(0);
  });

  it("never pairs a marker with a line of another turn", () => {
    const r = pairToolCalls(
      [m(1, 1000, UUID_A)],
      [l(1005, "other", [], UUID_B)],
    );
    expect(r.toolCalls[0].tool).toBeNull();
    expect(r.toolCalls[0].matched).toBe("none");
    expect(r.unmatchedLogLines).toBe(1);
  });

  it("falls back to the nearest line in time for a line without an inputId", () => {
    const r = pairToolCalls([m(1, 1000, UUID_A)], [l(1011, "legacy", ["a"])]);
    expect(r.toolCalls).toStrictEqual([
      {
        messageIndex: 1,
        timestamp: "t1000",
        tool: "legacy",
        argNames: ["a"],
        matched: "time",
      },
    ]);
    expect(r.unmatchedLogLines).toBe(0);
  });

  it("accepts a gap of exactly 2000 ms and refuses 2001 ms", () => {
    const within = pairToolCalls([m(1, 1000)], [l(3000, "x")]);
    const beyond = pairToolCalls([m(1, 1000)], [l(3001, "x")]);
    expect(within.toolCalls[0].tool).toBe("x");
    expect(beyond.toolCalls[0].tool).toBeNull();
    expect(beyond.toolCalls[0].matched).toBe("none");
    expect(beyond.unmatchedLogLines).toBe(1);
  });

  it("does not shift later pairs when a tool in the middle left no line", () => {
    const r = pairToolCalls(
      [m(1, 1000, UUID_A), m(3, 2000, UUID_A), m(5, 3000, UUID_A)],
      [l(1005, "x"), l(3005, "z")],
    );
    expect(r.toolCalls.map((t) => [t.tool, t.matched])).toStrictEqual([
      ["x", "time"],
      [null, "none"],
      ["z", "time"],
    ]);
  });

  it("uses each line once: the nearest marker wins", () => {
    const r = pairToolCalls([m(1, 1000), m(3, 1100)], [l(1090, "x")]);
    expect(r.toolCalls.map((t) => t.tool)).toStrictEqual([null, "x"]);
    expect(r.unmatchedLogLines).toBe(0);
  });

  it("keeps an exact pair and counts a nearby legacy line as unmatched", () => {
    const r = pairToolCalls(
      [m(1, 1000, UUID_A)],
      [l(1005, "legacy"), l(1010, "exact", [], UUID_A)],
    );
    expect(r.toolCalls[0].tool).toBe("exact");
    expect(r.toolCalls[0].matched).toBe("inputId");
    expect(r.unmatchedLogLines).toBe(1);
  });

  it("pairs a marker that has no inputId by time with any unused line", () => {
    const r = pairToolCalls([m(1, 1000)], [l(1008, "x", [], UUID_A)]);
    expect(r.toolCalls[0].tool).toBe("x");
    expect(r.toolCalls[0].matched).toBe("time");
  });

  it("cannot pair a marker without a time and without an inputId", () => {
    const r = pairToolCalls([m(1, undefined)], [l(1000, "x")]);
    expect(r.toolCalls[0].tool).toBeNull();
    expect(r.toolCalls[0].matched).toBe("none");
    expect(r.unmatchedLogLines).toBe(1);
  });

  it("returns an empty list for no markers and counts every line as unmatched", () => {
    const r = pairToolCalls([], [l(1, "x"), l(2, "y")]);
    expect(r.toolCalls).toStrictEqual([]);
    expect(r.unmatchedLogLines).toBe(2);
  });
});

describe("fetchSessionLogLines", () => {
  type Get = (url: string, config?: any) => Promise<any>;
  const entries = (n: number, msg = "m", meta?: Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: `2026-10-01T10:00:${String(i % 60).padStart(2, "0")}.000Z`,
      msg: `${msg}${i}`,
      secretField: "SECRET",
      ...(meta ? { meta } : {}),
    }));
  const args = { projectId: PROJECT, sessionId: SESSION };

  it("asks the session tail with the sessionId only, and returns only timestamp and msg", async () => {
    const get = jest
      .fn<Get>()
      .mockResolvedValue({ items: entries(2, "m", { sessionId: SESSION }) });
    const r = await fetchSessionLogLines({ get }, args);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      `/v2.1/projects/${PROJECT}/logs/tail`,
      expect.objectContaining({ params: { sessionId: SESSION } }),
    );
    expect(r).toStrictEqual({
      ok: true,
      truncated: false,
      lines: [
        { timestamp: "2026-10-01T10:00:00.000Z", msg: "m0" },
        { timestamp: "2026-10-01T10:00:01.000Z", msg: "m1" },
      ],
    });
  });

  it("drops an entry that names another session and keeps one that names this session or none", async () => {
    const get = jest.fn<Get>().mockResolvedValue({
      items: [
        {
          timestamp: "2026-10-01T10:00:00.000Z",
          msg: "own",
          meta: { sessionId: SESSION },
        },
        {
          timestamp: "2026-10-01T10:00:01.000Z",
          msg: "foreign",
          meta: { sessionId: "someone-else" },
        },
        { timestamp: "2026-10-01T10:00:02.000Z", msg: "no-meta" },
        {
          timestamp: "2026-10-01T10:00:03.000Z",
          msg: "meta-without-session",
          meta: { userId: "u" },
        },
      ],
    });
    const r = await fetchSessionLogLines({ get }, args);
    expect(r.ok && r.lines.map((l) => l.msg)).toStrictEqual([
      "own",
      "no-meta",
      "meta-without-session",
    ]);
  });

  it("skips items without a string msg or timestamp", async () => {
    const get = jest.fn<Get>().mockResolvedValue({
      items: [
        { timestamp: "2026-10-01T10:00:00.000Z", msg: "keep" },
        { timestamp: "2026-10-01T10:00:01.000Z", msg: 7 },
        { msg: "no time" },
        null,
      ],
    });
    const r = await fetchSessionLogLines({ get }, args);
    expect(r).toStrictEqual({
      ok: true,
      truncated: false,
      lines: [{ timestamp: "2026-10-01T10:00:00.000Z", msg: "keep" }],
    });
  });

  it("flags truncation at the 100-entry cap of the tail and not below it", async () => {
    const full = jest.fn<Get>().mockResolvedValue({ items: entries(100) });
    const capped = await fetchSessionLogLines({ get: full }, args);
    expect(capped.ok && capped.truncated).toBe(true);
    expect(full).toHaveBeenCalledTimes(1);

    const short = jest.fn<Get>().mockResolvedValue({ items: entries(99) });
    const under = await fetchSessionLogLines({ get: short }, args);
    expect(under.ok && under.truncated).toBe(false);
  });

  it("returns ok false with no upstream text when the request fails", async () => {
    const get = jest.fn<Get>().mockRejectedValue(new Error("UPSTREAM-SECRET"));
    const r = await fetchSessionLogLines({ get }, args);
    expect(r).toStrictEqual({ ok: false });
  });
});

describe("readConversation with includeToolCalls", () => {
  type Get = (url: string, config?: any) => Promise<any>;
  const iso = (seconds: number, ms = 0) =>
    new Date(Date.UTC(2026, 9, 1, 10, 0, 0, ms) + seconds * 1000).toISOString();

  const row = (n: number, over: Record<string, unknown> = {}) => ({
    _id: `msg-${n}`,
    projectId: PROJECT,
    inputId: UUID_A,
    sessionId: SESSION,
    inputText: n % 2 === 1 ? "user words" : "",
    inputData: {},
    type: n % 2 === 1 ? "input" : "output",
    source: n % 2 === 1 ? "user" : "bot",
    timestamp: iso(n),
    ...over,
  });
  const MARKER = { _cognigy: { _finishReason: "tool_calls" } };
  // 1 user input, 2 tool-call marker, 3 final answer
  const conversation = (over: Record<string, unknown> = {}) => ({
    items: [
      row(1),
      row(2, { inputData: MARKER, ...over }),
      row(3, { inputText: "the answer", type: "output", source: "bot" }),
    ],
    total: 3,
  });

  const route = (
    conv: unknown,
    logs: unknown | Error = { items: [], total: 0 },
  ) =>
    jest.fn<Get>().mockImplementation(async (url: string) => {
      if (url.startsWith("/v2.0/conversations/")) return conv;
      if (url.includes("/logs")) {
        if (logs instanceof Error) throw logs;
        return logs;
      }
      throw new Error(`unexpected ${url}`);
    });

  const logItem = (
    seconds: number,
    ms: number,
    msg: string,
    sessionId: string = SESSION,
  ) => ({
    timestamp: iso(seconds, ms),
    msg,
    flowId: "f",
    meta: { sessionId },
  });
  const RETENTION =
    "Tool names come from the project log, which keeps entries only for a limited time (typically about 24 hours), and only for tools built with the tool-call Log node.";

  it("adds the tool, its argument names and how it was matched", async () => {
    const get = route(conversation(), {
      items: [logItem(2, 11, line("get_order_status", "orderNumber", UUID_A))],
      total: 1,
    });
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect(r.body.toolCalls).toStrictEqual([
      {
        messageIndex: 1,
        timestamp: iso(2),
        tool: "get_order_status",
        argNames: ["orderNumber"],
        matched: "inputId",
      },
    ]);
    expect(r.body.unmatchedToolLogs).toBe(0);
    expect(r.hint?.action).toContain(RETENTION);
  });

  it("reads the log of this session only: one tail request, never the project-wide window", async () => {
    const get = route(conversation(), { items: [] });
    await readConversation({ get }, { id: SESSION, includeToolCalls: true });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toBe(`/v2.0/conversations/${SESSION}`);
    expect(get.mock.calls[1][0]).toBe(`/v2.1/projects/${PROJECT}/logs/tail`);
    expect(get.mock.calls[1][1].params).toStrictEqual({ sessionId: SESSION });
  });

  it("makes one tail request however far apart the tool calls are", async () => {
    const conv = {
      items: [
        row(1),
        row(2, { inputData: MARKER }),
        row(200, { inputData: MARKER }),
      ],
    };
    const get = route(conv, { items: [] });
    await readConversation({ get }, { id: SESSION, includeToolCalls: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("never gives a tool call the name from another session's line, even one a few milliseconds from its marker", async () => {
    const get = route(conversation(), {
      items: [
        logItem(
          2,
          11,
          line("someone_elses_tool", "secretArg"),
          "another-session",
        ),
      ],
    });
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect(r.body.toolCalls).toStrictEqual([
      {
        messageIndex: 1,
        timestamp: iso(2),
        tool: null,
        argNames: [],
        matched: "none",
      },
    ]);
    expect(r.body.unmatchedToolLogs).toBe(0);
    expect(JSON.stringify(r)).not.toContain("someone_elses_tool");
    expect(JSON.stringify(r)).not.toContain("secretArg");
  });

  it("still pairs by inputId when the tool call has no readable time", async () => {
    const conv = {
      items: [
        row(1),
        row(2, { inputData: MARKER, timestamp: "+275760-09-13T00:00:00.000Z" }),
      ],
    };
    const get = route(conv, {
      items: [logItem(2, 11, line("get_order_status", "orderNumber", UUID_A))],
    });
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect(get).toHaveBeenCalledTimes(2);
    expect(r.body.toolCalls).toStrictEqual([
      {
        messageIndex: 1,
        tool: "get_order_status",
        argNames: ["orderNumber"],
        matched: "inputId",
      },
    ]);
  });

  it("says older names may be missing when the session log is at its 100-entry cap", async () => {
    const full = {
      items: Array.from({ length: 100 }, (_, i) => logItem(2, i, "unrelated")),
    };
    const get = route(conversation(), full);
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect(get).toHaveBeenCalledTimes(2);
    expect(r.hint?.action).toContain(
      "The session log holds only its newest 100 entries, so names for older tool calls may be missing.",
    );
  });

  it("never returns a hostile argument name or a long time from the row", async () => {
    const get = route(
      conversation({ timestamp: "Thu, 01 Oct 2026 10:00:02 GMT" }),
      {
        items: [
          logItem(
            2,
            11,
            line("get_order_status", `a@b.com, ${"z".repeat(60)}`, UUID_A),
          ),
        ],
      },
    );
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    const text = JSON.stringify(r);
    expect(text).not.toContain("a@b.com");
    expect(text).not.toContain("zzzzzzzzzz");
    expect((r.body.toolCalls as any[])[0].argNames).toStrictEqual([
      "<name>",
      "<name>",
    ]);
    expect((r.body.toolCalls as any[])[0].timestamp).toBe(
      "2026-10-01T10:00:02.000Z",
    );
  });

  it("prefers the projectId argument over the one on the rows", async () => {
    const get = route(conversation(), { items: [] });
    await readConversation(
      { get },
      { id: SESSION, projectId: OTHER_PROJECT, includeToolCalls: true },
    );
    expect(get.mock.calls[1][0]).toBe(
      `/v2.1/projects/${OTHER_PROJECT}/logs/tail`,
    );
  });

  it("never returns the inputId, the raw log line or any other row field", async () => {
    const get = route(conversation({ endpointUrlToken: "TOKEN-SECRET" }), {
      items: [logItem(2, 11, line("get_order_status", "orderNumber", UUID_A))],
    });
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    const text = JSON.stringify(r);
    for (const forbidden of [
      UUID_A,
      "Flow Node",
      "[tool-call]",
      "TOKEN-SECRET",
      "inputId=",
      '"inputId":',
      "inputData",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("makes no log request when there is no tool call, and returns an empty list", async () => {
    const get = route({ items: [row(1), row(2, { inputText: "hi" })] });
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(r.body.toolCalls).toStrictEqual([]);
  });

  it("adds nothing and makes one request without the flag", async () => {
    const get = route(conversation());
    const r = await readConversation({ get }, { id: SESSION });
    expect(get).toHaveBeenCalledTimes(1);
    expect(r.body).not.toHaveProperty("toolCalls");
    expect(r.body).not.toHaveProperty("unmatchedToolLogs");
  });

  it("shows the markers with no tool and a fixed hint when the log cannot be read, without echoing the error", async () => {
    const get = route(conversation(), new Error("UPSTREAM-SECRET"));
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect(r.body.toolCalls).toStrictEqual([
      {
        messageIndex: 1,
        timestamp: iso(2),
        tool: null,
        argNames: [],
        matched: "none",
      },
    ]);
    expect(r.hint?.action).toContain(
      "The project log could not be read, so tool names are not shown.",
    );
    expect(JSON.stringify(r)).not.toContain("UPSTREAM-SECRET");
  });

  it("makes no log request without a projectId and says to pass one", async () => {
    const conv = {
      items: [
        row(1, { projectId: undefined }),
        row(2, { projectId: undefined, inputData: MARKER }),
      ],
    };
    const get = route(conv);
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(r.body.toolCalls).toStrictEqual([
      {
        messageIndex: 1,
        timestamp: iso(2),
        tool: null,
        argNames: [],
        matched: "none",
      },
    ]);
    expect(r.hint?.action).toContain(
      "Pass projectId to look up tool names in the project log.",
    );
  });

  it("explains a best-effort time match, which can only be among this session's own lines", async () => {
    const get = route(conversation(), {
      items: [logItem(2, 11, line("get_order_status", "orderNumber"))],
    });
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect((r.body.toolCalls as any[])[0].matched).toBe("time");
    expect(r.hint?.action).toContain(
      'Entries marked matched "time" are a best-effort match by time.',
    );
  });

  it("reports log lines that matched no tool call", async () => {
    const get = route(conversation(), {
      items: [
        logItem(2, 11, line("get_order_status", "orderNumber", UUID_A)),
        logItem(60, 0, line("other_tool", "x", UUID_B)),
      ],
    });
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect(r.body.unmatchedToolLogs).toBe(1);
  });

  it("ignores log lines that are not valid tool-call lines", async () => {
    const get = route(conversation(), {
      items: [
        logItem(2, 5, "[tool-call] bad name args=[a]"),
        logItem(2, 5, "Sent output to Endpoint"),
        logItem(2, 11, line("get_order_status", "orderNumber", UUID_A)),
      ],
    });
    const r = await readConversation(
      { get },
      { id: SESSION, includeToolCalls: true },
    );
    expect((r.body.toolCalls as any[])[0].tool).toBe("get_order_status");
    expect(r.body.unmatchedToolLogs).toBe(0);
  });
});

describe("collectToolCalls: session scope", () => {
  type Get = (url: string, config?: any) => Promise<any>;
  const base = Date.UTC(2026, 9, 1, 10, 0, 0);
  const markerRow = (i: number, over: Record<string, unknown> = {}) => ({
    type: "output",
    projectId: PROJECT,
    timestamp: new Date(base + i * 100_000).toISOString(),
    inputData: { _cognigy: { _finishReason: "tool_calls" } },
    ...over,
  });
  const logLine = (
    i: number,
    msg: string,
    sessionId: string | undefined = SESSION,
  ) => ({
    timestamp: new Date(base + i * 100_000 + 11).toISOString(),
    msg,
    ...(sessionId ? { meta: { sessionId } } : {}),
  });

  it("makes no request without a tool call", async () => {
    const get = jest.fn<Get>();
    const r = await collectToolCalls({ get }, [{ type: "input" }], {
      projectId: PROJECT,
      sessionId: SESSION,
    });
    expect(get).not.toHaveBeenCalled();
    expect(r.logRead).toBe("skipped");
  });

  it("needs a projectId, from the call or from a row", async () => {
    const get = jest.fn<Get>().mockResolvedValue({ items: [] });
    const none = await collectToolCalls(
      { get },
      [markerRow(0, { projectId: undefined })],
      { sessionId: SESSION },
    );
    expect(none.logRead).toBe("noProject");
    expect(get).not.toHaveBeenCalled();

    const fromRow = await collectToolCalls({ get }, [markerRow(0)], {
      sessionId: SESSION,
    });
    expect(fromRow.logRead).toBe("ok");
    expect(get.mock.calls[0][0]).toBe(`/v2.1/projects/${PROJECT}/logs/tail`);
  });

  it("refuses a projectId that is not 24 hex characters before any request", async () => {
    const get = jest.fn<Get>();
    const r = await collectToolCalls({ get }, [markerRow(0)], {
      projectId: "../../etc",
      sessionId: SESSION,
    });
    expect(r.logRead).toBe("noProject");
    expect(get).not.toHaveBeenCalled();
  });

  it("pairs a legacy line by time among the session's own lines only", async () => {
    const get = jest.fn<Get>().mockResolvedValue({
      items: [
        logLine(0, line("own_tool", "a")),
        logLine(0, line("foreign_tool", "b"), "other-session"),
      ],
    });
    const r = await collectToolCalls({ get }, [markerRow(0)], {
      projectId: PROJECT,
      sessionId: SESSION,
    });
    expect(r.toolCalls.map((t) => [t.tool, t.matched])).toStrictEqual([
      ["own_tool", "time"],
    ]);
    expect(r.unmatchedLogLines).toBe(0);
  });

  it("flags truncation when the session log is at its cap", async () => {
    const get = jest.fn<Get>().mockResolvedValue({
      items: Array.from({ length: 100 }, (_, i) => logLine(0, `m${i}`)),
    });
    const r = await collectToolCalls({ get }, [markerRow(0)], {
      projectId: PROJECT,
      sessionId: SESSION,
    });
    expect(r.truncated).toBe(true);
  });

  it("fails as a whole, with no names, when the request fails", async () => {
    const get = jest.fn<Get>().mockRejectedValue(new Error("UPSTREAM-SECRET"));
    const r = await collectToolCalls({ get }, [markerRow(0)], {
      projectId: PROJECT,
      sessionId: SESSION,
    });
    expect(r.logRead).toBe("failed");
    expect(r.toolCalls[0].tool).toBeNull();
  });
});

describe("get_resource schema: includeToolCalls", () => {
  const base = { resourceType: "conversation", id: SESSION };

  it("accepts a boolean for a conversation", () => {
    expect(
      getResourceSchema.safeParse({ ...base, includeToolCalls: true }).success,
    ).toBe(true);
  });

  it("rejects a non-boolean", () => {
    expect(
      getResourceSchema.safeParse({ ...base, includeToolCalls: "yes" }).success,
    ).toBe(false);
  });

  it("refuses it with raw: true, which returns the platform record as is", () => {
    const r = getResourceSchema.safeParse({
      ...base,
      raw: true,
      includeToolCalls: true,
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      "includeToolCalls cannot be combined with raw: true, which returns the platform record as is.",
    );
  });

  it("refuses it for any other resource type", () => {
    const r = getResourceSchema.safeParse({
      resourceType: "agent",
      id: "a".repeat(24),
      includeToolCalls: true,
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      "includeToolCalls applies only to resourceType 'conversation'.",
    );
  });
});
