import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  jest,
} from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { logger } from "../utils/logger.js";
import { CognigyApiClient } from "../api/client.js";
import { ToolHandlers } from "../tools/handlers.js";

// Typed view of the required (not yet existing) logger seam.
const secrets = logger as unknown as {
  registerSecret(secret: string): void;
  clearSecrets(): void;
};

const KEY = "synthetic-key-0123456789";
const KEY2 = "another-secret-ABCDEFGH";
const LEVELS = ["debug", "info", "warn", "error"] as const;

/** Five-labelled-line failure message; behaviour-only guidance. */
function check(
  what: string,
  why: string,
  expected: string,
  actual: string,
  guidance: string,
): string {
  return [
    `1. WHAT FAILED: ${what}`,
    `2. REQUIREMENT VIOLATED: ${why}`,
    `3. EXPECTED: ${expected}`,
    `4. ACTUAL: ${actual}`,
    `5. GUIDANCE: ${guidance}`,
  ].join("\n");
}

/** expect() takes one argument here, so carry the five-line message ourselves. */
function expectWith(actual: unknown, message: string) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(message);
    },
  };
}

let spy: ReturnType<typeof jest.spyOn>;

function captured(): string[] {
  return spy.mock.calls.map((c) => c.map((a) => String(a)).join(" "));
}
function capturedAll(): string {
  return captured().join("\n");
}
const stripTimestamp = (line: string) =>
  line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\] /, "");

beforeEach(() => {
  logger.setLevel("debug");
  spy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  secrets.clearSecrets?.();
  spy.mockRestore();
  logger.setLevel("info");
});

describe("logger secret redaction (unit)", () => {
  for (const level of LEVELS) {
    describe(`level ${level}`, () => {
      it(`redacts a registered secret in the message at ${level}`, () => {
        secrets.registerSecret(KEY);
        logger[level](`before ${KEY} after`);
        const out = capturedAll();
        expect(out.includes(KEY)).toBe(false);
        expectWith(
          out.includes("before [redacted] after"),
          check(
            `${level}: secret in message`,
            "Every registered secret is replaced by [redacted] in log messages",
            "message text with [redacted] in place of the secret",
            out,
            "Apply redaction to the message before it is written.",
          ),
        ).toBe(true);
      });

      it(`redacts in top-level, nested, and array meta at ${level}`, () => {
        secrets.registerSecret(KEY);
        logger[level]("meta test", {
          top: KEY,
          nested: { deep: { v: `x ${KEY} y` } },
          list: ["ok", KEY, { inner: KEY }],
        });
        const out = capturedAll();
        expectWith(
          out.includes(KEY),
          check(
            `${level}: secret in meta`,
            "Meta (JSON-stringified) must also be redacted",
            "no occurrence of the secret anywhere in the output",
            out,
            "Redact the complete emitted line, including serialised meta.",
          ),
        ).toBe(false);
        expect(out.match(/\[redacted\]/g)?.length).toBe(4);
      });

      it(`redacts a different letter case at ${level}`, () => {
        secrets.registerSecret(KEY);
        logger[level](`up ${KEY.toUpperCase()}`, { m: KEY.toUpperCase() });
        const out = capturedAll();
        expectWith(
          out.toLowerCase().includes(KEY.toLowerCase()),
          check(
            `${level}: case-insensitive`,
            "Matching is case-insensitive",
            "upper-cased secret is redacted",
            out,
            "Match secrets regardless of letter case.",
          ),
        ).toBe(false);
        expect(out.includes("[redacted]")).toBe(true);
      });
    });
  }

  it("preserves surrounding text exactly (full line modulo timestamp)", () => {
    secrets.registerSecret(KEY);
    logger.warn(`Invalid credential ${KEY} here`, { a: 1, b: `k=${KEY}` });
    const lines = captured();
    expect(lines).toHaveLength(1);
    expect(stripTimestamp(lines[0])).toBe(
      `[WARN] Invalid credential [redacted] here {"a":1,"b":"k=[redacted]"}`,
    );
  });

  it("redacts every occurrence of multiple registered secrets", () => {
    secrets.registerSecret(KEY);
    secrets.registerSecret(KEY2);
    logger.info(`${KEY} and ${KEY2} and ${KEY}`, { z: KEY2 });
    const out = capturedAll();
    expect(out.includes(KEY)).toBe(false);
    expect(out.includes(KEY2)).toBe(false);
    expect(out.match(/\[redacted\]/g)?.length).toBe(4);
  });

  it("does not redact a 7-character secret", () => {
    secrets.registerSecret("abcdefg");
    logger.info("value abcdefg here", { v: "abcdefg" });
    const out = capturedAll();
    expectWith(
      out.includes("abcdefg"),
      check(
        "short secret ignored",
        "Secrets shorter than MIN_REDACTABLE_KEY_LENGTH (8) are ignored",
        "7-character text is logged verbatim",
        out,
        "Ignore secrets below the minimum length.",
      ),
    ).toBe(true);
    expect(out.includes("[redacted]")).toBe(false);
  });

  it("registering empty or short secrets does not throw", () => {
    expect(() => secrets.registerSecret("")).not.toThrow();
    expect(() => secrets.registerSecret("short")).not.toThrow();
  });

  it("leaves unregistered text untouched", () => {
    secrets.registerSecret(KEY);
    logger.error("nothing secret here", { n: "plain" });
    expect(stripTimestamp(captured()[0])).toBe(
      `[ERROR] nothing secret here {"n":"plain"}`,
    );
  });

  it("logs the secret verbatim again after clearSecrets()", () => {
    secrets.registerSecret(KEY);
    logger.info(`first ${KEY}`);
    secrets.clearSecrets();
    logger.info(`second ${KEY}`);
    const [first, second] = captured();
    expect(first.includes(KEY)).toBe(false);
    expectWith(
      second.includes(KEY),
      check(
        "clearSecrets",
        "clearSecrets removes all registered secrets",
        "secret appears verbatim after clearing",
        second,
        "Forget every registered secret when cleared.",
      ),
    ).toBe(true);
  });
});

describe("CognigyApiClient registers its key with the logger", () => {
  const make = (apiKey: string) =>
    new CognigyApiClient({
      baseUrl: "http://127.0.0.1:1",
      apiKey,
      auditAttribution: false,
      maxRetries: 0,
      timeoutMs: 5000,
    });

  it("redacts the client's key in later log output", () => {
    make(KEY);
    logger.error(`x ${KEY} y`, { k: KEY });
    const out = capturedAll();
    expectWith(
      out.includes(KEY),
      check(
        "client registration",
        "Constructing a client registers its apiKey with the logger",
        "key absent from log output after construction",
        out,
        "Make every constructed client's key known to the shared logger.",
      ),
    ).toBe(false);
    expect(out.includes("x [redacted] y")).toBe(true);
  });

  it("does not throw for an empty key", () => {
    expect(() => make("")).not.toThrow();
  });
});

describe("end-to-end: upstream 400 echoing the key", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: `Invalid credential ${KEY}` }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("never writes the key to any log line", async () => {
    const client = new CognigyApiClient({
      baseUrl,
      apiKey: KEY,
      auditAttribution: false,
      maxRetries: 0,
      timeoutMs: 5000,
    });
    const handlers = new ToolHandlers(
      client,
      "https://endpoint.example",
      "",
      "",
    );

    await expect(
      handlers.handleToolCall("list_resources", { resourceType: "project" }),
    ).rejects.toBeDefined();

    const lines = captured();
    const all = lines.join("\n");
    expectWith(
      lines.some((l) => l.includes("API Response Error")),
      check(
        "harness sanity",
        "The transport must log API Response Error for the 400",
        "at least one API Response Error line",
        all,
        "Ensure the failing request reaches the client error logger.",
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes("Tool call failed"))).toBe(true);
    expectWith(
      all.toLowerCase().includes(KEY.toLowerCase()),
      check(
        "upstream error echo leaks key to stderr",
        "No log output may contain the API key, whichever code path logs it",
        "no log line contains the key",
        all,
        "Ensure all emitted log lines have the client's key replaced by [redacted].",
      ),
    ).toBe(false);
  });
});
