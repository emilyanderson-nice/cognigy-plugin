/**
 * CognigyApiClient optional config: maxRetries, timeoutMs, quiet.
 * Only ever talks to a local http server on 127.0.0.1 (ephemeral port).
 */
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  jest,
} from "@jest/globals";
import { CognigyApiClient } from "../api/client.js";
import { eq, ok } from "./helpers/specAssert.js";

const API_KEY = "fake-key-1234";
let server: Server;
let baseUrl: string;
let requests: IncomingHttpHeaders[] = [];
let mode: "500" | "hang" = "500";

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.headers);
    req.resume();
    if (mode === "hang") return; // never answer
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "boom" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  requests = [];
  mode = "500";
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to reject");
}

describe("CognigyApiClient maxRetries", () => {
  it("maxRetries 0: exactly one request when the server answers 500", async () => {
    const client = new CognigyApiClient({
      baseUrl,
      apiKey: API_KEY,
      maxRetries: 0,
      quiet: true,
    });
    await rejection(client.get("/v2.0/projects"));
    eq(
      requests.length,
      1,
      "client maxRetries:0 request count",
      "Change F3: 0 retries => one attempt",
      "Do not retry when maxRetries is 0",
    );
  });

  it("maxRetries 1: exactly two requests", async () => {
    const client = new CognigyApiClient({
      baseUrl,
      apiKey: API_KEY,
      maxRetries: 1,
      quiet: true,
    });
    await rejection(client.get("/v2.0/projects"));
    eq(
      requests.length,
      2,
      "client maxRetries:1 request count",
      "Change F3: one retry => two attempts",
      "Honour maxRetries exactly",
    );
  });

  it("default keeps today's 3 retries (4 requests)", async () => {
    const client = new CognigyApiClient({
      baseUrl,
      apiKey: API_KEY,
      quiet: true,
    });
    await rejection(client.get("/v2.0/projects"));
    eq(
      requests.length,
      4,
      "client default retry count",
      "Change F3: default maxRetries is 3",
      "Keep the default of 3 retries",
    );
  }, 60000);
});

describe("CognigyApiClient timeoutMs", () => {
  it("rejects within about timeoutMs when the server never answers", async () => {
    mode = "hang";
    const client = new CognigyApiClient({
      baseUrl,
      apiKey: API_KEY,
      timeoutMs: 200,
      maxRetries: 0,
      quiet: true,
    });
    const started = Date.now();
    await rejection(client.get("/v2.0/projects"));
    const took = Date.now() - started;
    ok(
      took < 2000,
      "client timeoutMs:200",
      "Change F3: the call rejects within about timeoutMs",
      "rejection in under 2000 ms",
      `${took} ms`,
      "Apply timeoutMs to the request",
    );
  }, 10000);
});

describe("CognigyApiClient quiet and key handling", () => {
  let spies: { mock: { calls: unknown[][] }; mockRestore(): void }[] = [];
  const arm = (): void => {
    spies = [
      jest.spyOn(process.stdout, "write").mockImplementation(() => true),
      jest.spyOn(process.stderr, "write").mockImplementation(() => true),
      ...(["log", "info", "warn", "error", "debug"] as const).map((m) =>
        jest.spyOn(console, m).mockImplementation(() => undefined),
      ),
    ] as unknown as typeof spies;
  };
  const written = (): number =>
    spies.reduce((n, s) => n + s.mock.calls.length, 0);
  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    spies = [];
  });

  it("quiet:true writes nothing to stdout/stderr/console on failure", async () => {
    const client = new CognigyApiClient({
      baseUrl,
      apiKey: API_KEY,
      maxRetries: 0,
      quiet: true,
    });
    arm();
    await rejection(client.get("/v2.0/projects"));
    const n = written();
    spies.forEach((s) => s.mockRestore());
    eq(
      n,
      0,
      "client quiet:true output",
      "Change F3: quiet => no output at all",
      "Suppress every log line when quiet",
    );
  });

  it("default (non-quiet) failing call writes at least one line to stderr", async () => {
    const client = new CognigyApiClient({
      baseUrl,
      apiKey: API_KEY,
      maxRetries: 0,
    });
    arm();
    await rejection(client.get("/v2.0/projects"));
    const stderrLines =
      spies[1]!.mock.calls.length +
      spies[5]!.mock.calls.length +
      spies[4]!.mock.calls.length;
    spies.forEach((s) => s.mockRestore());
    ok(
      stderrLines >= 1,
      "client default failing call logs",
      "Change F3: pre-existing logging remains by default",
      "at least one stderr/console.error/warn line",
      `${stderrLines}`,
      "Keep logging unless quiet is set",
    );
  });

  it("sends the key as X-API-Key but never in the rejected error's message", async () => {
    const client = new CognigyApiClient({
      baseUrl,
      apiKey: API_KEY,
      maxRetries: 0,
      quiet: true,
    });
    const err = await rejection(client.get("/v2.0/projects"));
    eq(
      requests[0]?.["x-api-key"],
      API_KEY,
      "client key header",
      "Change F3: X-API-Key carries the key",
      "Send the key in X-API-Key",
    );
    const text =
      err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    ok(
      !text.includes(API_KEY),
      "client error hides the key",
      "The rejected error must not contain the API key",
      "no key in the message",
      "key present in the error text [redacted]",
      "Never put the key in error messages",
    );
  });
});
