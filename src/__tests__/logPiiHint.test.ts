/**
 * The entries view tells the caller how to handle the lines it just returned:
 * log text can hold personal data even after scrubbing, so report counts,
 * templates and error types, never the lines. The client is a mock; nothing
 * here touches a real Cognigy environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import { PROJECT, Mock, item, queue, opts } from "./helpers/logFixtures.js";

const PII_HINT =
  "Log text can contain personal data even after scrubbing: report counts, templates and error types, do not quote lines that hold a name, phone, amount or address, and do not copy log text into files, prompts or pull requests.";
const WINDOW_SENTENCE =
  "Showing the last hour by default; pass startDate (log retention is typically about 24 hours) to look further back.";

describe("readLogs personal-data hint (entries view)", () => {
  let client: Mock;
  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = async (
    args: Record<string, unknown>,
    items: unknown[] = [item(1, { msg: "Flow node failed" })],
  ) => {
    queue(client, [{ items, total: args.sessionId ? -1 : items.length }]);
    return readLogs(
      { get: client } as any,
      { projectId: PROJECT, ...args } as any,
      opts,
    );
  };
  const action = (r: any) => String(r.hint?.action);

  it("window path, default window: the sentence sits right before the window sentence", async () => {
    const r = await run({ view: "entries" });
    expect(action(r)).toBe(`${PII_HINT} ${WINDOW_SENTENCE}`);
  });

  it("window path with a startDate: the action is the retention text plus the sentence", async () => {
    const r = await run({
      view: "entries",
      startDate: "2026-10-28T09:00:00.000Z",
      endDate: "2026-10-28T10:00:00.000Z",
    });
    expect(action(r).endsWith(PII_HINT)).toBe(true);
    expect(action(r)).toContain("24 hours");
  });

  it("session path: the sentence is present", async () => {
    const r = await run({ view: "entries", sessionId: "s1" });
    expect(action(r)).toContain(PII_HINT);
  });

  it("an entries view with no lines does not carry the sentence", async () => {
    const r = await run({ view: "entries" }, []);
    expect(action(r)).not.toContain("personal data");
  });

  it("the summary view does not carry the sentence", async () => {
    const r = await run({});
    expect(action(r)).not.toContain("personal data");
  });

  it("the sentence never mentions rawMessages, so the default hint stays free of it", async () => {
    const r = await run({ view: "entries" });
    expect(action(r)).not.toContain("rawMessages");
  });
});
