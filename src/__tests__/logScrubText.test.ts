import { describe, it } from "@jest/globals";

import {
  MAX_MESSAGE_CHARS,
  MAX_TEMPLATE_CHARS,
  MAX_SCRUB_INPUT_CHARS,
  scrubText,
  messageTemplate,
} from "../tools/logScrub.js";
import { expectExact, e } from "./helpers/logFixtures.js";

describe("logScrub constants", () => {
  it("exposes the documented limits", () => {
    expectExact(
      [MAX_MESSAGE_CHARS, MAX_TEMPLATE_CHARS, MAX_SCRUB_INPUT_CHARS],
      [500, 200, 2000],
      {
        what: "exported limit constants",
        why: "contract (amendment A4) fixes message=500, template=200, scrub input=2000 so regex cost is bounded",
        fix: "export const MAX_MESSAGE_CHARS = 500 etc.",
      },
    );
  });
});

describe("scrubText: non-string input", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["object", { a: 1 }],
    ["array", ["x"]],
    ["boolean", true],
  ])("returns the empty string for %s", (_label, input) => {
    expectExact(scrubText(input, 500), "", {
      what: `scrubText(${_label}) must return ""`,
      why: "non-string input (null/undefined/number/object) yields an empty string",
      fix: "guard with typeof input !== 'string' and return '' before any processing",
    });
  });
});

describe("scrubText: whitespace", () => {
  it("collapses every whitespace run to one space and trims", () => {
    expectExact(scrubText("  a \n\t b   c  \r\n", 500), "a b c", {
      what: "whitespace collapse + trim",
      why: "step 2 collapses runs of whitespace to a single space and trims",
      fix: "replace /\\s+/g with ' ' then trim()",
    });
  });
});

describe("scrubText: masking steps", () => {
  const cases: Array<[string, string, string]> = [
    ["email", "contact john.doe@example.com now", "contact <email> now"],
    ["two emails", "a@b.io and c.d+e@f.org", "<email> and <email>"],
    [
      "JWT",
      "tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij_-KLM end",
      "tok <token> end",
    ],
    [
      "JWT with 45-char segments is ONE token (JWT step runs before the long-run step)",
      `${"a".repeat(45)}.${"b".repeat(45)}.${"c".repeat(45)}`,
      "<token>",
    ],
    [
      "Bearer keeps the word",
      "Authorization: Bearer abc123",
      "Authorization: Bearer <token>",
    ],
    [
      "Bearer with a 9-digit token becomes <token> not <digits>",
      "Bearer 123456789",
      "Bearer <token>",
    ],
    ["40-letter opaque run", "x".repeat(40), "<token>"],
    ["39-letter run survives", "x".repeat(39), "x".repeat(39)],
    [
      "mixed 40 alnum run inside text",
      `key=${"a1".repeat(20)} ok`,
      "key=<token> ok",
    ],
    [
      "45-digit run is <token> (long-run step before digit step)",
      "9".repeat(45),
      "<token>",
    ],
    [
      "UUID survives (hyphens break the run)",
      "id 123e4567-e89b-12d3-a456-4266abcd1740 done",
      "id 123e4567-e89b-12d3-a456-4266abcd1740 done",
    ],
    [
      "24-hex id survives",
      "obj 507f1f77bcf86cd7994a9011 ok",
      "obj 507f1f77bcf86cd7994a9011 ok",
    ],
    [
      "real 24-hex id containing a 9-digit run is unchanged",
      "507f1f77bcf86cd799439011",
      "507f1f77bcf86cd799439011",
    ],
    [
      "24-hex id embedded in a sentence is unchanged",
      "object 507f1f77bcf86cd799439011 not found",
      "object 507f1f77bcf86cd799439011 not found",
    ],
    [
      "UUID with an all-digit 12-char last segment is unchanged",
      "123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-12d3-a456-426614174000",
    ],
    [
      "UUID with all-digit last segment embedded in a sentence is unchanged",
      "session 123e4567-e89b-12d3-a456-426614174000 closed",
      "session 123e4567-e89b-12d3-a456-426614174000 closed",
    ],
    ["bare 9-digit run after a word", "order 123456789", "order <digits>"],
    [
      "9-digit run after a hyphen is still masked",
      "555-123456789",
      "555-<digits>",
    ],
    ["9-digit run", "call 123456789 now", "call <digits> now"],
    ["12-digit run is a single <digits>", "n 123456789012 x", "n <digits> x"],
    ["8-digit run survives", "n 12345678 x", "n 12345678 x"],
    [
      "email containing a 9+ digit run is <email> (email step before digits)",
      "user123456789@example.com",
      "<email>",
    ],
  ];
  it.each(cases)("%s", (label, input, expected) => {
    expectExact(scrubText(input, 500), expected, {
      what: `scrubText masking: ${label}`,
      why: "steps 3-6 of the contract mask emails, JWT/Bearer, 40+ alnum runs, 9+ digit runs, in that order",
      fix: "apply email, JWT/Bearer, long-run, digit-run replacements in exactly that order",
    });
  });
});

describe("scrubText: truncation", () => {
  it("cuts to exactly maxChars ending in the single character …", () => {
    const out = scrubText("abc ".repeat(150), 500) as string;
    expectExact(out, `${"abc ".repeat(124)}abc…`, {
      what: "600-char message truncated to 500",
      why: "truncated length is exactly maxChars and ends with one ellipsis char",
      fix: "slice(0, maxChars - 1) + '…'",
    });
    expectExact(out.length, 500, {
      what: "truncated length",
      why: "total length is exactly maxChars",
      fix: "maxChars - 1 characters plus the ellipsis",
    });
  });

  it("leaves a string of exactly maxChars untouched", () => {
    expectExact(
      scrubText(`${"abc ".repeat(124)}abcd`, 500),
      `${"abc ".repeat(124)}abcd`,
      {
        what: "500-char message at the boundary",
        why: "only strings LONGER than maxChars are truncated",
        fix: "compare length > maxChars",
      },
    );
  });

  it("truncates 501 chars", () => {
    expectExact(
      scrubText(`${"abc ".repeat(124)}abcde`, 500),
      `${"abc ".repeat(124)}abc…`,
      {
        what: "501-char message",
        why: "one char over the cap is truncated",
        fix: "compare length > maxChars",
      },
    );
  });

  it("works for a small cap", () => {
    expectExact(scrubText("abcdefghij", 5), "abcd…", {
      what: "maxChars=5",
      why: "result is maxChars-1 chars plus the ellipsis",
      fix: "slice(0, maxChars - 1) + '…'",
    });
  });

  it("masks a token that straddles the cap BEFORE truncating (no partial token leaks)", () => {
    const input = `${"a ".repeat(245)}${"Q".repeat(60)}`;
    expectExact(scrubText(input, 500), `${"a ".repeat(245)}<token>`, {
      what: "token starting at char 490 of a 550-char message",
      why: "step 7 truncation happens after masking, so the 60-char token is already <token> (497 chars, no cut)",
      fix: "move truncation to the last step",
    });
  });

  it("masks first then cuts: small cap lands inside the mask text, not the secret", () => {
    expectExact(scrubText(`word ${"Z".repeat(50)} tail`, 10), "word <tok…", {
      what: "cap of 10 over 'word <token> tail'",
      why: "scrub happens first, so the cut is applied to the masked text",
      fix: "truncate last; the result must never contain any Z characters",
    });
  });

  it("does not truncate when masking makes the text fit the cap", () => {
    expectExact(
      scrubText(`word ${"Z".repeat(50)} tail`, 20),
      "word <token> tail",
      {
        what: "cap of 20 over a 61-char raw message that masks to 17 chars",
        why: "length is measured after scrubbing",
        fix: "truncate only after masking",
      },
    );
  });
});

describe("scrubText: 2000-character input cut (amendment A4)", () => {
  it("cuts the input to 2000 characters before anything else", () => {
    const input = `${"a ".repeat(1000)}TAILMARKER`;
    expectExact(scrubText(input, 1_000_000), `${"a ".repeat(999)}a`, {
      what: "input longer than MAX_SCRUB_INPUT_CHARS",
      why: "step 1 keeps only the first 2000 characters; content after is gone (TAILMARKER must not survive)",
      fix: "input.slice(0, MAX_SCRUB_INPUT_CHARS) first (MAX_SCRUB_INPUT_CHARS = 2000), then the rest of the pipeline",
    });
  });

  it("cuts at exactly 2000 characters", () => {
    expectExact(
      scrubText("ab ".repeat(1000), 1_000_000),
      `${"ab ".repeat(666)}ab`,
      {
        what: "3000-char input cut at 2000",
        why: "characters 1..2000 are kept: 666 repetitions of 'ab ' (1998 chars) plus 'ab'",
        fix: "slice(0, 2000)",
      },
    );
  });

  it("keeps a 2000-character input whole", () => {
    expectExact(
      scrubText(`${"ab ".repeat(666)}ab`, 1_000_000),
      `${"ab ".repeat(666)}ab`,
      {
        what: "input of exactly MAX_SCRUB_INPUT_CHARS characters",
        why: "only input LONGER than the cap is cut",
        fix: "do not cut at or below 2000 characters",
      },
    );
  });
});

describe("hostile input stays fast (amendments A4, A13)", () => {
  const shapes: Array<[string, string]> = [
    ["all letters", "a".repeat(2000)],
    ["a- repeated", "a-".repeat(1000)],
    ["a. repeated", "a.".repeat(1000)],
    ["a@ repeated", "a@".repeat(1000)],
  ];
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[3];
  const functions: Array<[string, (s: string) => unknown]> = [
    ["scrubText", (s) => scrubText(s, 500)],
    ["messageTemplate", (s) => messageTemplate(s)],
  ];
  const cases = functions.flatMap(([fn, call]) =>
    shapes.map(
      ([label, input]) =>
        [fn, label, input, call] as [
          string,
          string,
          string,
          (s: string) => unknown,
        ],
    ),
  );
  it.each(cases)(
    "%s on %s (2000 chars): median of 7 runs under 50 ms",
    (fn, label, input, call) => {
      expectExact(input.length, 2000, {
        what: `test input length for ${label}`,
        why: "hostile inputs are exactly 2000 characters",
        fix: "fix the test fixture",
      });
      const timings: number[] = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        call(input);
        timings.push(performance.now() - start);
      }
      const med = median(timings);
      if (!(med < 50)) {
        throw new Error(
          [
            `WHAT FAILED: ${fn} speed on hostile input (${label})`,
            "WHY (requirement): A4/A13 bound regex cost: 2000-char hostile input must stay well under 50 ms",
            "EXPECTED: median of 7 runs < 50 ms",
            `ACTUAL: median of 7 runs ${med.toFixed(1)} ms`,
            "GUIDANCE: cut input to MAX_SCRUB_INPUT_CHARS (2000) before any regex and avoid backtracking-prone patterns",
          ].join("\n"),
        );
      }
    },
  );
});
