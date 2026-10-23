/**
 * Tests for the log reader naming allowlisted NETWORK error codes (C2).
 * Gate: only a raw AxiosError (isAxiosError true, no response) qualifies; the
 * client's formatError output (plain Error with .status/.code) never does.
 * The client is a mock; nothing touches a real environment.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  PROJECT,
  ERROR_LEAK_SENTINELS,
  ALL_SENTINELS,
  SENTINEL_ERR,
  SENTINEL_KEY,
  Mock,
  page,
  upstreamError,
  clientError,
  queue,
  expectExact,
  opts,
} from "./helpers/logFixtures.js";
import {
  GENERIC_BODY,
  ALLOWLIST,
  rawAxiosError,
  tlsText,
  timeoutText,
  dnsText,
  unreachableText,
} from "./helpers/netErrors.js";

describe("readLogs network error codes (C2)", () => {
  let client: Mock;
  beforeEach(() => {
    client = jest.fn() as Mock;
  });
  const run = (args: Record<string, unknown> = {}) =>
    readLogs(
      { get: client } as any,
      { projectId: PROJECT, ...args } as any,
      opts,
    );
  const fail = async (err: Error, args: Record<string, unknown> = {}) => {
    client = jest.fn() as Mock;
    queue(client, [err]);
    return run(args);
  };
  const spec = (what: string) => ({
    what,
    why: "C2: a first-call failure with no HTTP response (raw AxiosError) names its allowlisted network code with a fixed class text; every other case keeps the generic body",
    fix: "read err.code only when err.isAxiosError === true and err.response === undefined, look it up in the enumerated allowlist, and output the allowlist constant plus the fixed class text",
  });

  const VIEWS: Array<[string, Record<string, unknown>]> = [
    ["summary", {}],
    ["entries", { view: "entries" }],
    ["session", { sessionId: "s1" }],
  ];

  describe.each(VIEWS)("%s view", (view, args) => {
    it.each(ALLOWLIST)(
      "raw AxiosError code %s gives the exact class text, status null and the code",
      async (code, text) => {
        const r = await fail(rawAxiosError(code), args);
        expectExact(
          [
            typeof r.body.error === "string",
            r.body,
            Object.keys(r.body),
            client.mock.calls.length,
          ],
          [
            true,
            { error: text, status: null, code },
            ["error", "status", "code"],
            1,
          ],
          spec(`${view} ${code}`),
        );
        expect(r.hint?.warning).toBeUndefined();
        expect(r.hint?.action).toBeUndefined();
      },
    );

    it.each([
      "EPROTO",
      "CERT_REJECTED",
      "SENTINEL_CODE_1",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "",
    ])(
      "unlisted code %p gives exactly the generic body with no code key",
      async (code) => {
        const r = await fail(rawAxiosError(code), args);
        expectExact(r.body, GENERIC_BODY, spec(`${view} unlisted ${code}`));
        expect(Object.keys(r.body)).toEqual(["error", "status"]);
        expect(JSON.stringify(r)).not.toContain("SENTINEL_CODE_1");
      },
    );

    it.each([
      ["lowercase econnreset", "econnreset"],
      ["mixed case Econnreset", "Econnreset"],
      ["padded", " ECONNRESET"],
      ["number", 104],
      ["null", null],
      ["undefined", undefined],
      ["object", { toString: () => "ECONNRESET" }],
      ["array", ["ECONNRESET"]],
      ["boolean", true],
    ])("non-matching code (%s) gives the generic body", async (_n, code) => {
      const r = await fail(rawAxiosError(code), args);
      expectExact(r.body, GENERIC_BODY, spec(`${view} code ${_n}`));
      expect(Object.keys(r.body)).toEqual(["error", "status"]);
    });

    it.each([99, "502", 600])(
      "a plain client Error (formatError output) with status %p and code ECONNRESET never qualifies",
      async (status) => {
        const err = clientError(status);
        (err as any).code = "ECONNRESET";
        const r = await fail(err, args);
        expectExact(
          r.body,
          GENERIC_BODY,
          spec(`${view} clientError(${String(status)})`),
        );
        expect(Object.keys(r.body)).toEqual(["error", "status"]);
      },
    );

    it("a plain Error with an allowlisted code and no status never qualifies", async () => {
      const err: any = new Error(SENTINEL_ERR);
      err.code = "SELF_SIGNED_CERT_IN_CHAIN";
      const r = await fail(err, args);
      expectExact(
        r.body,
        GENERIC_BODY,
        spec(`${view} plain error with TLS code`),
      );
    });

    it("isAxiosError set to a truthy non-true value does not qualify", async () => {
      const r = await fail(
        rawAxiosError("ECONNRESET", { isAxiosError: "yes" }),
        args,
      );
      expectExact(r.body, GENERIC_BODY, spec(`${view} isAxiosError "yes"`));
    });

    it("a raw AxiosError WITH response.status 600 and code ECONNRESET gives the generic body", async () => {
      const r = await fail(
        rawAxiosError("ECONNRESET", { response: { status: 600, data: {} } }),
        args,
      );
      expectExact(r.body, GENERIC_BODY, spec(`${view} response 600`));
    });

    it("a raw AxiosError with response status 403 and an allowlisted code uses the per-status text, no code key", async () => {
      const withResponse = await fail(
        rawAxiosError("SELF_SIGNED_CERT_IN_CHAIN", {
          response: { status: 403, data: {} },
        }),
        args,
      );
      const reference = await fail(upstreamError(403), args);
      expectExact(
        withResponse.body,
        reference.body,
        spec(`${view} response 403 with TLS code`),
      );
      expect(withResponse.body.status).toBe(403);
      expect(Object.keys(withResponse.body)).toEqual(["error", "status"]);
    });

    it("a usable err.status on a raw AxiosError without response wins over the code", async () => {
      const r = await fail(rawAxiosError("ECONNRESET", { status: 429 }), args);
      const reference = await fail(upstreamError(429), args);
      expectExact(r.body, reference.body, spec(`${view} err.status 429`));
      expect(Object.keys(r.body)).toEqual(["error", "status"]);
    });

    it("never echoes the message, headers, config, request or the raw code value", async () => {
      const r = await fail(
        rawAxiosError("ETIMEDOUT", {
          message: `${SENTINEL_ERR} ${SENTINEL_KEY}`,
          cause: { message: SENTINEL_ERR },
        }),
        args,
      );
      const text = JSON.stringify(r);
      expectExact(
        [...ALL_SENTINELS, ...ERROR_LEAK_SENTINELS].filter((s) =>
          text.includes(s),
        ),
        [],
        spec(`${view} sentinels`),
      );
      expect(r.body.error).toBe(timeoutText("ETIMEDOUT"));
    });

    it("the same code with two different messages gives identical output", async () => {
      const a = await fail(
        rawAxiosError("ENOTFOUND", { message: "first AAA" }),
        args,
      );
      const b = await fail(
        rawAxiosError("ENOTFOUND", { message: "second BBB" }),
        args,
      );
      expect(b).toEqual(a);
    });

    it("the code in the output is the allowlist constant, not an err.code lookalike", async () => {
      const code = new String("ECONNRESET");
      const r = await fail(rawAxiosError(code), args);
      expectExact(r.body, GENERIC_BODY, spec(`${view} String object code`));
    });
  });

  it("class texts pin one representative per class (guards the table itself)", async () => {
    const out = await Promise.all(
      [
        "SELF_SIGNED_CERT_IN_CHAIN",
        "ECONNRESET",
        "ENOTFOUND",
        "ERR_NETWORK",
      ].map(async (c) => (await fail(rawAxiosError(c))).body.error),
    );
    expectExact(
      out,
      [
        tlsText("SELF_SIGNED_CERT_IN_CHAIN"),
        timeoutText("ECONNRESET"),
        dnsText("ENOTFOUND"),
        unreachableText("ERR_NETWORK"),
      ],
      spec("class representatives"),
    );
  });

  it("the TLS text names NODE_EXTRA_CA_CERTS, a restart of the MCP client and forbids disabling verification", async () => {
    const r = await fail(rawAxiosError("CERT_HAS_EXPIRED"));
    const t = String(r.body.error);
    expect(t).toContain("NODE_EXTRA_CA_CERTS");
    expect(t).toContain("Restart the MCP client");
    expect(t).toContain("Do not disable certificate verification.");
  });

  describe("later summary page failure is unchanged", () => {
    it.each([
      "SELF_SIGNED_CERT_IN_CHAIN",
      "ECONNRESET",
      "ENOTFOUND",
      "ECONNREFUSED",
    ])(
      "page 2 failing with raw %s keeps the partial result, a fixed warning and no code",
      async (code) => {
        const reference = jest.fn() as Mock;
        queue(reference, [page(100, 500), upstreamError(500)]);
        const expected = await readLogs(
          { get: reference } as any,
          { projectId: PROJECT } as any,
          opts,
        );
        queue(client, [page(100, 500), rawAxiosError(code)]);
        const r = await run();
        expectExact(r, expected, spec(`later page ${code}`));
        expect(typeof r.body.error).not.toBe("string");
        expect(r.body.truncated).toBe(true);
        expect(r.body.sampled).toBe(100);
        expect(typeof (r.hint as any).warning).toBe("string");
        const text = JSON.stringify(r);
        expect(text).not.toContain(code);
        expect(text).not.toContain(SENTINEL_ERR);
        expect(Object.keys(r.body)).not.toContain("code");
      },
    );
  });
});
