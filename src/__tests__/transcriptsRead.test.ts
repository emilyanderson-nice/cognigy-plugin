/**
 * readConversation: reads one conversation (one item per message) and returns
 * an outline (no text) or a scrubbed text view. The client is a mock; nothing
 * here touches a real Cognigy environment.
 */
import { describe, it, expect, jest } from "@jest/globals";

import {
  readConversation,
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  DEFAULT_TEXT_CHARS,
} from "../tools/transcripts/read.js";

const PROJECT = "507f1f77bcf86cd799439011";
const SESSION = "session-abc";

type Get = (url: string, config?: any) => Promise<any>;

const mockClient = (response: unknown) => {
  const get = jest.fn<Get>().mockResolvedValue(response);
  return { client: { get }, get };
};

const failingClient = (error: unknown) => {
  const get = jest.fn<Get>().mockRejectedValue(error);
  return { client: { get }, get };
};

const iso = (seconds: number, ms = 0) =>
  new Date(Date.UTC(2026, 9, 1, 10, 0, 0, ms) + seconds * 1000).toISOString();

/** A platform message item. Odd n is the user's input, even n the bot's output. */
const item = (n: number, overrides: Record<string, unknown> = {}) => ({
  _id: `msg-${n}`,
  projectId: PROJECT,
  projectName: "Secret Project Name",
  inputId: "INPUT-ID-SECRET",
  outputId: "OUTPUT-ID-SECRET",
  sessionId: SESSION,
  contactId: "CONTACT-SECRET",
  organisation: "ORGANISATION-SECRET",
  inputText: `message ${n}`,
  inputData: { secretKey: "INPUTDATA-SECRET" },
  inputAttachments: [{ url: "ATTACHMENT-SECRET" }],
  type: n % 2 === 1 ? "input" : "output",
  source: n % 2 === 1 ? "user" : "bot",
  timestamp: iso(n),
  flowName: "Main",
  channel: "webchat",
  isMasked: false,
  isRedundant: false,
  flowHistory: [{ node: "FLOWHISTORY-SECRET" }],
  endpointUrlToken: "TOKEN-SECRET",
  endpointName: "Endpoint A",
  localeName: "LOCALE-SECRET",
  localeReferenceId: "LOCALEREF-SECRET",
  expiresAt: "EXPIRES-SECRET",
  ...overrides,
});

const items = (count: number) =>
  Array.from({ length: count }, (_, i) => item(i + 1));

const FORBIDDEN_VALUES = [
  "TOKEN-SECRET",
  "ORGANISATION-SECRET",
  "CONTACT-SECRET",
  "INPUT-ID-SECRET",
  "OUTPUT-ID-SECRET",
  "FLOWHISTORY-SECRET",
  "LOCALE-SECRET",
  "LOCALEREF-SECRET",
  "EXPIRES-SECRET",
  "INPUTDATA-SECRET",
  "ATTACHMENT-SECRET",
  "Secret Project Name",
  PROJECT,
];
const FORBIDDEN_KEYS = [
  "endpointUrlToken",
  "organisation",
  "contactId",
  "projectId",
  "projectName",
  "inputId",
  "outputId",
  "flowHistory",
  "_id",
  "localeName",
  "localeReferenceId",
  "expiresAt",
  "inputData",
  "inputAttachments",
  "slots",
  "slotMatches",
];

const msgs = (r: { body: Record<string, unknown> }) => r.body.messages as any[];

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

describe("readConversation: validation before any request", () => {
  it.each([undefined, ""])("refuses id %p without a request", async (id) => {
    const { client, get } = mockClient({ items: [] });
    await expect(readConversation(client, { id })).rejects.toThrow(
      new Error(
        "id (the session id) is required for resourceType 'conversation'.",
      ),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it.each([undefined, "outline"] as const)(
    "refuses rawText with view %p (outline) without a request",
    async (view) => {
      const { client, get } = mockClient({ items: [] });
      await expect(
        readConversation(client, { id: SESSION, view, rawText: true }),
      ).rejects.toThrow(new Error("rawText is only supported with view text."));
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("allows rawText false with the outline view", async () => {
    const { client, get } = mockClient({ items: items(1) });
    const r = await readConversation(client, { id: SESSION, rawText: false });
    expect(get).toHaveBeenCalledTimes(1);
    expect(r.body.view).toBe("outline");
  });

  it("exports the documented constants", () => {
    expect(DEFAULT_MESSAGE_LIMIT).toBe(50);
    expect(MAX_MESSAGE_LIMIT).toBe(100);
    expect(DEFAULT_TEXT_CHARS).toBe(500);
  });
});

describe("readConversation: the one request", () => {
  it("sends one request with an empty params object when nothing applies", async () => {
    const { client, get } = mockClient({ items: items(1) });
    await readConversation(client, { id: SESSION });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe("/v2.0/conversations/session-abc");
    expect(get.mock.calls[0][1]).toEqual({ params: {} });
  });

  it("encodes the id in the URL", async () => {
    const { client, get } = mockClient({ items: [] });
    await readConversation(client, { id: "a/b c?d#e" });
    expect(get.mock.calls[0][0]).toBe("/v2.0/conversations/a%2Fb%20c%3Fd%23e");
  });

  it("sends projectId only when given", async () => {
    const { client, get } = mockClient({ items: items(1) });
    await readConversation(client, { id: SESSION, projectId: PROJECT });
    expect(get.mock.calls[0][1]).toEqual({ params: { projectId: PROJECT } });
  });

  it("sends expertMode only when true", async () => {
    const t = mockClient({ items: items(1) });
    await readConversation(t.client, { id: SESSION, expertMode: true });
    expect(t.get.mock.calls[0][1]).toEqual({ params: { expertMode: true } });
    const f = mockClient({ items: items(1) });
    await readConversation(f.client, { id: SESSION, expertMode: false });
    expect(f.get.mock.calls[0][1]).toEqual({ params: {} });
  });

  it("sends both, and never limit, skip, view, rawText or msgChars", async () => {
    const { client, get } = mockClient({ items: items(1) });
    await readConversation(client, {
      id: SESSION,
      projectId: PROJECT,
      expertMode: true,
      view: "text",
      limit: 5,
      skip: 1,
      msgChars: 200,
      rawText: true,
    });
    expect(get.mock.calls[0][1]).toEqual({
      params: { projectId: PROJECT, expertMode: true },
    });
    expect(Object.keys(get.mock.calls[0][1].params).sort()).toEqual([
      "expertMode",
      "projectId",
    ]);
  });
});

describe("readConversation: ordering and common keys", () => {
  it("orders by timestamp ascending; missing or unparseable sort last; the original order breaks ties", async () => {
    const { client } = mockClient({
      items: [
        item(1, { _id: "late", timestamp: iso(30) }),
        item(2, { _id: "bad", timestamp: "garbage" }),
        item(3, { _id: "tie-a", timestamp: iso(10) }),
        item(4, { _id: "missing", timestamp: undefined }),
        item(5, { _id: "early", timestamp: iso(5) }),
        item(6, { _id: "tie-b", timestamp: iso(10) }),
      ],
    });
    const r = await readConversation(client, { id: SESSION, view: "text" });
    expect(msgs(r).map((m) => m.text)).toEqual([
      "message 5",
      "message 3",
      "message 6",
      "message 1",
      "message 2",
      "message 4",
    ]);
    expect(msgs(r).map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("compares timestamps as instants", async () => {
    const { client } = mockClient({
      items: [
        item(1, { timestamp: "2026-10-01T10:00:00.000+02:00" }), // 08:00Z
        item(2, { timestamp: "2026-10-01T09:00:00.000Z" }),
      ],
    });
    const r = await readConversation(client, { id: SESSION, view: "text" });
    expect(msgs(r).map((m) => m.text)).toEqual(["message 1", "message 2"]);
  });

  it("uses the response itself when it is an array", async () => {
    const { client } = mockClient([item(2), item(1)]);
    const r = await readConversation(client, { id: SESSION, view: "text" });
    expect(r.body.messageCount).toBe(2);
    expect(msgs(r).map((m) => m.text)).toEqual(["message 1", "message 2"]);
  });

  it("builds the common keys from the first item that has each value", async () => {
    const { client } = mockClient({
      items: [
        {
          _id: "m1",
          sessionId: "real-session",
          inputText: "one",
          type: "input",
          source: "user",
          timestamp: iso(0),
        },
        {
          _id: "m2",
          inputText: "two",
          type: "output",
          source: "bot",
          timestamp: iso(10),
          channel: "voice",
          flowName: "Second",
          endpointName: "Endpoint B",
        },
        {
          _id: "m3",
          inputText: "three",
          type: "output",
          source: "bot",
          timestamp: iso(90, 999),
          channel: "ignored",
          flowName: "Ignored",
          endpointName: "Ignored",
          sessionId: "ignored",
        },
      ],
    });
    const r = await readConversation(client, { id: "id-argument" });
    expect(r.body.sessionId).toBe("real-session");
    expect(r.body.channel).toBe("voice");
    expect(r.body.flowName).toBe("Second");
    expect(r.body.endpointName).toBe("Endpoint B");
    expect(r.body.startTime).toBe(iso(0));
    expect(r.body.endTime).toBe(iso(90, 999));
    expect(r.body.durationSeconds).toBe(90);
  });

  it("falls back to the id argument when no item has a sessionId", async () => {
    const { client } = mockClient({
      items: [item(1, { sessionId: undefined })],
    });
    const r = await readConversation(client, { id: "id-argument" });
    expect(r.body.sessionId).toBe("id-argument");
  });

  it("rounds the duration down to whole seconds", async () => {
    const { client } = mockClient({
      items: [
        item(1, { timestamp: "2026-10-01T10:00:00.000Z" }),
        item(2, { timestamp: "2026-10-01T10:00:01.999Z" }),
      ],
    });
    const r = await readConversation(client, { id: SESSION });
    expect(r.body.durationSeconds).toBe(1);
  });

  it("a single item has duration 0 and equal start and end", async () => {
    const { client } = mockClient({ items: [item(1)] });
    const r = await readConversation(client, { id: SESSION });
    expect(r.body.durationSeconds).toBe(0);
    expect(r.body.startTime).toBe(iso(1));
    expect(r.body.endTime).toBe(iso(1));
  });

  it("takes endTime and the duration from the last ordered item with a parseable timestamp", async () => {
    const { client } = mockClient({
      items: [
        item(1, { timestamp: iso(0) }),
        item(2, { timestamp: iso(45) }),
        item(3, { timestamp: "garbage" }),
      ],
    });
    const r = await readConversation(client, { id: SESSION });
    expect(r.body.startTime).toBe(iso(0));
    expect(r.body.endTime).toBe(iso(45));
    expect(r.body.durationSeconds).toBe(45);
    expect(r.body.messageCount).toBe(3);
  });

  it("omits startTime, endTime and durationSeconds when every timestamp is unparseable", async () => {
    const { client } = mockClient({
      items: [
        item(1, { timestamp: "garbage" }),
        item(2, { timestamp: "also bad" }),
      ],
    });
    const r = await readConversation(client, { id: SESSION });
    expect("startTime" in r.body).toBe(false);
    expect("endTime" in r.body).toBe(false);
    expect("durationSeconds" in r.body).toBe(false);
    expect(r.body.messageCount).toBe(2);
  });

  it("omits startTime, endTime and durationSeconds when no timestamp parses", async () => {
    const { client } = mockClient({
      items: [
        item(1, { timestamp: "garbage" }),
        item(2, { timestamp: undefined }),
      ],
    });
    const r = await readConversation(client, { id: SESSION });
    expect("startTime" in r.body).toBe(false);
    expect("endTime" in r.body).toBe(false);
    expect("durationSeconds" in r.body).toBe(false);
    expect(r.body.messageCount).toBe(2);
  });

  it("has exactly the documented body keys", async () => {
    const { client } = mockClient({ items: items(3) });
    const r = await readConversation(client, { id: SESSION });
    expect(Object.keys(r.body).sort()).toEqual(
      [
        "sessionId",
        "channel",
        "flowName",
        "endpointName",
        "startTime",
        "endTime",
        "durationSeconds",
        "messageCount",
        "bySource",
        "skip",
        "limit",
        "returned",
        "view",
        "messages",
      ].sort(),
    );
  });
});

describe("readConversation: counts and paging", () => {
  it("counts bySource over ALL items, not just the page", async () => {
    const { client } = mockClient({
      items: [
        item(1, { source: "user" }),
        item(2, { source: "bot" }),
        item(3, { source: "user" }),
        item(4, { source: "agent" }),
        item(5, { source: "user" }),
        item(6, { source: "bot" }),
      ],
    });
    const r = await readConversation(client, { id: SESSION, limit: 2 });
    expect(r.body.bySource).toEqual({ user: 3, bot: 2, agent: 1 });
    expect(r.body.messageCount).toBe(6);
    expect(r.body.returned).toBe(2);
    expect(msgs(r).length).toBe(2);
  });

  it("defaults to skip 0 and limit 50", async () => {
    const { client } = mockClient({ items: items(120) });
    const r = await readConversation(client, { id: SESSION });
    expect(r.body.skip).toBe(0);
    expect(r.body.limit).toBe(50);
    expect(r.body.returned).toBe(50);
    expect(r.body.messageCount).toBe(120);
    expect(msgs(r)[0].index).toBe(0);
    expect(msgs(r)[49].index).toBe(49);
  });

  it("clamps a limit above 100 to 100 without error", async () => {
    const { client } = mockClient({ items: items(150) });
    const r = await readConversation(client, { id: SESSION, limit: 1000 });
    expect(r.body.limit).toBe(100);
    expect(r.body.returned).toBe(100);
  });

  it("keeps outline indexes stable across pages", async () => {
    const all = items(120);
    const first = await readConversation(mockClient({ items: all }).client, {
      id: SESSION,
      skip: 0,
      limit: 100,
    });
    const second = await readConversation(mockClient({ items: all }).client, {
      id: SESSION,
      skip: 100,
      limit: 100,
    });
    expect(msgs(first)[99].index).toBe(99);
    expect(msgs(second).map((m) => m.index)).toEqual(
      Array.from({ length: 20 }, (_, i) => 100 + i),
    );
    expect(second.body.returned).toBe(20);
    expect(second.body.skip).toBe(100);
  });

  it("skip past the end returns an empty page but the full count", async () => {
    const { client } = mockClient({ items: items(5) });
    const r = await readConversation(client, { id: SESSION, skip: 50 });
    expect(r.body.messages).toEqual([]);
    expect(r.body.returned).toBe(0);
    expect(r.body.messageCount).toBe(5);
  });

  it("names the next page with skip: <skip + returned>", async () => {
    const { client } = mockClient({ items: items(120) });
    const r = await readConversation(client, { id: SESSION });
    expect(String(r.hint?.action)).toContain("skip: 50");
    const second = await readConversation(
      mockClient({ items: items(120) }).client,
      { id: SESSION, skip: 20, limit: 30 },
    );
    expect(String(second.hint?.action)).toContain("skip: 50");
  });

  it("gives no next-page hint on the last page", async () => {
    const { client } = mockClient({ items: items(120) });
    const r = await readConversation(client, {
      id: SESSION,
      skip: 100,
      limit: 100,
    });
    expect(String(r.hint?.action ?? "")).not.toContain("skip:");
  });
});

describe("readConversation: outline view", () => {
  const SECRET_TEXT = "ZEBRA-SECRET-TEXT";

  it("is the default view", async () => {
    const { client } = mockClient({ items: items(1) });
    const r = await readConversation(client, { id: SESSION });
    expect(r.body.view).toBe("outline");
  });

  it("returns exactly index, type, source, timestamp, textChars per message", async () => {
    const { client } = mockClient({
      items: [item(1, { inputText: SECRET_TEXT })],
    });
    const r = await readConversation(client, { id: SESSION });
    expect(Object.keys(msgs(r)[0])).toEqual([
      "index",
      "type",
      "source",
      "timestamp",
      "textChars",
    ]);
    expect(msgs(r)[0]).toEqual({
      index: 0,
      type: "input",
      source: "user",
      timestamp: iso(1),
      textChars: 17,
    });
  });

  it("textChars is 0 when inputText is not a string", async () => {
    const { client } = mockClient({
      items: [
        item(1, { inputText: undefined }),
        item(2, { inputText: 12345 }),
        item(3, { inputText: null }),
        item(4, { inputText: { a: SECRET_TEXT } }),
        item(5, { inputText: "" }),
      ],
    });
    const r = await readConversation(client, { id: SESSION });
    expect(msgs(r).map((m) => m.textChars)).toEqual([0, 0, 0, 0, 0]);
    expect(JSON.stringify(r)).not.toContain(SECRET_TEXT);
  });

  it("textChars counts characters of the whole text, not a cut", async () => {
    const { client } = mockClient({
      items: [item(1, { inputText: "x".repeat(1234) })],
    });
    const r = await readConversation(client, { id: SESSION, msgChars: 100 });
    expect(msgs(r)[0].textChars).toBe(1234);
  });

  it("contains no message text anywhere in the result, hint included", async () => {
    const { client } = mockClient({
      items: [
        item(1, { inputText: `${SECRET_TEXT} one` }),
        item(2, { inputText: `${SECRET_TEXT} two` }),
        item(3, { inputText: `${SECRET_TEXT} three` }),
      ],
    });
    const r = await readConversation(client, {
      id: SESSION,
      expertMode: true,
      limit: 1,
    });
    expect(JSON.stringify(r)).not.toContain("ZEBRA");
    expect(JSON.stringify(r)).not.toContain("SECRET-TEXT");
    expect(JSON.stringify(r)).not.toContain(" three");
  });

  it('the hint mentions view: "text" exactly once', async () => {
    const one = await readConversation(mockClient({ items: items(3) }).client, {
      id: SESSION,
    });
    expect(count(String(one.hint?.action), 'view: "text"')).toBe(1);
    const paged = await readConversation(
      mockClient({ items: items(120) }).client,
      { id: SESSION },
    );
    expect(count(String(paged.hint?.action), 'view: "text"')).toBe(1);
  });
});

describe("readConversation: text view", () => {
  const read = async (texts: unknown[], opts: Record<string, unknown> = {}) => {
    const { client } = mockClient({
      items: texts.map((t, i) => item(i + 1, { inputText: t })),
    });
    return readConversation(client, { id: SESSION, view: "text", ...opts });
  };

  it("returns exactly index, type, source, timestamp, text per message", async () => {
    const r = await read(["hello"]);
    expect(Object.keys(msgs(r)[0])).toEqual([
      "index",
      "type",
      "source",
      "timestamp",
      "text",
    ]);
    expect(msgs(r)[0]).toEqual({
      index: 0,
      type: "input",
      source: "user",
      timestamp: iso(1),
      text: "hello",
    });
    expect(r.body.view).toBe("text");
  });

  it("scrubs emails, long digit runs and phone numbers, and collapses whitespace", async () => {
    const r = await read([
      "mail me at jane.doe@example.com please",
      "my account is 4155550123 ok",
      "call 415-555-0123 now",
      "  lots   of\n\tspace  ",
    ]);
    expect(msgs(r).map((m) => m.text)).toEqual([
      "mail me at <email> please",
      "my account is <digits> ok",
      "call <phone> now",
      "lots of space",
    ]);
  });

  it("masks currency amounts and spoken digit runs", async () => {
    const r = await read([
      "I paid $1,234.56 yesterday",
      "pin is one two three four",
    ]);
    expect(msgs(r).map((m) => m.text)).toEqual([
      "I paid <amount> yesterday",
      "pin is <digits>",
    ]);
  });

  it("a non-string inputText gives an empty text", async () => {
    const r = await read([undefined, 42, null, { a: 1 }]);
    expect(msgs(r).map((m) => m.text)).toEqual(["", "", "", ""]);
  });

  it("cuts to 500 characters by default, ending with an ellipsis", async () => {
    const long = "word ".repeat(200); // 1000 characters
    const r = await read([long]);
    const expected = `${long.trim().slice(0, 499)}…`;
    expect(msgs(r)[0].text).toBe(expected);
    expect(msgs(r)[0].text.length).toBe(500);
  });

  it("cuts to msgChars when given", async () => {
    const long = "word ".repeat(200);
    const r = await read([long], { msgChars: 120 });
    expect(msgs(r)[0].text).toBe(`${long.trim().slice(0, 119)}…`);
    expect(msgs(r)[0].text.length).toBe(120);
  });

  it("clamps msgChars below 100 up to 100", async () => {
    const long = "word ".repeat(100); // 500 characters
    const r = await read([long], { msgChars: 10 });
    expect(msgs(r)[0].text.length).toBe(100);
    expect(msgs(r)[0].text.endsWith("…")).toBe(true);
  });

  it("does not cut a text that fits", async () => {
    const r = await read(["short text"], { msgChars: 100 });
    expect(msgs(r)[0].text).toBe("short text");
  });

  it("the hint always carries the personal-data advice", async () => {
    const r = await read(["hello"]);
    const action = String(r.hint?.action).toLowerCase();
    expect(action).toContain("personal data");
    expect(action).toContain("counts");
    expect(action).toContain("topics");
    expect(action).toContain("quot");
    expect(action).toContain("files");
    expect(action).toContain("commits");
    expect(action).toContain("prompts");
  });

  it("the advice is also present when a next-page hint is added", async () => {
    const { client } = mockClient({ items: items(120) });
    const r = await readConversation(client, { id: SESSION, view: "text" });
    const action = String(r.hint?.action);
    expect(action).toContain("skip: 50");
    expect(action.toLowerCase()).toContain("personal data");
  });

  it("the default hint does not say the text is unmasked", async () => {
    const r = await read(["hello"]);
    expect(String(r.hint?.warning ?? "").toLowerCase()).not.toContain(
      "unmasked",
    );
  });
});

describe("readConversation: scrubbed text input cut follows msgChars", () => {
  const words = (chars: number) =>
    "word ".repeat(Math.ceil(chars / 5)).slice(0, chars - 1) + "x";
  const read = async (text: string, opts: Record<string, unknown> = {}) => {
    const { client } = mockClient({ items: [item(1, { inputText: text })] });
    const r = await readConversation(client, {
      id: SESSION,
      view: "text",
      ...opts,
    });
    return (r.body.messages as any[])[0].text as string;
  };

  it("msgChars 4000 returns a 3500-char plain-word text whole", async () => {
    const text = words(3500);
    expect(text.length).toBe(3500);
    const out = await read(text, { msgChars: 4000 });
    expect(out.length).toBe(3500);
    expect(out).toBe(text);
    expect(out.endsWith("…")).toBe(false);
  });

  it("msgChars 4000 cuts a 4500-char plain-word text to exactly 4000 with an ellipsis", async () => {
    const text = words(4500);
    const out = await read(text, { msgChars: 4000 });
    expect(out.length).toBe(4000);
    expect(out).toBe(`${text.slice(0, 3999)}…`);
  });

  it("the default msgChars cuts a 600-char plain-word text to exactly 500 with an ellipsis", async () => {
    const text = words(600);
    const out = await read(text);
    expect(out.length).toBe(500);
    expect(out).toBe(`${text.slice(0, 499)}…`);
  });
});

describe("readConversation: rawText", () => {
  const read = async (texts: unknown[], opts: Record<string, unknown> = {}) => {
    const { client } = mockClient({
      items: texts.map((t, i) => item(i + 1, { inputText: t })),
    });
    return readConversation(client, {
      id: SESSION,
      view: "text",
      rawText: true,
      ...opts,
    });
  };

  it("leaves the text as is (nothing masked, whitespace unchanged)", async () => {
    const text = "mail  jane@example.com\tphone 415-555-0123 id 4155550123";
    const r = await read([text]);
    expect(msgs(r)[0].text).toBe(text);
  });

  it("cuts to exactly msgChars with a trailing ellipsis", async () => {
    const text = "a b ".repeat(100); // 400 characters
    const r = await read([text], { msgChars: 150 });
    expect(msgs(r)[0].text).toBe(`${text.slice(0, 149)}…`);
    expect(msgs(r)[0].text.length).toBe(150);
  });

  it("defaults to a 500 character cut", async () => {
    const text = "a b ".repeat(300); // 1200 characters
    const r = await read([text]);
    expect(msgs(r)[0].text).toBe(`${text.slice(0, 499)}…`);
  });

  it("clamps msgChars into 100-4000", async () => {
    const text = "a b ".repeat(2000); // 8000 characters
    const high = await read([text], { msgChars: 9999 });
    expect(msgs(high)[0].text).toBe(`${text.slice(0, 3999)}…`);
    const low = await read([text], { msgChars: 5 });
    expect(msgs(low)[0].text).toBe(`${text.slice(0, 99)}…`);
  });

  it("does not cut a text that fits", async () => {
    const r = await read(["fits  as is"], { msgChars: 100 });
    expect(msgs(r)[0].text).toBe("fits  as is");
  });

  it("a non-string inputText gives an empty text", async () => {
    const r = await read([undefined, 7]);
    expect(msgs(r).map((m) => m.text)).toEqual(["", ""]);
  });

  it("the warning says the text is unmasked and the advice is kept", async () => {
    const r = await read(["hello"]);
    expect(String(r.hint?.warning).toLowerCase()).toContain("unmasked");
    expect(String(r.hint?.action).toLowerCase()).toContain("personal data");
  });
});

describe("readConversation: expertMode intent fields", () => {
  const expertItems = () => [
    item(1, { intent: "OrderStatus", intentScore: 0.93 }),
    item(2, { intent: null, intentScore: 0 }),
    item(3),
    item(4, {
      intent: "Cancel",
      intentScore: 1,
      slots: { amount: "SLOT-SECRET" },
      slotMatches: [{ text: "SLOTMATCH-SECRET" }],
    }),
  ];

  it("adds intent and intentScore only to messages with a non-null intent (outline)", async () => {
    const { client } = mockClient({ items: expertItems() });
    const r = await readConversation(client, { id: SESSION, expertMode: true });
    expect(msgs(r)[0]).toEqual({
      index: 0,
      type: "input",
      source: "user",
      timestamp: iso(1),
      textChars: 9,
      intent: "OrderStatus",
      intentScore: 0.93,
    });
    expect(Object.keys(msgs(r)[0])).toEqual([
      "index",
      "type",
      "source",
      "timestamp",
      "textChars",
      "intent",
      "intentScore",
    ]);
    expect(Object.keys(msgs(r)[1])).toEqual([
      "index",
      "type",
      "source",
      "timestamp",
      "textChars",
    ]);
    expect(Object.keys(msgs(r)[2])).toEqual([
      "index",
      "type",
      "source",
      "timestamp",
      "textChars",
    ]);
    expect(msgs(r)[3].intent).toBe("Cancel");
    expect(msgs(r)[3].intentScore).toBe(1);
  });

  it("adds the same fields in the text view", async () => {
    const { client } = mockClient({ items: expertItems() });
    const r = await readConversation(client, {
      id: SESSION,
      expertMode: true,
      view: "text",
    });
    expect(Object.keys(msgs(r)[0])).toEqual([
      "index",
      "type",
      "source",
      "timestamp",
      "text",
      "intent",
      "intentScore",
    ]);
    expect(msgs(r)[0].intent).toBe("OrderStatus");
    expect(msgs(r)[0].intentScore).toBe(0.93);
    expect("intent" in msgs(r)[1]).toBe(false);
    expect("intentScore" in msgs(r)[2]).toBe(false);
  });

  it("never returns the values of slots or slotMatches", async () => {
    const { client } = mockClient({ items: expertItems() });
    const r = await readConversation(client, {
      id: SESSION,
      expertMode: true,
      view: "text",
    });
    const text = JSON.stringify(r);
    expect(text).not.toContain("SLOT-SECRET");
    expect(text).not.toContain("SLOTMATCH-SECRET");
  });

  it("without expertMode, intent fields in the upstream items are not returned", async () => {
    const { client } = mockClient({ items: expertItems() });
    const r = await readConversation(client, { id: SESSION });
    for (const m of msgs(r)) {
      expect("intent" in m).toBe(false);
      expect("intentScore" in m).toBe(false);
    }
    expect(JSON.stringify(r)).not.toContain("OrderStatus");
  });
});

describe("readConversation: fields that are never returned", () => {
  it.each(["outline", "text"] as const)(
    "no secret value or key in the %s view",
    async (view) => {
      const { client } = mockClient({
        items: items(3).map((i) => ({
          ...i,
          intent: "Some",
          intentScore: 0.5,
          slots: { a: "SLOT-SECRET" },
          slotMatches: [{ a: "SLOTMATCH-SECRET" }],
        })),
      });
      const r = await readConversation(client, {
        id: SESSION,
        view,
        expertMode: true,
        projectId: PROJECT,
      });
      const text = JSON.stringify(r);
      for (const v of [
        ...FORBIDDEN_VALUES,
        "SLOT-SECRET",
        "SLOTMATCH-SECRET",
      ]) {
        expect(text).not.toContain(v);
      }
      for (const key of FORBIDDEN_KEYS) {
        expect(text).not.toContain(`"${key}"`);
      }
    },
  );

  it("unknown extra upstream keys never appear", async () => {
    const { client } = mockClient({
      items: [item(1, { somethingNew: "EXTRA-UPSTREAM-SECRET" })],
    });
    const r = await readConversation(client, { id: SESSION, view: "text" });
    expect(JSON.stringify(r)).not.toContain("EXTRA-UPSTREAM-SECRET");
    expect(Object.keys(msgs(r)[0])).toEqual([
      "index",
      "type",
      "source",
      "timestamp",
      "text",
    ]);
  });
});

describe("readConversation: empty result", () => {
  it.each([{ items: [] }, [], {}])("handles %j", async (response) => {
    const { client } = mockClient(response);
    const r = await readConversation(client, { id: SESSION });
    expect(r.body.sessionId).toBe(SESSION);
    expect(r.body.messageCount).toBe(0);
    expect(r.body.messages).toEqual([]);
    const action = String(r.hint?.action).toLowerCase();
    expect(action).toContain("no messages were found");
    expect(action).toContain("projectid");
    expect(action).toContain("collect");
  });
});

describe("readConversation: error mapping", () => {
  const SECRET = "UPSTREAM-SECRET-ERROR-TEXT apiKey=abc123";

  it("maps a numeric status to the fixed message with the status", async () => {
    const { client } = failingClient(
      Object.assign(new Error(SECRET), { status: 404 }),
    );
    const err = await readConversation(client, { id: SESSION }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Could not read conversation (HTTP 404).");
    expect(err.message).not.toContain("SECRET");
  });

  it("reads response.status too", async () => {
    const { client } = failingClient({
      message: SECRET,
      response: { status: 500, data: SECRET },
    });
    const err = await readConversation(client, { id: SESSION }).catch((e) => e);
    expect(err.message).toBe("Could not read conversation (HTTP 500).");
  });

  it("without a numeric status gives the plain message", async () => {
    const { client } = failingClient(new Error(SECRET));
    const err = await readConversation(client, { id: SESSION }).catch((e) => e);
    expect(err.message).toBe("Could not read conversation.");
    expect(err.message).not.toContain("UPSTREAM");
  });

  it("a non-numeric status is ignored", async () => {
    const { client } = failingClient({ message: SECRET, status: "404" });
    const err = await readConversation(client, { id: SESSION }).catch((e) => e);
    expect(err.message).toBe("Could not read conversation.");
  });

  it("a non-Error rejection is mapped as well", async () => {
    const { client } = failingClient(SECRET);
    const err = await readConversation(client, { id: SESSION }).catch((e) => e);
    expect(err.message).toBe("Could not read conversation.");
  });
});
