import { expect } from "@jest/globals";

/**
 * Shared assertion helpers that enforce the 5-point failure-message format:
 *   1. WHAT     which test/behaviour failed
 *   2. WHY      which requirement was violated
 *   3. EXPECTED the specified behaviour
 *   4. ACTUAL   what happened
 *   5. GUIDANCE what outcome to achieve (behavioural, not implementation)
 */
export function msg(
  what: string,
  why: string,
  expected: string,
  actual: string,
  guidance: string,
): string {
  return [
    `1. WHAT: ${what} FAILED`,
    `2. WHY: ${why}`,
    `3. EXPECTED: ${expected}`,
    `4. ACTUAL: ${actual}`,
    `5. GUIDANCE: ${guidance}`,
  ].join("\n");
}

const SENSITIVE_PROPERTY = /^(apikey|key|token|secret)$/i;

/**
 * Formats a value for a failure message. Any property named
 * apiKey/key/token/secret (case-insensitive, at any depth) is replaced, so a
 * failing assertion can never echo a credential.
 */
export function show(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    const text = JSON.stringify(value, (k, v: unknown) =>
      SENSITIVE_PROPERTY.test(k) ? "[REDACTED]" : v,
    );
    return text === undefined ? String(value) : text;
  } catch {
    return "[unprintable]";
  }
}

export function fail(
  what: string,
  why: string,
  expected: string,
  actual: string,
  guidance: string,
): never {
  throw new Error(msg(what, why, expected, actual, guidance));
}

/** Deep-equality assertion (exact values) with a 5-point message. */
export function eq(
  actual: unknown,
  expected: unknown,
  what: string,
  why: string,
  guidance: string,
): void {
  try {
    expect(actual).toEqual(expected);
  } catch {
    fail(what, why, show(expected), show(actual), guidance);
  }
}

/** Boolean assertion with a 5-point message. */
export function ok(
  condition: boolean,
  what: string,
  why: string,
  expected: string,
  actual: string,
  guidance: string,
): void {
  if (!condition) fail(what, why, expected, actual, guidance);
}

/**
 * Asserts fn throws an instance of cls and returns the error.
 * A wrong error class (e.g. plain Error/TypeError) is a failure.
 */
export function raises<E extends Error>(
  fn: () => unknown,
  cls: new (...args: never[]) => E,
  what: string,
  why: string,
  guidance: string,
): E {
  let thrown: unknown;
  let didThrow = false;
  try {
    fn();
  } catch (e) {
    didThrow = true;
    thrown = e;
  }
  if (!didThrow) {
    fail(
      what,
      why,
      `throws ${cls.name}`,
      "returned normally without throwing",
      guidance,
    );
  }
  if (!(thrown instanceof cls)) {
    fail(
      what,
      why,
      `throws an instance of ${cls.name}`,
      show(thrown),
      guidance,
    );
  }
  return thrown as E;
}
