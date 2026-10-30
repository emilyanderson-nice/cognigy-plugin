/**
 * Hardening of the transcript readers against odd upstream values (review
 * findings): pass-through fields are scalars only, strings are capped, and the
 * per-source count is safe for keys that match Object.prototype members.
 */
import { describe, it, expect, jest } from "@jest/globals";

import { listConversations } from "../tools/transcripts/list.js";
import { readConversation } from "../tools/transcripts/read.js";
import { getResourceSchema, listResourcesSchema } from "../schemas/tools.js";

type Get = (url: string, config?: any) => Promise<any>;
const clientOf = (response: unknown) => ({
  get: jest.fn<Get>().mockResolvedValue(response),
});

const PROJECT = "507f1f77bcf86cd799439011";
const T0 = "2026-10-01T10:00:00.000Z";
const cut200 = (s: string) => `${s.slice(0, 199)}…`;

const msg = (overrides: Record<string, unknown> = {}) => ({
  inputText: "hello",
  type: "input",
  source: "user",
  timestamp: T0,
  ...overrides,
});

describe("listConversations: pass-through fields are scalars", () => {
  const row = (overrides: Record<string, unknown>) => ({
    _id: "s1",
    channel: "rest",
    flowName: "Main",
    endpointName: "EP",
    startTime: T0,
    endTime: T0,
    messages: 2,
    rating: 5,
    ...overrides,
  });

  it("omits an object, an array and a function-like value", async () => {
    const r = await listConversations(
      clientOf({
        items: [
          row({
            channel: { secret: "NESTED-SECRET" },
            flowName: ["a"],
            endpointName: { token: "TOKEN-SECRET" },
            rating: { value: 5 },
          }),
        ],
      }),
      { projectId: PROJECT },
    );
    expect(r.body.items).toEqual([
      {
        sessionId: "s1",
        startTime: T0,
        endTime: T0,
        messages: 2,
      },
    ]);
    expect(JSON.stringify(r.body)).not.toContain("SECRET");
  });

  it("keeps null and finite numbers, drops NaN-like non-finite numbers", async () => {
    const r = await listConversations(
      clientOf({
        items: [row({ rating: null, messages: Number.POSITIVE_INFINITY })],
      }),
      { projectId: PROJECT },
    );
    expect((r.body.items as any[])[0]).toEqual({
      sessionId: "s1",
      channel: "rest",
      flowName: "Main",
      endpointName: "EP",
      startTime: T0,
      endTime: T0,
      rating: null,
    });
  });

  it("cuts a string longer than 200 characters to exactly 200, ending with an ellipsis", async () => {
    const long = "x".repeat(1000);
    const r = await listConversations(
      clientOf({ items: [row({ flowName: long })] }),
      { projectId: PROJECT },
    );
    const flowName = (r.body.items as any[])[0].flowName as string;
    expect(flowName).toBe(cut200(long));
    expect(flowName).toHaveLength(200);
  });

  it("leaves a string of exactly 200 characters alone", async () => {
    const exact = "y".repeat(200);
    const r = await listConversations(
      clientOf({ items: [row({ flowName: exact })] }),
      { projectId: PROJECT },
    );
    expect((r.body.items as any[])[0].flowName).toBe(exact);
  });
});

describe("readConversation: bySource is safe for prototype-like keys", () => {
  it.each(["toString", "constructor", "hasOwnProperty", "valueOf"])(
    "counts source %p as a number",
    async (source) => {
      const r = await readConversation(
        clientOf({ items: [msg({ source }), msg({ source: "user" })] }),
        { id: "s" },
      );
      const bySource = r.body.bySource as Record<string, unknown>;
      expect(Object.keys(bySource).sort()).toEqual([source, "user"].sort());
      expect(bySource[source]).toBe(1);
      expect(bySource.user).toBe(1);
    },
  );

  it("counts source __proto__ as its own key", async () => {
    const r = await readConversation(
      clientOf({ items: [msg({ source: "__proto__" }), msg()] }),
      { id: "s" },
    );
    const bySource = r.body.bySource as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(bySource))).toEqual({
      user: 1,
      ["__proto__"]: 1,
    });
  });

  it("counts a non-string source as unknown", async () => {
    const r = await readConversation(
      clientOf({ items: [msg({ source: { a: 1 } }), msg({ source: 7 })] }),
      { id: "s" },
    );
    expect(r.body.bySource).toEqual({ unknown: 2 });
  });
});

describe("readConversation: pass-through fields are scalars", () => {
  it("omits non-scalar type, source and timestamp from a message", async () => {
    const r = await readConversation(
      clientOf({
        items: [
          msg({
            type: { x: "TYPE-SECRET" },
            source: ["SOURCE-SECRET"],
          }),
        ],
      }),
      { id: "s" },
    );
    const m = (r.body.messages as any[])[0];
    expect(Object.keys(m)).toEqual(["index", "timestamp", "textChars"]);
    expect(JSON.stringify(r.body)).not.toContain("SECRET");
  });

  it("omits non-scalar common keys instead of passing them on", async () => {
    const r = await readConversation(
      clientOf({
        items: [
          msg({
            channel: { c: "CHANNEL-SECRET" },
            flowName: ["FLOW-SECRET"],
            endpointName: { e: "EP-SECRET" },
            sessionId: { s: "SESSION-SECRET" },
          }),
        ],
      }),
      { id: "fallback-id" },
    );
    expect(r.body.sessionId).toBe("fallback-id");
    expect("channel" in r.body).toBe(false);
    expect("flowName" in r.body).toBe(false);
    expect("endpointName" in r.body).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain("SECRET");
  });

  it("caps a common-key string at 200 characters", async () => {
    const long = "f".repeat(500);
    const r = await readConversation(
      clientOf({ items: [msg({ flowName: long })] }),
      { id: "s" },
    );
    expect(r.body.flowName).toBe(cut200(long));
  });

  it("caps intent at 200 characters and requires a numeric intentScore", async () => {
    const long = "i".repeat(500);
    const r = await readConversation(
      clientOf({
        items: [
          msg({ intent: long, intentScore: 0.5 }),
          msg({ intent: "ok", intentScore: "0.9" }),
          msg({ intent: { name: "NESTED-INTENT" }, intentScore: 0.1 }),
        ],
      }),
      { id: "s", expertMode: true },
    );
    const messages = r.body.messages as any[];
    expect(messages[0].intent).toBe(cut200(long));
    expect(messages[0].intentScore).toBe(0.5);
    expect(messages[1].intent).toBe("ok");
    expect("intentScore" in messages[1]).toBe(false);
    expect("intent" in messages[2]).toBe(false);
    expect("intentScore" in messages[2]).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain("NESTED-INTENT");
  });
});

describe("schemas: options that cannot apply are refused", () => {
  it.each([{ minMessages: 5 }, { contactIds: ["abc"] }])(
    "list_resources refuses %p for a non-conversation type",
    (extra) => {
      const r = listResourcesSchema.safeParse({
        resourceType: "agent",
        projectId: PROJECT,
        ...extra,
      });
      expect(r.success).toBe(false);
    },
  );

  it("list_resources accepts them for conversation", () => {
    const r = listResourcesSchema.safeParse({
      resourceType: "conversation",
      projectId: PROJECT,
      minMessages: 5,
      contactIds: ["abc"],
    });
    expect(r.success).toBe(true);
  });

  it.each([
    { view: "outline" },
    { view: "text" },
    { rawText: true },
    { msgChars: 200 },
    { limit: 5 },
    { skip: 1 },
    { expertMode: true },
  ])("get_resource refuses %p together with raw: true", (extra) => {
    const r = getResourceSchema.safeParse({
      resourceType: "conversation",
      id: "s",
      raw: true,
      ...extra,
    });
    expect(r.success).toBe(false);
  });

  it("get_resource accepts raw: true on its own and the view options without raw", () => {
    expect(
      getResourceSchema.safeParse({
        resourceType: "conversation",
        id: "s",
        raw: true,
      }).success,
    ).toBe(true);
    expect(
      getResourceSchema.safeParse({
        resourceType: "conversation",
        id: "s",
        view: "text",
        rawText: true,
      }).success,
    ).toBe(true);
  });
});
