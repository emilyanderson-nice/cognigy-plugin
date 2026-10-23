/**
 * C3 docs wording: the log summary samples up to 300 entries spread across the
 * matching entries, and its counts describe that sample. Pure reads of the
 * tool definition and the troubleshooting skill.
 */
import { describe, it } from "@jest/globals";

import {
  listDef,
  norm,
  overclaims,
  readRepo,
  section,
} from "./helpers/docText.js";
import { expectExact } from "./helpers/logFixtures.js";

const BANNED = [
  "retained about",
  "kept about",
  "only returned when asked",
  "lags a few seconds",
];

const texts: Array<[string, () => string]> = [
  ["list_resources description", () => String(listDef.description)],
  [
    "troubleshooting SKILL.md '## Read the project logs'",
    () =>
      section(
        readRepo("plugin/skills/troubleshooting/SKILL.md"),
        /^## Read the project logs/i,
      ),
  ],
];

describe("C3 docs: spread sampling wording", () => {
  describe.each(texts)("%s", (label, get) => {
    const spec = (what: string) => ({
      what: `${label}: ${what}`,
      why: "C3: the docs must say the summary reads up to 300 entries spread evenly across the matching entries when there are more than 300, and that its counts describe that sample",
      fix: "add that statement to the text; do not reword the existing retention and privacy claims",
    });

    it("says the summary reads up to 300 entries spread evenly when there are more than 300", () => {
      const t = norm(get());
      expectExact(
        [
          t.length > 0,
          t.includes("up to 300 entries"),
          t.includes("spread evenly"),
          t.includes("more than 300"),
        ],
        [true, true, true, true],
        spec("sampling statement"),
      );
    });

    it("says its counts describe that sample", () => {
      expectExact(
        norm(get()).includes("counts describe that sample"),
        true,
        spec("counts statement"),
      );
    });

    it("has no over-claims and no banned phrases", () => {
      const t = get();
      expectExact(
        [overclaims(t), BANNED.filter((b) => norm(t).includes(b))],
        [[], []],
        spec("over-claims and banned phrases"),
      );
    });
  });
});
