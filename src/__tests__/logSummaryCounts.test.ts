import { describe, it } from "@jest/globals";

import { summarizeEntries } from "../tools/logSummary.js";
import { expectExact, e, T1, T2, T3, T4 } from "./helpers/logFixtures.js";

describe("summarizeEntries: empty input", () => {
  it("returns the exact empty summary and passes total through", () => {
    expectExact(
      summarizeEntries([], { total: 5 }),
      {
        total: 5,
        sampled: 0,
        levels: {},
        span: null,
        topMessages: [],
        flows: [],
        truncated: true,
      },
      {
        what: "empty entries, total 5",
        why: "empty input returns the fixed shape; truncated = total !== null && total > sampled (5 > 0)",
        fix: "do not special-case beyond the contract shape",
      },
    );
  });

  it.each([
    [null, undefined, false],
    [0, undefined, false],
    [5, false, false],
    [null, true, true],
  ])(
    "total=%p truncated option=%p gives truncated=%p",
    (total, truncated, expected) => {
      const out = summarizeEntries(
        [],
        truncated === undefined ? { total } : { total, truncated },
      );
      expectExact(out.truncated, expected, {
        what: `empty input, total=${total}, options.truncated=${truncated}`,
        why: "options.truncated wins when given; otherwise total !== null && total > sampled",
        fix: "options.truncated ?? (total !== null && total > sampled)",
      });
    },
  );
});

describe("summarizeEntries: counts and levels", () => {
  it("counts sampled and every level including unknown", () => {
    const out = summarizeEntries(
      [
        e({ level: "error" }),
        e({ level: "info" }),
        e({ level: "error" }),
        e({ level: "unknown" }),
      ],
      { total: 4 },
    );
    expectExact(
      [out.sampled, out.levels, out.total],
      [4, { error: 2, info: 1, unknown: 1 }, 4],
      {
        what: "sampled/levels/total",
        why: "sampled = entries.length; levels counts every level present",
        fix: "tally entries by level, no filtering",
      },
    );
  });
});

describe("summarizeEntries: levels named like Object.prototype members (amendment A2)", () => {
  const hostile = ["constructor", "toString", "__proto__", "hasOwnProperty"];

  it.each(hostile)(
    "level %p becomes an own key holding a numeric count",
    (name) => {
      const out = summarizeEntries(
        [e({ level: name }), e({ level: name }), e({ level: "info" })],
        { total: 3 },
      );
      const descriptor = Object.getOwnPropertyDescriptor(out.levels, name);
      expectExact(
        [
          Object.entries(out.levels).sort(([a], [b]) => (a < b ? -1 : 1)),
          typeof descriptor?.value,
          descriptor?.value,
          out.sampled,
        ],
        [
          [
            [name, 2],
            ["info", 1],
          ].sort(([a], [b]) => (a < b ? -1 : 1)),
          "number",
          2,
          3,
        ],
        {
          what: `levels for entries with level ${name}`,
          why: "A2: levels is built from a Map via Object.fromEntries so every level string is an ordinary own key with a number",
          fix: "use new Map<string, number>() for tallying and Object.fromEntries(map) for the result; never index a plain {} by level",
        },
      );
    },
  );

  it("all hostile levels together: sampled equals the sum of levels values and JSON keeps every key", () => {
    const entries = hostile.flatMap((name, i) =>
      Array.from({ length: i + 1 }, () => e({ level: name })),
    );
    const out = summarizeEntries(entries, { total: entries.length });
    const sum = Object.values(out.levels).reduce((a, b) => a + b, 0);
    expectExact(
      [
        sum,
        out.sampled,
        Object.entries(JSON.parse(JSON.stringify(out.levels))).sort(
          ([a], [b]) => (a < b ? -1 : 1),
        ),
        Object.getOwnPropertyNames(out.levels).sort(),
        Object.getPrototypeOf(out.levels) === Object.prototype,
      ],
      [
        10,
        10,
        [
          ["__proto__", 3],
          ["constructor", 1],
          ["hasOwnProperty", 4],
          ["toString", 2],
        ],
        ["__proto__", "constructor", "hasOwnProperty", "toString"],
        true,
      ],
      {
        what: "levels over constructor/toString/__proto__/hasOwnProperty counts 1/2/3/4",
        why: "A2: __proto__ must be an own data property (so sum(levels) === sampled) while the prototype stays Object.prototype, and JSON serialisation keeps every key",
        fix: "build levels with Object.fromEntries(new Map(...)) so __proto__ is defined as an own property",
      },
    );
    expectExact(
      Object.getOwnPropertyDescriptor(out.levels, "__proto__")?.value,
      3,
      {
        what: "own __proto__ level count",
        why: "A2: the __proto__ level is an own key holding the number 3, not a prototype assignment",
        fix: "Object.fromEntries defines own properties; plain obj[level] = n would set the prototype",
      },
    );
  });
});

describe("summarizeEntries: truncated rule", () => {
  it.each([
    [10, 3, undefined, true],
    [3, 3, undefined, false],
    [2, 3, undefined, false],
    [null, 3, undefined, false],
    [10, 3, false, false],
    [3, 3, true, true],
    [null, 3, true, true],
  ])(
    "total=%p sampled=%p option=%p gives %p",
    (total, sampled, option, expected) => {
      const entries = Array.from({ length: sampled }, () => e());
      const out = summarizeEntries(
        entries,
        option === undefined ? { total } : { total, truncated: option },
      );
      expectExact(out.truncated, expected, {
        what: `truncated for total=${total}, sampled=${sampled}, option=${option}`,
        why: "options.truncated overrides; default is total !== null && total > sampled",
        fix: "options.truncated ?? (total !== null && total > sampled)",
      });
    },
  );
});

describe("summarizeEntries: span", () => {
  it("is the min and max non-empty timestamp regardless of order, ignoring empty ones", () => {
    const entries = [
      e({ timestamp: T3 }),
      e({ timestamp: "" }),
      e({ timestamp: T1 }),
      e({ timestamp: T4 }),
      e({ timestamp: T2 }),
    ];
    const forward = summarizeEntries(entries, { total: 5 }).span;
    const backward = summarizeEntries([...entries].reverse(), {
      total: 5,
    }).span;
    expectExact(
      [forward, backward],
      [
        { from: T1, to: T4 },
        { from: T1, to: T4 },
      ],
      {
        what: "span over unordered entries",
        why: "span is min/max by string comparison and independent of array order",
        fix: "scan all timestamps; skip ''",
      },
    );
  });

  it("is null when no entry has a timestamp", () => {
    expectExact(summarizeEntries([e(), e()], { total: 2 }).span, null, {
      what: "span with only empty timestamps",
      why: "null when there is no non-empty timestamp",
      fix: "return null",
    });
  });

  it("single timestamp gives from === to", () => {
    expectExact(
      summarizeEntries([e({ timestamp: T2 })], { total: 1 }).span,
      { from: T2, to: T2 },
      {
        what: "single timestamp span",
        why: "min and max coincide",
        fix: "min/max over the set",
      },
    );
  });
});
