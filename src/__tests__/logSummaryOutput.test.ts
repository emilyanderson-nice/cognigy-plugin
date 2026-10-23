import { describe, it } from "@jest/globals";

import { summarizeEntries } from "../tools/logSummary.js";
import { toLogEntry, type LogEntry } from "../tools/logScrub.js";
import {
  SENTINEL_TEXT,
  SENTINEL_TOKEN as SENTINEL_URL_TOKEN,
  expectExact,
  e,
  T1,
  T2,
  T3,
  T4,
} from "./helpers/logFixtures.js";

describe("summarizeEntries: output shape and order independence", () => {
  it("has exactly the documented top-level keys", () => {
    const out = summarizeEntries([e({ msg: "m" })], { total: 1 });
    expectExact(
      Object.keys(out).sort(),
      [
        "flows",
        "levels",
        "sampled",
        "span",
        "topMessages",
        "total",
        "truncated",
      ],
      {
        what: "top-level keys",
        why: "no extra keys such as example or msg",
        fix: "return only the LogSummary fields",
      },
    );
  });

  it("levels, span and topMessages do not depend on input order", () => {
    const entries = [
      e({ level: "error", msg: "x 1", timestamp: T2 }),
      e({ level: "error", msg: "x 2", timestamp: T4 }),
      e({ level: "warn", msg: "y", timestamp: T1 }),
      e({ level: "info", msg: "z", timestamp: T3 }),
    ];
    const a = summarizeEntries(entries, { total: 4 });
    const b = summarizeEntries([...entries].reverse(), { total: 4 });
    expectExact(
      [b.levels, b.span, b.topMessages],
      [a.levels, a.span, a.topMessages],
      {
        what: "order independence",
        why: "span, groups, firstSeen/lastSeen and ordering are functions of the multiset of entries",
        fix: "never use first/last array position for timestamps",
      },
    );
  });
});

describe("summarizeEntries: sentinel security", () => {
  it("never outputs meta.text or meta.URLToken after toLogEntry + summarizeEntries", () => {
    const raws = [
      {
        timestamp: T1,
        type: "error",
        msg: "boom",
        meta: {
          flowId: "f1",
          flowName: "Main",
          text: SENTINEL_TEXT,
          URLToken: SENTINEL_URL_TOKEN,
          nested: {
            URLToken: SENTINEL_URL_TOKEN,
            deeper: { text: SENTINEL_TEXT },
          },
        },
      },
      {
        timestamp: T2,
        metadata: {
          type: "warn",
          URLToken: SENTINEL_URL_TOKEN,
          text: SENTINEL_TEXT,
        },
        msg: "careful",
        meta: { text: SENTINEL_TEXT, flowId: { URLToken: SENTINEL_URL_TOKEN } },
      },
    ];
    const entries = raws.map((r) => toLogEntry(r));
    const json = JSON.stringify(summarizeEntries(entries, { total: 2 }));
    expectExact(
      [
        json.includes(SENTINEL_TEXT),
        json.includes(SENTINEL_URL_TOKEN),
        json.includes("URLToken"),
      ],
      [false, false, false],
      {
        what: "sentinel leak through the summary pipeline",
        why: "end-user text and URLToken must never appear in any output",
        fix: "summaries are built only from allowlisted LogEntry fields and templates",
      },
    );
  });
});
