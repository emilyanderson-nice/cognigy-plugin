import { describe, it, expect } from "@jest/globals";
import {
  compactTable,
  groupReasons,
  summarize,
} from "../tools/intents/listViews.js";

const hid = (n: number): string => "a".repeat(20) + String(n).padStart(4, "0");

type Status = {
  state: "ok" | "low_data" | "not_scored" | "unknown";
  reasons: Array<{ type: string; intents: string[] }>;
};
const mk = (n: number, over: Record<string, unknown> = {}): any => ({
  id: hid(n),
  name: `Intent ${n}`,
  parentId: null,
  childIds: [],
  depth: 1,
  ...over,
});
const st = (
  state: Status["state"],
  reasons: Status["reasons"] = [],
): Status => ({ state, reasons });

// ---------------------------------------------------------------------------
describe("compactTable", () => {
  it("returns only the four base columns when nothing optional is present", () => {
    const t = compactTable([mk(1), mk(2, { parentId: hid(1), depth: 2 })]);
    expect(t.columns).toEqual(["id", "name", "parentId", "depth"]);
    expect(t.rows).toEqual([
      [hid(1), "Intent 1", null, 1],
      [hid(2), "Intent 2", hid(1), 2],
    ]);
    expect("priority" in t).toBe(false);
  });

  it("returns empty rows and the base columns for no intents", () => {
    const t = compactTable([]);
    expect(t.columns).toEqual(["id", "name", "parentId", "depth"]);
    expect(t.rows).toEqual([]);
    expect("priority" in t).toBe(false);
  });

  it("adds optional columns in the fixed order and fills gaps with null", () => {
    const t = compactTable([
      mk(1, {
        sentenceCount: 6,
        effectiveSentenceCount: 14,
        childFeatures: true,
        status: st("ok"),
      }),
      mk(2, { parentId: hid(1), depth: 2, sentenceCount: 3 }),
    ]);
    expect(t.columns).toEqual([
      "id",
      "name",
      "parentId",
      "depth",
      "sentenceCount",
      "effectiveSentenceCount",
      "childFeatures",
      "state",
    ]);
    expect(t.rows).toEqual([
      [hid(1), "Intent 1", null, 1, 6, 14, true, "ok"],
      [hid(2), "Intent 2", hid(1), 2, 3, null, null, null],
    ]);
  });

  it("includes a column only when at least one intent has a value", () => {
    const onlyChildFeatures = compactTable([
      mk(1),
      mk(2, { childFeatures: false }),
    ]);
    expect(onlyChildFeatures.columns).toEqual([
      "id",
      "name",
      "parentId",
      "depth",
      "childFeatures",
    ]);
    expect(onlyChildFeatures.rows).toEqual([
      [hid(1), "Intent 1", null, 1, null],
      [hid(2), "Intent 2", null, 1, false],
    ]);

    const onlyState = compactTable([mk(1, { status: st("low_data") }), mk(2)]);
    expect(onlyState.columns).toEqual([
      "id",
      "name",
      "parentId",
      "depth",
      "state",
    ]);
    expect(onlyState.rows).toEqual([
      [hid(1), "Intent 1", null, 1, "low_data"],
      [hid(2), "Intent 2", null, 1, null],
    ]);

    const onlyEffective = compactTable([mk(1, { effectiveSentenceCount: 0 })]);
    expect(onlyEffective.columns).toEqual([
      "id",
      "name",
      "parentId",
      "depth",
      "effectiveSentenceCount",
    ]);
  });

  it("keeps zero and false values instead of turning them into null", () => {
    const t = compactTable([
      mk(1, {
        sentenceCount: 0,
        childFeatures: false,
        effectiveSentenceCount: 0,
      }),
    ]);
    expect(t.rows).toEqual([[hid(1), "Intent 1", null, 1, 0, 0, false]]);
  });

  it("keeps the order of the input intents", () => {
    const t = compactTable([mk(3), mk(1), mk(2)]);
    expect(t.rows.map((r) => r[0])).toEqual([hid(3), hid(1), hid(2)]);
  });

  it("gives every row exactly as many cells as columns", () => {
    const t = compactTable([
      mk(1, { childIds: [hid(2)], sentenceCount: 1, status: st("ok") }),
      mk(2, { parentId: hid(1), depth: 2 }),
    ]);
    for (const row of t.rows) expect(row).toHaveLength(t.columns.length);
  });

  it("carries the priority once when every intent has the same one, and no priority column", () => {
    const t = compactTable([
      mk(1, { priority: "children" }),
      mk(2, { priority: "children" }),
    ]);
    expect(t.priority).toBe("children");
    expect(t.columns).toEqual(["id", "name", "parentId", "depth"]);
    expect(t.rows[0]).toHaveLength(4);
  });

  it("has no priority when the values differ", () => {
    const t = compactTable([
      mk(1, { priority: "children" }),
      mk(2, { priority: "parents" }),
    ]);
    expect("priority" in t).toBe(false);
    expect(t.columns).not.toContain("priority");
  });

  it("has no priority when only some intents have one", () => {
    const t = compactTable([mk(1, { priority: "parents" }), mk(2)]);
    expect("priority" in t).toBe(false);
  });

  it("has no priority when none has one", () => {
    expect("priority" in compactTable([mk(1), mk(2)])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("groupReasons", () => {
  const R = (type: string, intents: string[]) => ({ type, intents });

  it("groups identical reasons and counts the intents that carry them", () => {
    const g = groupReasons([
      mk(1, { status: st("not_scored", [R("x", ["P", "Q"])]) }),
      mk(2, { status: st("not_scored", [R("x", ["P", "Q"])]) }),
      mk(3, { status: st("not_scored", [R("x", ["P"])]) }),
    ]);
    expect(g).toEqual([
      { type: "x", intents: ["P", "Q"], intentCount: 2 },
      { type: "x", intents: ["P"], intentCount: 1 },
    ]);
  });

  it("treats the same names in a different order as a different reason", () => {
    const g = groupReasons([
      mk(1, { status: st("not_scored", [R("x", ["P", "Q"])]) }),
      mk(2, { status: st("not_scored", [R("x", ["Q", "P"])]) }),
    ]);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.intentCount === 1)).toBe(true);
  });

  it("orders by count descending, then type, then the joined names", () => {
    const withReason = (n: number, type: string, names: string[]) =>
      mk(n, { status: st("not_scored", [R(type, names)]) });
    const g = groupReasons([
      withReason(1, "b", ["m"]),
      withReason(2, "b", ["m"]),
      withReason(3, "a", ["z"]),
      withReason(4, "a", ["z"]),
      withReason(5, "a", ["y"]),
      withReason(6, "a", ["y"]),
      withReason(7, "c", ["k"]),
      withReason(8, "c", ["k"]),
      withReason(9, "c", ["k"]),
      withReason(10, "a", ["a"]),
    ]);
    expect(g).toEqual([
      { type: "c", intents: ["k"], intentCount: 3 },
      { type: "a", intents: ["y"], intentCount: 2 },
      { type: "a", intents: ["z"], intentCount: 2 },
      { type: "b", intents: ["m"], intentCount: 2 },
      { type: "a", intents: ["a"], intentCount: 1 },
    ]);
  });

  it("counts every reason of an intent that has several", () => {
    const g = groupReasons([
      mk(1, { status: st("low_data", [R("a", ["P"]), R("b", ["P"])]) }),
      mk(2, { status: st("low_data", [R("a", ["P"])]) }),
    ]);
    expect(g).toEqual([
      { type: "a", intents: ["P"], intentCount: 2 },
      { type: "b", intents: ["P"], intentCount: 1 },
    ]);
  });

  it("ignores intents without a status", () => {
    const g = groupReasons([
      mk(1),
      mk(2, { status: st("not_scored", [R("x", ["P"])]) }),
    ]);
    expect(g).toEqual([{ type: "x", intents: ["P"], intentCount: 1 }]);
  });

  it("returns [] without any status", () => {
    expect(groupReasons([mk(1), mk(2)])).toEqual([]);
    expect(groupReasons([])).toEqual([]);
  });

  it("returns [] when statuses carry no reasons", () => {
    expect(groupReasons([mk(1, { status: st("ok") })])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("summarize", () => {
  it("returns only byDepth for bare intents", () => {
    expect(summarize([mk(1), mk(2, { depth: 2 })])).toEqual({
      byDepth: { "1": 1, "2": 1 },
    });
  });

  it("counts depths per level, including depth 0 and only depths that occur", () => {
    const s = summarize([
      mk(1, { depth: 1 }),
      mk(2, { depth: 3 }),
      mk(3, { depth: 3 }),
      mk(4, { depth: 0 }),
    ]);
    expect(s.byDepth).toEqual({ "0": 1, "1": 1, "3": 2 });
    expect("2" in s.byDepth).toBe(false);
  });

  it("returns an empty byDepth and nothing else for no intents", () => {
    expect(summarize([])).toEqual({ byDepth: {} });
  });

  describe("sentenceCounts", () => {
    const counts = (...c: Array<number | undefined>) =>
      summarize(
        c.map((x, i) => mk(i + 1, x === undefined ? {} : { sentenceCount: x })),
      );

    it("computes counted, min, max, sum and the middle element for an odd number", () => {
      expect(counts(5, 1, 3).sentenceCounts).toEqual({
        counted: 3,
        min: 1,
        max: 5,
        median: 3,
        sum: 9,
      });
    });

    it("uses the lower median for an even number", () => {
      expect(counts(4, 1, 3, 2).sentenceCounts).toEqual({
        counted: 4,
        min: 1,
        max: 4,
        median: 2,
        sum: 10,
      });
    });

    it("handles a single count", () => {
      expect(counts(7).sentenceCounts).toEqual({
        counted: 1,
        min: 7,
        max: 7,
        median: 7,
        sum: 7,
      });
    });

    it("counts zero as a count and skips intents without one", () => {
      expect(counts(0, undefined, 0).sentenceCounts).toEqual({
        counted: 2,
        min: 0,
        max: 0,
        median: 0,
        sum: 0,
      });
    });

    it("is absent when no intent has a count", () => {
      expect("sentenceCounts" in counts(undefined, undefined)).toBe(false);
    });
  });

  describe("inheriting", () => {
    it("counts intents with an effectiveSentenceCount, zero included", () => {
      const s = summarize([
        mk(1, { effectiveSentenceCount: 12 }),
        mk(2, { effectiveSentenceCount: 0 }),
        mk(3),
      ]);
      expect(s.inheriting).toBe(2);
    });

    it("is absent when none has one", () => {
      expect("inheriting" in summarize([mk(1), mk(2)])).toBe(false);
    });
  });

  describe("states", () => {
    it("counts each state over intents with a status", () => {
      const s = summarize([
        mk(1, { status: st("ok") }),
        mk(2, { status: st("low_data") }),
        mk(3, { status: st("low_data") }),
        mk(4, { status: st("unknown") }),
        mk(5, { status: st("not_scored") }),
        mk(6),
      ]);
      expect(s.states).toEqual({
        ok: 1,
        low_data: 2,
        not_scored: 1,
        unknown: 1,
      });
    });

    it("includes zeros for the states that do not occur", () => {
      expect(summarize([mk(1, { status: st("ok") })]).states).toEqual({
        ok: 1,
        low_data: 0,
        not_scored: 0,
        unknown: 0,
      });
    });

    it("is absent when no intent has a status", () => {
      expect("states" in summarize([mk(1)])).toBe(false);
    });
  });

  describe("reasons", () => {
    it("carries the grouped reasons when there are any", () => {
      const s = summarize([
        mk(1, {
          status: st("not_scored", [{ type: "x", intents: ["P"] }]),
        }),
      ]);
      expect(s.reasons).toEqual([
        { type: "x", intents: ["P"], intentCount: 1 },
      ]);
    });

    it("is absent when there are none", () => {
      expect("reasons" in summarize([mk(1, { status: st("ok") })])).toBe(false);
    });
  });

  describe("attention", () => {
    const low = (n: number) => mk(n, { status: st("low_data") });

    it("lists low_data and unknown intents in input order and nothing else", () => {
      const s = summarize([
        mk(1, { status: st("ok") }),
        mk(2, { status: st("unknown") }),
        mk(3, { status: st("not_scored") }),
        mk(4, { status: st("low_data") }),
        mk(5),
      ]);
      expect(s.attention).toEqual([
        { id: hid(2), name: "Intent 2", state: "unknown" },
        { id: hid(4), name: "Intent 4", state: "low_data" },
      ]);
      expect("attentionMore" in s).toBe(false);
    });

    it("lists exactly 50 with no attentionMore", () => {
      const s = summarize(Array.from({ length: 50 }, (_, i) => low(i + 1)));
      expect(s.attention).toHaveLength(50);
      expect("attentionMore" in s).toBe(false);
    });

    it("lists the first 50 and reports 1 more for 51", () => {
      const s = summarize(Array.from({ length: 51 }, (_, i) => low(i + 1)));
      expect(s.attention).toHaveLength(50);
      expect(s.attention![0]).toEqual({
        id: hid(1),
        name: "Intent 1",
        state: "low_data",
      });
      expect(s.attention![49].id).toBe(hid(50));
      expect(s.attentionMore).toBe(1);
    });

    it("reports 70 more for 120", () => {
      const s = summarize(Array.from({ length: 120 }, (_, i) => low(i + 1)));
      expect(s.attention).toHaveLength(50);
      expect(s.attentionMore).toBe(70);
    });

    it("is absent when none needs attention", () => {
      const s = summarize([
        mk(1, { status: st("ok") }),
        mk(2, { status: st("not_scored") }),
      ]);
      expect("attention" in s).toBe(false);
      expect("attentionMore" in s).toBe(false);
    });
  });

  it("combines every part in one exact result", () => {
    const reason = { type: "lowDataIntents", intents: ["Intent 2"] };
    const s = summarize([
      mk(1, {
        childIds: [hid(2)],
        sentenceCount: 6,
        effectiveSentenceCount: 9,
        status: st("not_scored", [reason]),
      }),
      mk(2, {
        parentId: hid(1),
        depth: 2,
        sentenceCount: 3,
        status: st("low_data", [reason]),
      }),
    ]);
    expect(s).toEqual({
      byDepth: { "1": 1, "2": 1 },
      sentenceCounts: { counted: 2, min: 3, max: 6, median: 3, sum: 9 },
      inheriting: 1,
      states: { ok: 0, low_data: 1, not_scored: 1, unknown: 0 },
      reasons: [
        { type: "lowDataIntents", intents: ["Intent 2"], intentCount: 2 },
      ],
      attention: [{ id: hid(2), name: "Intent 2", state: "low_data" }],
    });
  });

  describe("scale: 367 intents", () => {
    const LOWA = 5;
    const LOWB = 200;
    const reason = { type: "lowDataIntents", intents: ["Lowa", "Lowb"] };
    const intents = Array.from({ length: 367 }, (_, i) => {
      const n = i + 1;
      const depth = n <= 11 ? 1 : n <= 98 ? 2 : 3;
      const low = n === LOWA || n === LOWB;
      return mk(n, {
        name: n === LOWA ? "Lowa" : n === LOWB ? "Lowb" : `Intent number ${n}`,
        parentId: depth === 1 ? null : hid(1),
        depth,
        childIds: depth < 3 ? [hid(n + 1)] : [],
        sentenceCount: low ? 2 : 6,
        ...(depth < 3 ? { effectiveSentenceCount: 12 } : {}),
        status: st(low ? "low_data" : "not_scored", [reason]),
      });
    });

    it("produces the exact summary", () => {
      expect(summarize(intents)).toEqual({
        byDepth: { "1": 11, "2": 87, "3": 269 },
        // sorted: two 2s then 365 sixes; index floor(366 / 2) = 183 is a 6
        sentenceCounts: { counted: 367, min: 2, max: 6, median: 6, sum: 2194 },
        inheriting: 98,
        states: { ok: 0, low_data: 2, not_scored: 365, unknown: 0 },
        reasons: [
          {
            type: "lowDataIntents",
            intents: ["Lowa", "Lowb"],
            intentCount: 367,
          },
        ],
        attention: [
          { id: hid(LOWA), name: "Lowa", state: "low_data" },
          { id: hid(LOWB), name: "Lowb", state: "low_data" },
        ],
      });
    });

    it("is under 2000 characters while the full list is over 50000", () => {
      expect(JSON.stringify(summarize(intents)).length).toBeLessThan(2000);
      expect(JSON.stringify(intents).length).toBeGreaterThan(50000);
    });

    it("groups the 367 identical reasons into one", () => {
      expect(groupReasons(intents)).toHaveLength(1);
    });
  });
});
