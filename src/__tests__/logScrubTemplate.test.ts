import { describe, it, expect } from "@jest/globals";

import {
  MAX_TEMPLATE_CHARS,
  scrubText,
  messageTemplate,
} from "../tools/logScrub.js";
import { expectExact } from "./helpers/logFixtures.js";

describe("messageTemplate", () => {
  it.each([null, undefined, 7, {}])("returns '' for non-string %p", (input) => {
    expectExact(messageTemplate(input), "", {
      what: "messageTemplate of non-string",
      why: "it starts with scrubText, which returns '' for non-strings",
      fix: "delegate to scrubText first",
    });
  });

  const cases: Array<[string, string, string]> = [
    [
      "short quoted identifier stays",
      "Cannot read 'languageName' of undefined",
      "Cannot read 'languageName' of undefined",
    ],
    [
      "double-quoted string with a space becomes <str>",
      'Failed to parse "hello world foo"',
      "Failed to parse <str>",
    ],
    [
      "single-quoted string with a space becomes <str>",
      "Value 'not valid here' rejected",
      "Value <str> rejected",
    ],
    [
      "quoted string of exactly 40 chars (no space) stays",
      `Key "${"a-".repeat(20)}" missing`,
      `Key "${"a-".repeat(20)}" missing`,
    ],
    [
      "quoted string of 41 chars (no space) becomes <str>",
      `Key "${"a-".repeat(20)}a" missing`,
      "Key <str> missing",
    ],
    ["numbers become N", "Input was 29 characters", "Input was N characters"],
    [
      "decimal number becomes a single N",
      "took 3.75 seconds",
      "took N seconds",
    ],
    ["multiple numbers", "retry 3 of 10", "retry N of N"],
    [
      "3-digit number NOT after a keyword becomes N",
      "retry 404 times",
      "retry N times",
    ],
    [
      "status 3-digit kept",
      "Request failed with status 404",
      "Request failed with status 404",
    ],
    ["Status capitalised kept", "Status 500 returned", "Status 500 returned"],
    ["http kept", "got HTTP 503 upstream", "got HTTP 503 upstream"],
    ["code with = kept", "exit code=429", "exit code=429"],
    ["error with : kept", "error: 500 happened", "error: 500 happened"],
    ["errno with = kept", "errno=104 reset", "errno=104 reset"],
    ["4-digit after status is N", "status 1000 weird", "status N weird"],
    ["2-digit after code is N", "code 12 weird", "code N weird"],
    ["4-digit after error is N", "error 4045 weird", "error N weird"],
    [
      "email then number",
      "user bob@example.com failed 3 times",
      "user <email> failed N times",
    ],
    ["9+ digit run stays <digits>", "id 1234567890 gone", "id <digits> gone"],
  ];
  it.each(cases)("%s", (label, input, expected) => {
    expectExact(messageTemplate(input), expected, {
      what: `messageTemplate: ${label}`,
      why: "template = scrub, then quoted-string masking, then number masking (3-digit after status/http/code/error/errno kept)",
      fix: "implement steps (a)-(d) of the contract in order",
    });
  });

  it("replaces every UUID and standalone 24-hex word with <id> (step 0, before number masking)", () => {
    expectExact(
      [
        messageTemplate("id 507f1f77bcf86cd799439011 failed"),
        messageTemplate("session 123e4567-e89b-12d3-a456-426614174000 closed"),
      ],
      ["id <id> failed", "session <id> closed"],
      {
        what: "messageTemplate over 24-hex / UUID ids",
        why: "after scrubText and before the quoted-string rule, UUIDs and 24-hex words become <id>",
        fix: "add the <id> replacement step between scrubText and the quoted-string rule",
      },
    );
  });

  it("gives the same template for two messages differing only in the id", () => {
    expectExact(
      [
        messageTemplate("object 507f1f77bcf86cd799439011 not found"),
        messageTemplate("object 64b0c0ffee1234567890abcd not found"),
        messageTemplate(
          "object 123e4567-e89b-12d3-a456-426614174000 not found",
        ),
        messageTemplate(
          "object 9f8e7d6c-5b4a-4321-8fed-cba987654321 not found",
        ),
      ],
      Array(4).fill("object <id> not found"),
      {
        what: "grouping of messages that differ only in an id",
        why: "ids collapse to <id>, so these group together",
        fix: "apply the <id> step to both UUIDs and 24-hex words",
      },
    );
  });

  it("does not replace a 23-char hex word with <id>", () => {
    expectExact(
      messageTemplate("id 507f1f77bcf86cd79943901 failed"),
      "id NfNfNbcfNcdN failed",
      {
        what: "23-char hex word (24-hex id minus its last character)",
        why: "only exactly 24-char hex words are ids; this one just gets normal number masking (507,1,77,86,79943901 -> N)",
        fix: "anchor the id pattern to exactly 24 hex characters with word boundaries",
      },
    );
  });

  it("gives the same template for 29 and 30 characters", () => {
    expectExact(
      messageTemplate("Input was 29 characters"),
      messageTemplate("Input was 30 characters"),
      {
        what: "grouping of messages differing only in a number",
        why: "numbers collapse to N so these group together",
        fix: "replace digit runs with N",
      },
    );
  });

  it("keeps status 404 and status 500 different", () => {
    expect(messageTemplate("failed with status 404")).not.toBe(
      messageTemplate("failed with status 500"),
    );
    expectExact(
      messageTemplate("failed with status 404"),
      "failed with status 404",
      {
        what: "status code preserved",
        why: "3-digit number after 'status' is kept",
        fix: "exempt it from N replacement",
      },
    );
  });

  it("truncates to MAX_TEMPLATE_CHARS with the ellipsis rule", () => {
    const input = "ab ".repeat(100);
    const expected = `${input.trim().slice(0, 199)}…`;
    const out = messageTemplate(input) as string;
    expectExact(out, expected, {
      what: "299-char template",
      why: "templates are cut to 200 chars: 199 chars plus '…'",
      fix: "same ellipsis rule as scrubText with MAX_TEMPLATE_CHARS",
    });
    expectExact(out.length, 200, {
      what: "template length",
      why: "exactly 200 when truncated",
      fix: "199 + ellipsis",
    });
  });
});
