/**
 * An empty list result must tell apart "the project returned no conversations"
 * (collection may be off) from "conversations exist but the filters excluded
 * them" (usually an inexact flowName or channel).
 */
import { describe, it, expect, jest } from "@jest/globals";

import { listConversations } from "../tools/transcripts/list.js";

type Get = (url: string, config?: any) => Promise<any>;
const clientOf = (items: unknown[]) => ({
  get: jest.fn<Get>().mockResolvedValue({ items }),
});

const PROJECT = "507f1f77bcf86cd799439011";
const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  _id: `session-${n}`,
  channel: "rest",
  flowName: "Phone Support Flow",
  startTime: `2026-10-0${n}T10:00:00.000Z`,
  endTime: `2026-10-0${n}T10:05:00.000Z`,
  messages: 2,
  ...overrides,
});

const EXACT =
  "flowName and channel must match exactly (case-sensitive), startDate and endDate compare the start time";

describe("listConversations: empty result hint", () => {
  it("names the rows read and the exact-match rule when a flowName excludes them all", async () => {
    const r = await listConversations(clientOf([row(1), row(2), row(3)]), {
      projectId: PROJECT,
      flowName: "Phone Support",
    });
    expect(r.body.items).toEqual([]);
    expect(r.body.total).toBe(0);
    expect(r.hint?.action).toBe(
      `Result is empty: no conversation matched. 3 conversations were read from this project, but none matched the filters: ${EXACT}.`,
    );
  });

  it("uses the singular for one row read", async () => {
    const r = await listConversations(clientOf([row(1)]), {
      projectId: PROJECT,
      channel: "webchat",
    });
    expect(r.hint?.action).toBe(
      `Result is empty: no conversation matched. 1 conversation was read from this project, but none matched the filters: ${EXACT}.`,
    );
  });

  it("gives the same explanation when a date window or minMessages excludes them all", async () => {
    const byDate = await listConversations(clientOf([row(1), row(2)]), {
      projectId: PROJECT,
      startDate: "2027-01-01T00:00:00.000Z",
    });
    expect(byDate.hint?.action).toContain(
      "2 conversations were read from this project, but none matched the filters",
    );
    const byMessages = await listConversations(clientOf([row(1)]), {
      projectId: PROJECT,
      minMessages: 50,
    });
    expect(byMessages.hint?.action).toContain(
      "1 conversation was read from this project, but none matched the filters",
    );
  });

  it("does not blame collection settings when rows were read", async () => {
    const r = await listConversations(clientOf([row(1)]), {
      projectId: PROJECT,
      flowName: "nope",
    });
    expect(r.hint?.action).not.toContain("Collect Analytics");
  });

  it("keeps the collection hint when the project returned no rows at all", async () => {
    const r = await listConversations(clientOf([]), {
      projectId: PROJECT,
      flowName: "Phone Support Flow",
    });
    expect(r.hint?.action).toContain("no conversation matched");
    expect(r.hint?.action).toContain("Collect Analytics");
    expect(r.hint?.action).not.toContain("were read");
    expect(r.hint?.action).not.toContain("was read");
  });

  it("adds no hint when something matched and nothing follows", async () => {
    const r = await listConversations(clientOf([row(1), row(2)]), {
      projectId: PROJECT,
      flowName: "Phone Support Flow",
    });
    expect(r.body.total).toBe(2);
    expect(r.hint?.action).toBeUndefined();
  });

  it("counts the rows considered, not the rows the platform returned, when truncated", async () => {
    const many = Array.from({ length: 5001 }, (_, i) =>
      row(1, { _id: `s-${i}` }),
    );
    const r = await listConversations(clientOf(many), {
      projectId: PROJECT,
      flowName: "nope",
    });
    expect(r.body.truncated).toBe(true);
    expect(r.hint?.action).toContain(
      "5000 conversations were read from this project, but none matched the filters",
    );
  });
});
