import { describe, it, expect } from "@jest/globals";
import {
  MAX_SPEC_INTENTS,
  parseTreeSpec,
  planTree,
  type TreeSpec,
} from "../tools/intents/treeSpec.js";
import { buildTree, type IntentInput } from "../tools/intents/tree.js";

const json = (v: unknown): string => JSON.stringify(v);

const parse = (v: unknown): TreeSpec => {
  const r = parseTreeSpec(json(v));
  if (!r.ok) throw new Error("expected a valid spec: " + JSON.stringify(r));
  return r.spec;
};

const problemsOf = (v: unknown) => {
  const r = parseTreeSpec(json(v));
  if (r.ok) throw new Error("expected an invalid spec");
  return r;
};

const id = (n: number): string =>
  "bbbbbbbbbbbbbbbbbbbbbb" + n.toString(16).padStart(2, "0");

describe("MAX_SPEC_INTENTS", () => {
  it("is 2000", () => {
    expect(MAX_SPEC_INTENTS).toBe(2000);
  });
});

describe("parseTreeSpec valid specs", () => {
  it("a family only spec gives one level-1 node", () => {
    expect(parseTreeSpec(json({ families: [{ name: "Billing" }] }))).toEqual({
      ok: true,
      spec: {
        nodes: [{ level: 1, path: ["Billing"] }],
        counts: { families: 1, groups: 0, tags: 0 },
      },
    });
  });

  it("a family with empty groups and a group with empty tags are valid", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A", groups: [] },
            { name: "B", groups: [{ name: "G", tags: [] }] },
          ],
        }),
      ),
    ).toEqual({
      ok: true,
      spec: {
        nodes: [
          { level: 1, path: ["A"] },
          { level: 1, path: ["B"] },
          { level: 2, path: ["B", "G"] },
        ],
        counts: { families: 2, groups: 1, tags: 0 },
      },
    });
  });

  it("a missing groups and a missing tags are treated as empty lists", () => {
    expect(
      parseTreeSpec(
        json({ families: [{ name: "A", groups: [{ name: "G" }] }] }),
      ),
    ).toEqual({
      ok: true,
      spec: {
        nodes: [
          { level: 1, path: ["A"] },
          { level: 2, path: ["A", "G"] },
        ],
        counts: { families: 1, groups: 1, tags: 0 },
      },
    });
  });

  it("a family with groups and tags gives three levels with full paths", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            {
              name: "Billing",
              groups: [{ name: "Cards", tags: ["lost card"] }],
            },
          ],
        }),
      ),
    ).toEqual({
      ok: true,
      spec: {
        nodes: [
          { level: 1, path: ["Billing"] },
          { level: 2, path: ["Billing", "Cards"] },
          { level: 3, path: ["Billing", "Cards", "lost card"] },
        ],
        counts: { families: 1, groups: 1, tags: 1 },
      },
    });
  });

  it("orders nodes: all families, then all groups in family order, then all tags in the same order", () => {
    const spec = parse({
      families: [
        {
          name: "F1",
          groups: [
            { name: "G1", tags: ["t1", "t2"] },
            { name: "G2", tags: ["t3"] },
          ],
        },
        { name: "F2", groups: [{ name: "G3", tags: ["t4"] }] },
      ],
    });
    expect(spec).toEqual({
      nodes: [
        { level: 1, path: ["F1"] },
        { level: 1, path: ["F2"] },
        { level: 2, path: ["F1", "G1"] },
        { level: 2, path: ["F1", "G2"] },
        { level: 2, path: ["F2", "G3"] },
        { level: 3, path: ["F1", "G1", "t1"] },
        { level: 3, path: ["F1", "G1", "t2"] },
        { level: 3, path: ["F1", "G2", "t3"] },
        { level: 3, path: ["F2", "G3", "t4"] },
      ],
      counts: { families: 2, groups: 3, tags: 4 },
    });
  });

  it("prefers intent over name, so paths use the intent name", () => {
    const spec = parse({
      families: [
        {
          name: "Label Family",
          intent: "Family Intent",
          groups: [
            { name: "Label Group", intent: "Group Intent", tags: ["tag one"] },
          ],
        },
      ],
    });
    expect(spec.nodes).toEqual([
      { level: 1, path: ["Family Intent"] },
      { level: 2, path: ["Family Intent", "Group Intent"] },
      { level: 3, path: ["Family Intent", "Group Intent", "tag one"] },
    ]);
  });

  it("falls back to name when intent is missing, empty or whitespace", () => {
    const spec = parse({
      families: [
        { name: "FamA" },
        { name: "FamB", intent: "" },
        { name: "FamC", intent: "   " },
        {
          name: "FamD",
          groups: [
            { name: "GrpA", intent: "\t" },
            { name: "GrpB", intent: "" },
          ],
        },
      ],
    });
    expect(spec.nodes).toEqual([
      { level: 1, path: ["FamA"] },
      { level: 1, path: ["FamB"] },
      { level: 1, path: ["FamC"] },
      { level: 1, path: ["FamD"] },
      { level: 2, path: ["FamD", "GrpA"] },
      { level: 2, path: ["FamD", "GrpB"] },
    ]);
  });

  it("accepts a node with only an intent and no name", () => {
    expect(parse({ families: [{ intent: "Only Intent" }] }).nodes).toEqual([
      { level: 1, path: ["Only Intent"] },
    ]);
  });

  it("trims names, intents and tags", () => {
    const spec = parse({
      families: [
        {
          name: "  ignored  ",
          intent: "  Fam  ",
          groups: [{ name: "  Grp ", tags: ["  tag one  "] }],
        },
      ],
    });
    expect(spec.nodes).toEqual([
      { level: 1, path: ["Fam"] },
      { level: 2, path: ["Fam", "Grp"] },
      { level: 3, path: ["Fam", "Grp", "tag one"] },
    ]);
  });

  it("allows the same name in different cases across the whole spec and levels", () => {
    const spec = parse({
      families: [
        { name: "F1", groups: [{ name: "Grp-Case", tags: ["Tag-Case"] }] },
        { name: "F2", groups: [{ name: "grp-case", tags: ["tag-case"] }] },
        { name: "f1" },
      ],
    });
    expect(spec.nodes).toEqual([
      { level: 1, path: ["F1"] },
      { level: 1, path: ["F2"] },
      { level: 1, path: ["f1"] },
      { level: 2, path: ["F1", "Grp-Case"] },
      { level: 2, path: ["F2", "grp-case"] },
      { level: 3, path: ["F1", "Grp-Case", "Tag-Case"] },
      { level: 3, path: ["F2", "grp-case", "tag-case"] },
    ]);
    expect(spec.counts).toEqual({ families: 3, groups: 2, tags: 2 });
  });

  it("names are case-sensitive: Billing and billing are different siblings", () => {
    const spec = parse({
      families: [
        {
          name: "Billing",
          groups: [
            { name: "G", tags: ["Tag"] },
            { name: "g", tags: ["tag"] },
          ],
        },
        { name: "billing" },
      ],
    });
    expect(spec.counts).toEqual({ families: 2, groups: 2, tags: 2 });
  });

  it("accepts a name of exactly 200 characters", () => {
    const name = "n".repeat(200);
    expect(parse({ families: [{ name }] }).nodes).toEqual([
      { level: 1, path: [name] },
    ]);
  });

  it("accepts exactly 2000 nodes", () => {
    const tags = Array.from({ length: 1998 }, (_, i) => `t${i}`);
    const spec = parse({
      families: [{ name: "F", groups: [{ name: "G", tags }] }],
    });
    expect(spec.nodes.length).toBe(2000);
    expect(spec.counts).toEqual({ families: 1, groups: 1, tags: 1998 });
  });

  it("a slash in an unused name does not matter when intent is given", () => {
    expect(
      parse({ families: [{ name: "x/y", intent: "Fine" }] }).nodes,
    ).toEqual([{ level: 1, path: ["Fine"] }]);
  });

  it("a name over 200 characters does not matter when a short intent is given", () => {
    expect(
      parse({ families: [{ name: "n".repeat(201), intent: "Short" }] }).nodes,
    ).toEqual([{ level: 1, path: ["Short"] }]);
  });
});

describe("parseTreeSpec problems", () => {
  it("not_json: invalid JSON is the only problem, path empty", () => {
    expect(parseTreeSpec("{ not json")).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "", reason: "not_json" }],
    });
  });

  it("not_json: empty text", () => {
    expect(parseTreeSpec("")).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "", reason: "not_json" }],
    });
  });

  it.each([["[]"], ["null"], ["42"], ['"text"']])(
    "shape: root %s is not an object",
    (text) => {
      expect(parseTreeSpec(text)).toEqual({
        ok: false,
        count: 1,
        problems: [{ path: "", reason: "shape" }],
      });
    },
  );

  it("shape: families missing", () => {
    expect(parseTreeSpec("{}")).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families", reason: "shape" }],
    });
  });

  it("shape: families not an array", () => {
    expect(parseTreeSpec(json({ families: "x" }))).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families", reason: "shape" }],
    });
  });

  it("shape: families an empty array", () => {
    expect(parseTreeSpec(json({ families: [] }))).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families", reason: "shape" }],
    });
  });

  it("shape: a family that is not an object", () => {
    expect(parseTreeSpec(json({ families: [{ name: "A" }, 7] }))).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[1]", reason: "shape" }],
    });
  });

  it("shape: a family that is null", () => {
    expect(parseTreeSpec(json({ families: [null] }))).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[0]", reason: "shape" }],
    });
  });

  it("shape: groups present but not an array", () => {
    expect(
      parseTreeSpec(
        json({ families: [{ name: "A" }, { name: "B", groups: {} }] }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[1].groups", reason: "shape" }],
    });
  });

  it("shape: a group that is not an object", () => {
    expect(
      parseTreeSpec(
        json({ families: [{ name: "A", groups: [{ name: "G" }, "x"] }] }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[0].groups[1]", reason: "shape" }],
    });
  });

  it("shape: tags present but not an array", () => {
    expect(
      parseTreeSpec(
        json({ families: [{ name: "A", groups: [{ name: "G", tags: "t" }] }] }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[0].groups[0].tags", reason: "shape" }],
    });
  });

  it("shape: a tag that is not a string", () => {
    expect(
      parseTreeSpec(
        json({
          families: [{ name: "A", groups: [{ name: "G", tags: ["ok", 5] }] }],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[0].groups[0].tags[1]", reason: "shape" }],
    });
  });

  it("empty_name: a family with neither intent nor name", () => {
    expect(parseTreeSpec(json({ families: [{ name: "A" }, {}] }))).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[1]", reason: "empty_name" }],
    });
  });

  it("empty_name: a family whose intent and name are blank after trimming", () => {
    expect(
      parseTreeSpec(json({ families: [{ name: "  ", intent: " \t" }] })),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[0]", reason: "empty_name" }],
    });
  });

  it("empty_name: a group with neither intent nor name", () => {
    expect(
      parseTreeSpec(
        json({
          families: [{ name: "A", groups: [{ name: "G" }, { tags: ["t"] }] }],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[0].groups[1]", reason: "empty_name" }],
    });
  });

  it("empty_name: a tag that is empty after trimming", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A", groups: [{ name: "G", tags: ["ok", "  "] }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [
        { path: "families[0].groups[0].tags[1]", reason: "empty_name" },
      ],
    });
  });

  it("empty_name: an empty-string tag", () => {
    expect(
      parseTreeSpec(
        json({
          families: [{ name: "A", groups: [{ name: "G", tags: [""] }] }],
        }),
      ).ok,
    ).toBe(false);
  });

  it("name_too_long: a family of 201 characters", () => {
    expect(
      parseTreeSpec(
        json({ families: [{ name: "a" }, { name: "n".repeat(201) }] }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[1]", reason: "name_too_long" }],
    });
  });

  it("name_too_long: an intent of 201 characters, a group of 201 and a tag of 201", () => {
    const long = "n".repeat(201);
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A", intent: long },
            {
              name: "B",
              groups: [
                {
                  name: long.replace(/n/g, "p"),
                  tags: [long.replace(/n/g, "m")],
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 3,
      problems: [
        { path: "families[0]", reason: "name_too_long" },
        { path: "families[1].groups[0]", reason: "name_too_long" },
        { path: "families[1].groups[0].tags[0]", reason: "name_too_long" },
      ],
    });
  });

  it("name_too_long: length is measured after trimming", () => {
    const padded = "  " + "n".repeat(200) + "  ";
    expect(parseTreeSpec(json({ families: [{ name: padded }] })).ok).toBe(true);
  });

  it("slash_in_name: a family, a group and a tag", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A/B" },
            { name: "C", groups: [{ name: "G/H", tags: ["t/u"] }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 3,
      problems: [
        { path: "families[0]", reason: "slash_in_name" },
        { path: "families[1].groups[0]", reason: "slash_in_name" },
        { path: "families[1].groups[0].tags[0]", reason: "slash_in_name" },
      ],
    });
  });

  it("slash_in_name: applies to the intent name when intent is given", () => {
    expect(
      parseTreeSpec(json({ families: [{ name: "Fine", intent: "a/b" }] })),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[0]", reason: "slash_in_name" }],
    });
  });

  it("duplicate_sibling: two families with the same intent name, at the second", () => {
    expect(
      parseTreeSpec(
        json({ families: [{ name: "A" }, { name: "B" }, { name: "A" }] }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[2]", reason: "duplicate_sibling" }],
    });
  });

  it("duplicate_sibling: duplicates are found after trimming", () => {
    expect(
      parseTreeSpec(json({ families: [{ name: "A" }, { name: " A " }] })),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[1]", reason: "duplicate_sibling" }],
    });
  });

  it("duplicate_sibling: families compare by intent name, not label", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "L1", intent: "X" },
            { name: "L2", intent: "X" },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[1]", reason: "duplicate_sibling" }],
    });
  });

  it("same label with different intents is not a duplicate", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "Same", intent: "X" },
            { name: "Same", intent: "Y" },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it("duplicate_sibling: two groups with the same name under one family", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            {
              name: "A",
              groups: [{ name: "G" }, { name: "H" }, { name: "G" }],
            },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [
        { path: "families[0].groups[2]", reason: "duplicate_sibling" },
      ],
    });
  });

  it("duplicate_sibling: two tags with the same name under one group (not duplicate_tag)", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A", groups: [{ name: "G", tags: ["t", "u", "t"] }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [
        { path: "families[0].groups[0].tags[2]", reason: "duplicate_sibling" },
      ],
    });
  });

  it("duplicate_name: the same tag under a different group of the same family, at the later occurrence", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            {
              name: "A",
              groups: [
                { name: "G1", tags: ["t"] },
                { name: "G2", tags: ["u", "t"] },
              ],
            },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [
        { path: "families[0].groups[1].tags[1]", reason: "duplicate_name" },
      ],
    });
  });

  it("duplicate_name: the same tag under a group of a different family", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A", groups: [{ name: "G1", tags: ["t"] }] },
            { name: "B", groups: [{ name: "G2", tags: ["t"] }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [
        { path: "families[1].groups[0].tags[0]", reason: "duplicate_name" },
      ],
    });
  });

  it("duplicate_name: the same group name under a different family, and its same-named tags too (two problems, group first)", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A", groups: [{ name: "G", tags: ["t"] }] },
            { name: "B", groups: [{ name: "G", tags: ["t"] }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 2,
      problems: [
        { path: "families[1].groups[0]", reason: "duplicate_name" },
        { path: "families[1].groups[0].tags[0]", reason: "duplicate_name" },
      ],
    });
  });

  it("duplicate_name: a group with the name of a family that is not its parent", () => {
    expect(
      parseTreeSpec(
        json({
          families: [{ name: "A" }, { name: "B", groups: [{ name: "A" }] }],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[1].groups[0]", reason: "duplicate_name" }],
    });
  });

  it("duplicate_name: a group with the name of its own parent family", () => {
    expect(
      parseTreeSpec(
        json({ families: [{ name: "A", groups: [{ name: "A" }] }] }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[0].groups[0]", reason: "duplicate_name" }],
    });
  });

  it("duplicate_name: a tag with the name of a family in another branch", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "X" },
            { name: "F", groups: [{ name: "G", tags: ["ok", "X"] }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [
        { path: "families[1].groups[0].tags[1]", reason: "duplicate_name" },
      ],
    });
  });

  it("duplicate_name: a tag with the name of its own group", () => {
    expect(
      parseTreeSpec(
        json({
          families: [{ name: "F", groups: [{ name: "G", tags: ["G"] }] }],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [
        { path: "families[0].groups[0].tags[0]", reason: "duplicate_name" },
      ],
    });
  });

  it("duplicate_name: the intent field decides the name, not the label", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "Label", intent: "X" },
            { name: "Y", groups: [{ name: "Other label", intent: "X" }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[1].groups[0]", reason: "duplicate_name" }],
    });
  });

  it("duplicate_name: names differing only by surrounding whitespace in different branches", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "F1", groups: [{ name: "Grp " }] },
            { name: "F2", groups: [{ name: "Grp" }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "families[1].groups[0]", reason: "duplicate_name" }],
    });
  });

  it("duplicate_name: names differing only by case in different branches are not duplicates", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "F1", groups: [{ name: "Grp-Case" }] },
            { name: "F2", groups: [{ name: "grp-case" }] },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it("duplicate_sibling wins when the later occurrence shares a parent with ANY earlier one, never both reasons", () => {
    // first t is under A/G1; the second t (B/G2) is a duplicate_name; the third t
    // is a sibling of the second, so it is a duplicate_sibling and not also a duplicate_name
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A", groups: [{ name: "G1", tags: ["t"] }] },
            { name: "B", groups: [{ name: "G2", tags: ["t", "t"] }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 2,
      problems: [
        { path: "families[1].groups[0].tags[0]", reason: "duplicate_name" },
        { path: "families[1].groups[0].tags[1]", reason: "duplicate_sibling" },
      ],
    });
  });

  it("a family and a group with the same name that share no parent is a duplicate_name, not a sibling", () => {
    // two root families named X (sibling) and a group named X elsewhere (name)
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "X" },
            { name: "X" },
            { name: "F", groups: [{ name: "X" }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 2,
      problems: [
        { path: "families[1]", reason: "duplicate_sibling" },
        { path: "families[2].groups[0]", reason: "duplicate_name" },
      ],
    });
  });

  it("an empty name is not registered: two empty groups report only empty_name", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A", groups: [{ name: "" }] },
            { name: "B", groups: [{ name: "   " }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 2,
      problems: [
        { path: "families[0].groups[0]", reason: "empty_name" },
        { path: "families[1].groups[0]", reason: "empty_name" },
      ],
    });
  });

  it("duplicate_name counts every later occurrence and lists the first 20 (25 later duplicates)", () => {
    const families = Array.from({ length: 26 }, (_, i) => ({
      name: `F${i}`,
      groups: [{ name: "g" }],
    }));
    const r = problemsOf({ families });
    expect(r.count).toBe(25);
    expect(r.problems).toEqual(
      Array.from({ length: 20 }, (_, i) => ({
        path: `families[${i + 1}].groups[0]`,
        reason: "duplicate_name",
      })),
    );
  });

  it("duplicate_name: tag names are compared case-sensitively and after trimming", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            {
              name: "A",
              groups: [
                { name: "G1", tags: ["t", "Tag"] },
                { name: "G2", tags: ["T", " t "] },
              ],
            },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [
        { path: "families[0].groups[1].tags[1]", reason: "duplicate_name" },
      ],
    });
  });

  it("the reason duplicate_tag no longer appears for any duplicate tag", () => {
    expect(
      JSON.stringify(
        parseTreeSpec(
          json({
            families: [
              {
                name: "A",
                groups: [
                  { name: "G1", tags: ["t"] },
                  { name: "G2", tags: ["t"] },
                ],
              },
            ],
          }),
        ),
      ),
    ).not.toContain("duplicate_tag");
  });

  it("too_many_intents: 2001 nodes gives one problem with an empty path", () => {
    const tags = Array.from({ length: 1999 }, (_, i) => `t${i}`);
    expect(
      parseTreeSpec(
        json({ families: [{ name: "F", groups: [{ name: "G", tags }] }] }),
      ),
    ).toEqual({
      ok: false,
      count: 1,
      problems: [{ path: "", reason: "too_many_intents" }],
    });
  });

  it("collects problems in encounter order, depth-first per family", () => {
    expect(
      parseTreeSpec(
        json({
          families: [
            { name: "A", groups: [{ name: "" }, { name: "G/H" }] },
            { name: "A" },
            { name: "", groups: [{ name: "X", tags: ["t", "t"] }] },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      count: 5,
      problems: [
        { path: "families[0].groups[0]", reason: "empty_name" },
        { path: "families[0].groups[1]", reason: "slash_in_name" },
        { path: "families[1]", reason: "duplicate_sibling" },
        { path: "families[2]", reason: "empty_name" },
        { path: "families[2].groups[0].tags[1]", reason: "duplicate_sibling" },
      ],
    });
  });

  it("count is the total and problems is capped at the first 20 (25 problems)", () => {
    const families = Array.from({ length: 25 }, () => ({ name: "" }));
    const r = problemsOf({ families });
    expect(r.count).toBe(25);
    expect(r.problems).toEqual(
      Array.from({ length: 20 }, (_, i) => ({
        path: `families[${i}]`,
        reason: "empty_name",
      })),
    );
  });

  it("exactly 20 problems are all listed", () => {
    const families = Array.from({ length: 20 }, () => ({ name: "" }));
    const r = problemsOf({ families });
    expect(r.count).toBe(20);
    expect(r.problems.length).toBe(20);
  });
});

describe("planTree", () => {
  const spec = (): TreeSpec =>
    parse({
      families: [
        {
          name: "Billing",
          groups: [
            { name: "Cards", tags: ["lost card", "new card"] },
            { name: "Plans", tags: ["upgrade plan"] },
          ],
        },
      ],
    });

  it("on an empty tree creates everything with parentPath null for level 1", () => {
    expect(planTree(spec(), buildTree([]))).toEqual({
      existing: [],
      create: [
        { path: ["Billing"], level: 1, parentPath: null },
        { path: ["Billing", "Cards"], level: 2, parentPath: ["Billing"] },
        { path: ["Billing", "Plans"], level: 2, parentPath: ["Billing"] },
        {
          path: ["Billing", "Cards", "lost card"],
          level: 3,
          parentPath: ["Billing", "Cards"],
        },
        {
          path: ["Billing", "Cards", "new card"],
          level: 3,
          parentPath: ["Billing", "Cards"],
        },
        {
          path: ["Billing", "Plans", "upgrade plan"],
          level: 3,
          parentPath: ["Billing", "Plans"],
        },
      ],
    });
  });

  it("on a fully existing tree reports everything as existing with the right ids", () => {
    const items: IntentInput[] = [
      { id: id(1), name: "Billing", parentId: null },
      { id: id(2), name: "Cards", parentId: id(1) },
      { id: id(3), name: "Plans", parentId: id(1) },
      { id: id(4), name: "lost card", parentId: id(2) },
      { id: id(5), name: "new card", parentId: id(2) },
      { id: id(6), name: "upgrade plan", parentId: id(3) },
    ];
    expect(planTree(spec(), buildTree(items))).toEqual({
      existing: [
        { path: ["Billing"], level: 1, id: id(1) },
        { path: ["Billing", "Cards"], level: 2, id: id(2) },
        { path: ["Billing", "Plans"], level: 2, id: id(3) },
        { path: ["Billing", "Cards", "lost card"], level: 3, id: id(4) },
        { path: ["Billing", "Cards", "new card"], level: 3, id: id(5) },
        { path: ["Billing", "Plans", "upgrade plan"], level: 3, id: id(6) },
      ],
      create: [],
    });
  });

  it("on a partial tree creates only the missing group and tags, keeping spec order in both lists", () => {
    const items: IntentInput[] = [
      { id: id(1), name: "Billing", parentId: null },
      { id: id(2), name: "Cards", parentId: id(1) },
      { id: id(4), name: "lost card", parentId: id(2) },
    ];
    expect(planTree(spec(), buildTree(items))).toEqual({
      existing: [
        { path: ["Billing"], level: 1, id: id(1) },
        { path: ["Billing", "Cards"], level: 2, id: id(2) },
        { path: ["Billing", "Cards", "lost card"], level: 3, id: id(4) },
      ],
      create: [
        { path: ["Billing", "Plans"], level: 2, parentPath: ["Billing"] },
        {
          path: ["Billing", "Cards", "new card"],
          level: 3,
          parentPath: ["Billing", "Cards"],
        },
        {
          path: ["Billing", "Plans", "upgrade plan"],
          level: 3,
          parentPath: ["Billing", "Plans"],
        },
      ],
    });
  });

  it("does not match a same-named child that sits under a different parent", () => {
    const s = parse({
      families: [
        { name: "Billing", groups: [{ name: "Cards" }] },
        { name: "Support", groups: [{ name: "Wallet" }] },
      ],
    });
    const items: IntentInput[] = [
      { id: id(1), name: "Billing", parentId: null },
      { id: id(2), name: "Support", parentId: null },
      { id: id(3), name: "Cards", parentId: id(2) },
      { id: id(4), name: "Wallet", parentId: id(2) },
    ];
    expect(planTree(s, buildTree(items))).toEqual({
      existing: [
        { path: ["Billing"], level: 1, id: id(1) },
        { path: ["Support"], level: 1, id: id(2) },
        { path: ["Support", "Wallet"], level: 2, id: id(4) },
      ],
      create: [
        { path: ["Billing", "Cards"], level: 2, parentPath: ["Billing"] },
      ],
    });
  });

  it("matches an existing node by trimmed name: a flow name with a trailing or leading space counts as existing", () => {
    const items: IntentInput[] = [
      { id: id(1), name: " Billing", parentId: null },
      { id: id(2), name: "Cards ", parentId: id(1) },
      { id: id(4), name: "lost card ", parentId: id(2) },
    ];
    expect(planTree(spec(), buildTree(items))).toEqual({
      existing: [
        { path: ["Billing"], level: 1, id: id(1) },
        { path: ["Billing", "Cards"], level: 2, id: id(2) },
        { path: ["Billing", "Cards", "lost card"], level: 3, id: id(4) },
      ],
      create: [
        { path: ["Billing", "Plans"], level: 2, parentPath: ["Billing"] },
        {
          path: ["Billing", "Cards", "new card"],
          level: 3,
          parentPath: ["Billing", "Cards"],
        },
        {
          path: ["Billing", "Plans", "upgrade plan"],
          level: 3,
          parentPath: ["Billing", "Plans"],
        },
      ],
    });
  });

  it("trimmed matching is still case-sensitive and still needs the same parent", () => {
    const s = parse({
      families: [{ name: "Billing", groups: [{ name: "Cards" }] }],
    });
    const items: IntentInput[] = [
      { id: id(1), name: "Billing ", parentId: null },
      { id: id(2), name: "cards ", parentId: id(1) },
      { id: id(3), name: "Cards ", parentId: null },
    ];
    expect(planTree(s, buildTree(items))).toEqual({
      existing: [{ path: ["Billing"], level: 1, id: id(1) }],
      create: [
        { path: ["Billing", "Cards"], level: 2, parentPath: ["Billing"] },
      ],
    });
  });

  it("a root intent with the group's name does not satisfy a level-2 node", () => {
    const s = parse({
      families: [{ name: "Billing", groups: [{ name: "Cards" }] }],
    });
    const items: IntentInput[] = [
      { id: id(1), name: "Billing", parentId: null },
      { id: id(2), name: "Cards", parentId: null },
    ];
    expect(planTree(s, buildTree(items))).toEqual({
      existing: [{ path: ["Billing"], level: 1, id: id(1) }],
      create: [
        { path: ["Billing", "Cards"], level: 2, parentPath: ["Billing"] },
      ],
    });
  });

  it("a child-level intent with a family's name does not satisfy a level-1 node", () => {
    const s = parse({ families: [{ name: "Cards" }] });
    const items: IntentInput[] = [
      { id: id(1), name: "Billing", parentId: null },
      { id: id(2), name: "Cards", parentId: id(1) },
    ];
    expect(planTree(s, buildTree(items))).toEqual({
      existing: [],
      create: [{ path: ["Cards"], level: 1, parentPath: null }],
    });
  });

  it("a node whose parent does not exist is created even if the name exists elsewhere", () => {
    const s = parse({
      families: [
        { name: "NewFamily", groups: [{ name: "Cards", tags: ["lost card"] }] },
      ],
    });
    const items: IntentInput[] = [
      { id: id(1), name: "Support", parentId: null },
      { id: id(2), name: "Cards", parentId: id(1) },
      { id: id(3), name: "lost card", parentId: id(2) },
    ];
    expect(planTree(s, buildTree(items))).toEqual({
      existing: [],
      create: [
        { path: ["NewFamily"], level: 1, parentPath: null },
        { path: ["NewFamily", "Cards"], level: 2, parentPath: ["NewFamily"] },
        {
          path: ["NewFamily", "Cards", "lost card"],
          level: 3,
          parentPath: ["NewFamily", "Cards"],
        },
      ],
    });
  });

  it("when the flow holds duplicate siblings the first one wins, at every level", () => {
    const s = parse({
      families: [
        { name: "Billing", groups: [{ name: "Cards", tags: ["lost card"] }] },
      ],
    });
    const items: IntentInput[] = [
      { id: id(1), name: "Billing", parentId: null },
      { id: id(2), name: "Billing", parentId: null },
      { id: id(3), name: "Cards", parentId: id(1) },
      { id: id(4), name: "Cards", parentId: id(1) },
      { id: id(5), name: "lost card", parentId: id(3) },
      { id: id(6), name: "lost card", parentId: id(3) },
    ];
    expect(planTree(s, buildTree(items))).toEqual({
      existing: [
        { path: ["Billing"], level: 1, id: id(1) },
        { path: ["Billing", "Cards"], level: 2, id: id(3) },
        { path: ["Billing", "Cards", "lost card"], level: 3, id: id(5) },
      ],
      create: [],
    });
  });

  it("children under a later duplicate parent are not considered", () => {
    const s = parse({
      families: [{ name: "Billing", groups: [{ name: "Cards" }] }],
    });
    const items: IntentInput[] = [
      { id: id(1), name: "Billing", parentId: null },
      { id: id(2), name: "Billing", parentId: null },
      { id: id(3), name: "Cards", parentId: id(2) },
    ];
    expect(planTree(s, buildTree(items))).toEqual({
      existing: [{ path: ["Billing"], level: 1, id: id(1) }],
      create: [
        { path: ["Billing", "Cards"], level: 2, parentPath: ["Billing"] },
      ],
    });
  });

  it("matching is exact and case-sensitive", () => {
    const s = parse({ families: [{ name: "Billing" }] });
    const items: IntentInput[] = [
      { id: id(1), name: "billing", parentId: null },
    ];
    expect(planTree(s, buildTree(items))).toEqual({
      existing: [],
      create: [{ path: ["Billing"], level: 1, parentPath: null }],
    });
  });

  it("keeps spec order in both lists when existing and missing nodes interleave", () => {
    const s = parse({
      families: [
        { name: "F1", groups: [{ name: "G1" }] },
        { name: "F2", groups: [{ name: "G2" }] },
        { name: "F3" },
      ],
    });
    const items: IntentInput[] = [
      { id: id(1), name: "F2", parentId: null },
      { id: id(2), name: "G1", parentId: id(9) },
      { id: id(9), name: "F1", parentId: null },
    ];
    expect(planTree(s, buildTree(items))).toEqual({
      existing: [
        { path: ["F1"], level: 1, id: id(9) },
        { path: ["F2"], level: 1, id: id(1) },
        { path: ["F1", "G1"], level: 2, id: id(2) },
      ],
      create: [
        { path: ["F3"], level: 1, parentPath: null },
        { path: ["F2", "G2"], level: 2, parentPath: ["F2"] },
      ],
    });
  });
});
