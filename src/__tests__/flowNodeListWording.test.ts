import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tools } from "../tools/definitions.js";

const skill = readFileSync(
  fileURLToPath(
    new URL("../../plugin/skills/flow-nodes/SKILL.md", import.meta.url),
  ),
  "utf8",
).replace(/\r\n/g, "\n");

const description = (tools.find((t) => t.name === "manage_flow_nodes") as any)
  ?.description as string;

describe("manage_flow_nodes list wording", () => {
  it("the tool description exists", () => {
    expect(typeof description).toBe("string");
  });

  it.each([
    ["tool description", () => description],
    ["flow-nodes SKILL.md", () => skill],
  ])("%s mentions truncated and totalAvailable", (_l, get) => {
    expect(get()).toContain("truncated");
    expect(get()).toContain("totalAvailable");
  });

  it.each([
    ["tool description", () => description],
    ["flow-nodes SKILL.md", () => skill],
  ])("%s has no capitalised 'ALL nodes'", (_l, get) => {
    expect(get()).not.toContain("ALL nodes");
  });

  describe("parentId semantics (forward traversal)", () => {
    const texts: [string, () => string][] = [
      ["tool description", () => description],
      ["flow-nodes SKILL.md", () => skill],
    ];

    it.each(texts)(
      "%s: parentId is the container for branch heads and the branch head for chained nodes",
      (_l, get) => {
        expect(get()).toMatch(/container/i);
        expect(get()).toMatch(/branch head/i);
      },
    );

    it.each(texts)(
      "%s: parentId is null only on the top-level chain",
      (_l, get) => {
        expect(get()).toMatch(/null only on the top-level chain/i);
      },
    );

    it.each(texts)(
      "%s: the old 'null at top level' wording is gone",
      (_l, get) => {
        expect(get()).not.toMatch(/null`? at top level/);
        expect(get()).not.toMatch(/null`? for top-level nodes/);
      },
    );

    it.each(texts)(
      "%s: the fallback statement 'parentId is null for every node' stays",
      (_l, get) => {
        expect(get()).toMatch(/parentId`? is null for every node/);
      },
    );
  });

  it("SKILL.md says referenceId is reportedly a UUID", () => {
    expect(skill).toContain("reportedly a UUID");
  });

  it("SKILL.md has no double blank line before '## Naming and comments'", () => {
    expect(skill).toContain("## Naming and comments");
    expect(skill).not.toMatch(/\n\n\n+## Naming and comments/);
  });
});
