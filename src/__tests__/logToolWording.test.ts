/**
 * Wording tests for list_resources { resourceType: "log" } (amendments A6, A12,
 * A14e): no text may claim end-user text is never returned/shown/exposed/
 * revealed/included (any paraphrase); the one truthful statement names
 * meta.text and meta.URLToken explicitly and says msg is scrubbed best-effort.
 * Pure reads of the tool definition and repo files; no client.
 */
import { describe, it } from "@jest/globals";

import { expectExact } from "./helpers/logFixtures.js";
import {
  LOG_DOC_FILES,
  LOG_HEADING,
  definitionLogTexts,
  listDef,
  norm,
  overclaims,
  readRepo,
  section,
} from "./helpers/docText.js";

const OVERCLAIM_FIX =
  "say that meta.text and meta.URLToken are never included in the output (one sentence naming both) and that msg is scrubbed best-effort and may still contain personal data; do not say end-user text is never returned, shown, exposed, revealed or included";

describe("log wording: the over-claim detector itself (A14e)", () => {
  it.each([
    "End-user text is never returned.",
    "End-user text is never shown to the model.",
    "End-user text is never exposed.",
    "User messages are never revealed in the output.",
    "The user's text is never included in the result.",
    "Customer data is never displayed.",
    "Never returned: end-user text.",
    "What the user typed never leaves the platform.",
    "Output omits user text and endpoint credentials.",
  ])("flags the paraphrase %p", (sentence) => {
    expectExact(overclaims(sentence).length > 0, true, {
      what: `detector verdict for ${JSON.stringify(sentence)}`,
      why: "A14e: paraphrases of 'end-user text is never returned' must be caught by the blacklist regex",
      fix: "extend OVERCLAIM_PATTERNS in helpers/docText.ts",
    });
  });

  it("allows the truthful sentence that names meta.text and meta.URLToken", () => {
    expectExact(
      overclaims(
        "meta.text and meta.URLToken are never returned. Message text is scrubbed best-effort and may still contain personal data.",
      ),
      [],
      {
        what: "detector verdict for the truthful sentence",
        why: "A14e: the sentence naming meta.text and meta.URLToken is the allowed truthful statement",
        fix: "keep the allowed-sentence filter in overclaims()",
      },
    );
  });
});

describe("log wiring: honest wording (amendments A6, A12, A14e)", () => {
  it.each(definitionLogTexts())(
    "list_resources %s makes no over-claim about user text",
    (label, text) => {
      expectExact(overclaims(text), [], {
        what: `list_resources ${label} over-claim`,
        why: "A6/A14e: msg text is returned (scrubbed best-effort); only meta.text and meta.URLToken are withheld, so no sentence may say user text is never returned/shown/exposed/revealed/included",
        fix: OVERCLAIM_FIX,
      });
    },
  );

  it("the description says msg text is scrubbed on a best-effort basis", () => {
    const d = norm(String(listDef.description));
    const ok =
      /best[- ]effort/.test(d) && /scrub/.test(d) && /message|msg/.test(d);
    expectExact(ok, true, {
      what: "list_resources description best-effort scrub statement",
      why: "A6: the truthful statement is that message text is scrubbed best-effort",
      fix: "add e.g. 'meta.text and meta.URLToken are never included in the output; message text is scrubbed best-effort (emails, tokens, long digit runs) and may still contain personal data.'",
    });
  });

  it("the description no longer says the log case returns 'a paginated list'", () => {
    const description = String(listDef.description);
    const oldSentence =
      "Returns a paginated list with id, name, and type-specific fields.";
    const sentences = description
      .split(/(?<=[.!?])\s+/)
      .filter((s) => /paginated list/i.test(s));
    const unqualified = sentences.filter(
      (s) => !/except|other than|non-log|not for (the )?log/i.test(s),
    );
    expectExact([description.includes(oldSentence), unqualified], [false, []], {
      what: "'Returns a paginated list...' sentence in list_resources description",
      why: "A6: the log case returns a summary or entries body, not a paginated list, so the sentence must be removed or explicitly exclude log",
      fix: "reword to 'For every type except log, returns a paginated list with id, name, and type-specific fields.' or drop the claim for log",
    });
  });

  it.each(LOG_DOC_FILES)(
    "%s: log section is found, has no over-claim anywhere in the file and says best-effort",
    (rel, heading) => {
      const whole = readRepo(rel);
      const log = norm(section(whole, heading));
      expectExact(
        [log.length > 0, overclaims(whole), log.includes("best-effort")],
        [true, [], true],
        {
          what: `${rel} log wording`,
          why: "A6/A12/A14e: the file must not say end-user text is never returned/shown/exposed/revealed/included/leaves, and its log section must say message scrubbing is best-effort",
          fix: OVERCLAIM_FIX,
        },
      );
    },
  );

  it("README.md log section says meta.text and meta.URLToken are never returned and msg may contain personal data (A12)", () => {
    const log = norm(section(readRepo("README.md"), LOG_HEADING));
    expectExact(
      [
        log.includes("meta.text"),
        log.includes("meta.urltoken"),
        log.includes("personal data"),
      ],
      [true, true, true],
      {
        what: "README.md section 'Read the project logs after a test'",
        why: "A12: the README must state precisely what is withheld (meta.text, meta.URLToken) and warn that scrubbed message text may still hold personal data",
        fix: "add: meta.text and meta.URLToken are never returned; message text is scrubbed best-effort and may still contain personal data",
      },
    );
  });
});
