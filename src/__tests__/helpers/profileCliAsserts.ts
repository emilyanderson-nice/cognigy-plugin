import { codeMsg, type Harness } from "./profileCliHarness.js";
import { fail } from "./specAssert.js";

/** Runs argv and asserts the exact exit code (5-point message on failure). */
export async function runExpect(
  h: Harness,
  argv: string[],
  expected: number,
  what: string,
  why: string,
  guidance: string,
): Promise<void> {
  const actual = await h.run(argv);
  if (actual !== expected) {
    throw new Error(codeMsg(what, why, expected, actual, h, guidance));
  }
}

/** Asserts text contains every needle (case-insensitive when ci). */
export function mustContain(
  text: string,
  needles: string[],
  what: string,
  why: string,
  guidance: string,
  ci = false,
): void {
  const hay = ci ? text.toLowerCase() : text;
  const missing = needles.filter(
    (n) => !hay.includes(ci ? n.toLowerCase() : n),
  );
  if (missing.length) {
    fail(
      what,
      why,
      `text containing ${JSON.stringify(needles)}`,
      `missing ${JSON.stringify(missing)} in ${JSON.stringify(text)}`,
      guidance,
    );
  }
}

/** Asserts text contains none of the needles. */
export function mustNotContain(
  text: string,
  needles: string[],
  what: string,
  why: string,
  guidance: string,
): void {
  const present = needles.filter((n) => text.includes(n));
  if (present.length) {
    fail(
      what,
      why,
      `text without ${JSON.stringify(needles)}`,
      `found ${JSON.stringify(present)} in ${JSON.stringify(text)}`,
      guidance,
    );
  }
}
