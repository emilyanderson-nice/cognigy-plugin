import { describe, it } from "@jest/globals";

import { summarizeEntries } from "../tools/logSummary.js";
import { expectExact, e, T1, T2, T3 } from "./helpers/logFixtures.js";

describe("summarizeEntries: topMessages", () => {
  it("groups by (level, template) so numbers do not split a group", () => {
    const out = summarizeEntries(
      [
        e({ level: "error", msg: "Input was 29 characters", timestamp: T3 }),
        e({ level: "error", msg: "Input was 30 characters", timestamp: T1 }),
        e({ level: "error", msg: "Input was 31 characters", timestamp: T2 }),
      ],
      { total: 3 },
    );
    expectExact(
      out.topMessages,
      [
        {
          template: "Input was N characters",
          count: 3,
          level: "error",
          firstSeen: T1,
          lastSeen: T3,
        },
      ],
      {
        what: "grouping by template",
        why: "group key is (level, messageTemplate(msg)); firstSeen/lastSeen are min/max timestamps of the group regardless of order",
        fix: "key on level + messageTemplate; track min and max timestamp",
      },
    );
  });

  it("keeps the same template at different levels in separate groups, level ascending on ties", () => {
    const out = summarizeEntries(
      [e({ level: "warn", msg: "same" }), e({ level: "error", msg: "same" })],
      { total: 2 },
    );
    expectExact(
      out.topMessages.map((g) => [g.level, g.template, g.count]),
      [
        ["error", "same", 1],
        ["warn", "same", 1],
      ],
      {
        what: "tie-break by level",
        why: "equal count and template: level ascending",
        fix: "third sort key = level code-unit ascending",
      },
    );
  });

  it("firstSeen/lastSeen are '' when the group has no timestamps and ignore empty ones otherwise", () => {
    const out = summarizeEntries(
      [
        e({ msg: "none" }),
        e({ msg: "some", timestamp: "" }),
        e({ msg: "some", timestamp: T2 }),
      ],
      { total: 3 },
    );
    expectExact(
      out.topMessages.map((g) => [g.template, g.firstSeen, g.lastSeen]),
      [
        ["some", T2, T2],
        ["none", "", ""],
      ],
      {
        what: "empty timestamp handling in groups",
        why: "'' when no non-empty timestamp; empty strings are ignored for min/max",
        fix: "skip '' when computing min and max",
      },
    );
  });

  it("orders by count desc, then template ascending by code unit (uppercase before lowercase), then level", () => {
    const out = summarizeEntries(
      [
        e({ msg: "b msg" }),
        e({ msg: "a msg" }),
        e({ msg: "B msg" }),
        e({ msg: "z msg" }),
        e({ msg: "z msg" }),
      ],
      { total: 5 },
    );
    expectExact(
      out.topMessages.map((g) => [g.template, g.count]),
      [
        ["z msg", 2],
        ["B msg", 1],
        ["a msg", 1],
        ["b msg", 1],
      ],
      {
        what: "topMessages ordering",
        why: "count descending first, then template by plain code-unit comparison (not localeCompare)",
        fix: "compare with < / > on strings, not localeCompare",
      },
    );
  });

  it("caps at 10 groups keeping the highest-ranked", () => {
    const letters = "abcdefghijkl".split("");
    const entries = letters.map((c) => e({ msg: `msg ${c}` }));
    entries.push(e({ msg: "msg l" }), e({ msg: "msg l" }));
    const out = summarizeEntries(entries, { total: entries.length });
    expectExact(
      out.topMessages.map((g) => g.template),
      [
        "msg l",
        "msg a",
        "msg b",
        "msg c",
        "msg d",
        "msg e",
        "msg f",
        "msg g",
        "msg h",
        "msg i",
      ],
      {
        what: "10-group cap",
        why: "12 distinct templates: the 10 best by (count desc, template asc) are returned",
        fix: "sort first, then slice(0, 10)",
      },
    );
  });

  it("each group has exactly template/count/level/firstSeen/lastSeen and no raw example", () => {
    const out = summarizeEntries(
      [e({ level: "error", msg: "Input was 29 characters", timestamp: T1 })],
      { total: 1 },
    );
    expectExact(
      Object.keys(out.topMessages[0]).sort(),
      ["count", "firstSeen", "lastSeen", "level", "template"],
      {
        what: "topMessages group keys",
        why: "no example/msg field is allowed in a group",
        fix: "build the group object with exactly the five documented keys",
      },
    );
    expectExact(JSON.stringify(out).includes("29"), false, {
      what: "raw number from the message in the output",
      why: "no raw message example anywhere in the summary; only the template (Input was N characters)",
      fix: "output messageTemplate only",
    });
  });

  it("re-scrubs the message when templating (raw email never appears)", () => {
    const out = summarizeEntries(
      [e({ msg: "user bob@example.com took 12345 ms" })],
      { total: 1 },
    );
    expectExact(out.topMessages[0].template, "user <email> took N ms", {
      what: "template of a message containing an email",
      why: "template = messageTemplate(msg): scrub then number-mask",
      fix: "call messageTemplate from logScrub",
    });
    expectExact(JSON.stringify(out).includes("bob@example.com"), false, {
      what: "email leak",
      why: "summary never contains a raw message",
      fix: "template only",
    });
  });
});

describe("summarizeEntries: flows", () => {
  it("groups by flowId, ignores entries without one, takes the first non-empty name in input order", () => {
    const out = summarizeEntries(
      [
        e({ flowId: "f1" }),
        e({}),
        e({ flowId: "f1", flowName: "Alpha" }),
        e({ flowId: "f1", flowName: "Beta" }),
        e({ flowId: "f2" }),
      ],
      { total: 5 },
    );
    expectExact(
      out.flows,
      [
        { flowId: "f1", flowName: "Alpha", count: 3 },
        { flowId: "f2", count: 1 },
      ],
      {
        what: "flows grouping",
        why: "entries without flowId are skipped; flowName = first non-empty seen; omitted when none",
        fix: "only set flowName when a non-empty one was seen",
      },
    );
    expectExact(Object.keys(out.flows[1]).sort(), ["count", "flowId"], {
      what: "flowName key on an unnamed flow",
      why: "omitted, not undefined",
      fix: "conditionally assign",
    });
  });

  it("orders by count desc then flowId asc and caps at 5", () => {
    const ids = ["g", "f", "e", "d", "c", "b", "a"];
    const entries = ids.map((id) => e({ flowId: id }));
    entries.push(e({ flowId: "g" }), e({ flowId: "g" }));
    const out = summarizeEntries(entries, { total: entries.length });
    expectExact(
      out.flows.map((f) => [f.flowId, f.count]),
      [
        ["g", 3],
        ["a", 1],
        ["b", 1],
        ["c", 1],
        ["d", 1],
      ],
      {
        what: "flows ordering and cap",
        why: "count descending, flowId ascending, at most 5",
        fix: "sort then slice(0, 5)",
      },
    );
  });
});
