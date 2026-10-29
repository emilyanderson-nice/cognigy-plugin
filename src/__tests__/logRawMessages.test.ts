/**
 * rawMessages: opt out of the safe form of risky log messages in the entries
 * view (window and session path). The client is a mock; nothing here touches a
 * real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import { listResourcesSchema } from "../schemas/tools.js";
import { tools } from "../tools/definitions.js";
import { PROJECT, Mock, item, queue, opts } from "./helpers/logFixtures.js";

const RISKY =
  'Error calling https://api.example.test/v1/customers?name=Jane%20Doe&phone=555-123-4567&balance=$1,234.56 failed: {"customer":"Jane Doe","phone":"555-123-4567","amount":"$1,234.56"}';
const SAFE =
  "Error calling api.example.test/vN/customers failed: <payload:customer,phone,amount>";
const RAW_MASKED =
  'Error calling https://api.example.test/v1/customers?name=Jane%20Doe&phone=<phone>&balance=<amount> failed: {"customer":"Jane Doe","phone":"<phone>","amount":"<amount>"}';

describe("readLogs rawMessages (C)", () => {
  let client: Mock;
  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = async (args: Record<string, unknown>) => {
    queue(client, [
      { items: [item(1, { msg: RISKY })], total: args.sessionId ? -1 : 1 },
    ]);
    return readLogs(
      { get: client } as any,
      { projectId: PROJECT, ...args } as any,
      opts,
    );
  };
  const msgOf = (r: any) => (r.body.entries as any[])[0].msg as string;

  it("entries view without rawMessages uses the safe form", async () => {
    const r = await run({ view: "entries" });
    expect(msgOf(r)).toBe(SAFE);
  });

  it("entries view with rawMessages false uses the safe form", async () => {
    const r = await run({ view: "entries", rawMessages: false });
    expect(msgOf(r)).toBe(SAFE);
  });

  it("entries view with rawMessages true uses the raw path and warns about personal data", async () => {
    const r = await run({ view: "entries", rawMessages: true });
    expect(msgOf(r)).toBe(RAW_MASKED);
    expect(String(r.hint?.action)).toContain("personal data");
    expect(String(r.hint?.action)).toContain(
      "names and addresses are never masked",
    );
  });

  it("summary view groups payload messages by their key names", async () => {
    queue(client, [
      {
        items: [
          item(1, { msg: 'Request failed {"error":"timeout"}' }),
          item(2, { msg: 'Request failed {"error":"auth failed"}' }),
          item(3, { msg: 'Request failed {"message":"x"}' }),
        ],
        total: 3,
      },
    ]);
    const r = await readLogs(
      { get: client } as any,
      { projectId: PROJECT } as any,
      opts,
    );
    expect(
      (r.body.topMessages as any[]).map((t) => [t.template, t.count]),
    ).toEqual([
      ["Request failed <payload:error>", 2],
      ["Request failed <payload:message>", 1],
    ]);
  });

  it("the default entries hint does not carry the raw-mode warning", async () => {
    const r = await run({ view: "entries" });
    expect(String(r.hint?.action)).not.toContain("rawMessages");
  });

  it("summary view (default) with rawMessages true fails with the exact error and no call", async () => {
    const r = await run({ rawMessages: true });
    expect(r.body.error).toBe(
      "rawMessages is only supported with view entries.",
    );
    expect(client.mock.calls.length).toBe(0);
  });

  it("explicit summary view with rawMessages true fails the same way", async () => {
    const r = await run({ view: "summary", rawMessages: true });
    expect(r.body.error).toBe(
      "rawMessages is only supported with view entries.",
    );
    expect(client.mock.calls.length).toBe(0);
  });

  it("session path with rawMessages true and no view is refused before any call", async () => {
    const r = await run({ sessionId: "s1", rawMessages: true });
    expect(r.body.error).toBe(
      "rawMessages is only supported with view entries.",
    );
    expect(client.mock.calls.length).toBe(0);
  });

  it("session path, entries view, rawMessages true uses the raw path and warns", async () => {
    const r = await run({
      view: "entries",
      sessionId: "s1",
      rawMessages: true,
    });
    expect(msgOf(r)).toBe(RAW_MASKED);
    expect(String(r.hint?.action)).toContain("personal data");
    expect(String(r.hint?.action)).toContain(
      "names and addresses are never masked",
    );
  });

  it("session path, entries view, no rawMessages uses the safe form", async () => {
    const r = await run({ view: "entries", sessionId: "s1" });
    expect(msgOf(r)).toBe(SAFE);
  });
});

describe("rawMessages schema and definition (D)", () => {
  const parse = (v: unknown) =>
    listResourcesSchema.safeParse({
      resourceType: "log",
      projectId: PROJECT,
      rawMessages: v,
    }).success;

  it.each([true, false])("schema accepts %p", (v) => {
    expect(parse(v)).toBe(true);
  });

  it.each(["true", "yes", 1, 0, null])("schema rejects %p", (v) => {
    expect(parse(v)).toBe(false);
  });

  it("schema keeps rawMessages optional", () => {
    expect(
      listResourcesSchema.safeParse({ resourceType: "log", projectId: PROJECT })
        .success,
    ).toBe(true);
  });

  it("the tool that exposes msgChars also exposes rawMessages as a short boolean", () => {
    const tool = tools.find(
      (t: any) => (t.inputSchema as any).properties?.msgChars,
    ) as any;
    const prop = tool.inputSchema.properties.rawMessages;
    expect(prop.type).toBe("boolean");
    expect(typeof prop.description).toBe("string");
    expect(prop.description.length).toBeGreaterThan(0);
    expect(prop.description.length).toBeLessThanOrEqual(200);
  });
});
