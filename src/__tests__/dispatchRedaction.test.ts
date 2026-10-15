import { describe, it } from "@jest/globals";
import {
  allLogged,
  harness,
  parse,
  setOf,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

type Thrown = Error & Record<string, unknown>;

function run(key: string, make: () => unknown) {
  const h = harness({
    set: setOf(usable("A", key)),
    impl: {
      a: async () => {
        throw make();
      },
    },
  });
  return { h, call: () => h.dispatcher.callTool("alpha", {}) };
}
const failWith = (message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), extra) as Thrown;

/** Learns the fixed placeholder by throwing a message that is exactly the key. */
async function placeholderFor(key: string): Promise<string> {
  const { call } = run(key, () => failWith(key));
  return String(parse(await call()).error);
}

describe("F5 redaction hardening", () => {
  const KEY = "Abcd1234-KeyMaterial";

  it("F5: the placeholder is non-empty, does not contain the key, and is stable across calls", async () => {
    const first = await placeholderFor(KEY);
    const second = await placeholderFor(KEY);
    ok(
      first.length > 0 && !first.includes(KEY) && first === second,
      "placeholder",
      "F5: fixed, key-free placeholder",
      "the same non-empty text without the key every time",
      JSON.stringify([first, second]),
      "Use one fixed replacement text.",
    );
  });

  it("F5: redaction is case-insensitive and replaces every occurrence", async () => {
    const P = await placeholderFor(KEY);
    const { h, call } = run(KEY, () =>
      failWith(
        `a ${KEY} b ${KEY.toLowerCase()} c ${KEY.toUpperCase()} d ${KEY}`,
      ),
    );
    const body = parse(await call());
    eq(
      body.error,
      `a ${P} b ${P} c ${P} d ${P}`,
      "case-insensitive multi-occurrence redaction",
      "F5: all occurrences in any letter case are replaced, nothing else changes",
      "Replace every case variant of the key with the fixed text.",
    );
    ok(
      !allLogged(h).toLowerCase().includes(KEY.toLowerCase()),
      "log leak",
      "F5: nothing in the logs",
      "no key",
      allLogged(h),
      "Never log the key.",
    );
  });

  it("F5: status, code and traceId strings are redacted too; numeric status is untouched", async () => {
    const P = await placeholderFor(KEY);
    const { call } = run(KEY, () =>
      failWith("m", {
        status: `S-${KEY}`,
        code: `C-${KEY.toUpperCase()}`,
        traceId: `T-${KEY.toLowerCase()}`,
      }),
    );
    const body = parse(await call());
    eq(
      [body.error, body.status, body.code, body.traceId],
      ["m", `S-${P}`, `C-${P}`, `T-${P}`],
      "string field redaction",
      "F5: every string field of the error result is redacted",
      "Apply redaction to message, status, code and traceId strings.",
    );
    const numeric = run(KEY, () => failWith("m", { status: 404 }));
    eq(
      parse(await numeric.call()).status,
      404,
      "numeric status",
      "F5: non-string fields are left alone",
      "Do not alter numbers.",
    );
  });

  it("F5: a key shorter than 8 characters is not used for redaction; 8 characters is", async () => {
    const short = "short7!";
    const s = run(short, () => failWith(`the ${short} stays, also SHORT7!`));
    eq(
      parse(await s.call()).error,
      `the ${short} stays, also SHORT7!`,
      "short key",
      "F5: keys under 8 characters are not redacted",
      "Skip redaction for keys shorter than 8 characters.",
    );
    const edge = "eightch!";
    const P = await placeholderFor(edge);
    const e = run(edge, () => failWith(`x ${edge} y`));
    eq(
      parse(await e.call()).error,
      `x ${P} y`,
      "8-char key",
      "F5: keys of 8+ characters are redacted",
      "Redact keys of exactly 8 characters.",
    );
  });

  it.each([
    ["ab$&cd-xyz", "x ab$&cd-xyz y", "x PH y"],
    [
      "a.b*c(d)efg",
      "a.b*c(d)efg | aXb*c(d)efg | a.bbbc(d)efg",
      "PH | aXb*c(d)efg | a.bbbc(d)efg",
    ],
    ["[k]+key?{2}|^$z", "pre [k]+key?{2}|^$z post kkey", "pre PH post kkey"],
  ])(
    "F5: regex-special key %j is matched literally",
    async (key, message, expectedTemplate) => {
      const P = await placeholderFor(key);
      const r = await run(key, () => failWith(message)).call();
      eq(
        parse(r).error,
        expectedTemplate.split("PH").join(P),
        `literal key ${key}`,
        "F5: key matched as plain text only",
        "Escape the key; never treat it as a pattern or replacement template.",
      );
    },
  );

  it("F5: a successful handler result is returned untouched even if it contains the key", async () => {
    const result = {
      note: `contains ${KEY}`,
      upper: KEY.toUpperCase(),
      nested: { k: KEY },
    };
    const h = harness({
      set: setOf(usable("A", KEY)),
      impl: { a: async () => result },
    });
    const r = await h.dispatcher.callTool("alpha", {});
    eq(
      r.content[0].text,
      JSON.stringify({
        ...result,
        _environment: { name: "a", host: "api-a.cognigy.ai" },
      }),
      "success result untouched",
      "F5: redaction applies to errors only",
      "Return successful results exactly as the handler produced them.",
    );
  });
});
