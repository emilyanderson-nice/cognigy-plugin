import { describe, expect, it } from "@jest/globals";
import { httpStatusOf } from "../tools/intents/types.js";

const SENTINEL = "SENTINEL_ERROR_MESSAGE_42";

describe("httpStatusOf", () => {
  it("reads err.response.status", () => {
    expect(httpStatusOf({ response: { status: 503 } })).toBe(503);
  });

  it("reads a plain err.status when there is no response", () => {
    expect(httpStatusOf(Object.assign(new Error("x"), { status: 429 }))).toBe(
      429,
    );
  });

  it("lets response.status win when both are numeric", () => {
    expect(httpStatusOf({ status: 418, response: { status: 503 } })).toBe(503);
  });

  it("falls back to err.status when response.status is not a number", () => {
    expect(httpStatusOf({ status: 429, response: { status: "503" } })).toBe(
      429,
    );
    expect(httpStatusOf({ status: 429, response: {} })).toBe(429);
    expect(httpStatusOf({ status: 429, response: null })).toBe(429);
    expect(httpStatusOf({ status: 429, response: { status: NaN } })).toBe(429);
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("rejects %s in response.status", (_label, value) => {
    expect(httpStatusOf({ response: { status: value } })).toBeUndefined();
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("rejects %s in status", (_label, value) => {
    expect(httpStatusOf({ status: value })).toBeUndefined();
  });

  it("falls back to a finite status when response.status is Infinity", () => {
    expect(httpStatusOf({ status: 500, response: { status: Infinity } })).toBe(
      500,
    );
  });

  it("does not accept a numeric string in either field", () => {
    expect(httpStatusOf({ response: { status: "503" } })).toBeUndefined();
    expect(httpStatusOf({ status: "503" })).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "503"],
    ["a number", 503],
    ["an array", [503]],
    ["a plain object with neither field", { code: 503 }],
    ["an object with a null response", { response: null }],
  ])("returns undefined without throwing for %s", (_label, input) => {
    expect(() => httpStatusOf(input)).not.toThrow();
    expect(httpStatusOf(input)).toBeUndefined();
  });

  it("never returns message text: only the number or undefined", () => {
    const withStatus = Object.assign(new Error(SENTINEL), { status: 502 });
    const withResponse = Object.assign(new Error(SENTINEL), {
      response: { status: 504, data: { message: SENTINEL } },
    });
    const without = new Error(SENTINEL);
    expect(httpStatusOf(withStatus)).toBe(502);
    expect(httpStatusOf(withResponse)).toBe(504);
    expect(httpStatusOf(without)).toBeUndefined();
    for (const e of [withStatus, withResponse, without]) {
      expect(JSON.stringify(httpStatusOf(e) ?? null)).not.toContain(SENTINEL);
    }
  });
});
