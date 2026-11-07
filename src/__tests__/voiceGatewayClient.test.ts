/**
 * The Voice Gateway REST client: bearer auth, one fixed path prefix, no redirects,
 * and errors that carry a status or a network class and never the upstream body
 * or the key. It only ever talks to a local server on 127.0.0.1.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  VoiceGatewayClient,
  VoiceGatewayError,
} from "../voicegateway/client.js";

const KEY = "vg-account-key-QQQQ7777";
let server: Server;
let other: Server;
let base: string;
let otherBase: string;
let seen: { url: string; headers: IncomingHttpHeaders }[] = [];
let otherHits = 0;
let respond: (res: import("http").ServerResponse) => void = () => undefined;

beforeAll(async () => {
  other = createServer((req, res) => {
    otherHits++;
    req.resume();
    res.end("{}");
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    req.resume();
    respond(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of [server, other]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
beforeEach(() => {
  seen = [];
  otherHits = 0;
  respond = (res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };
});

async function rejection(p: Promise<unknown>): Promise<VoiceGatewayError> {
  try {
    await p;
  } catch (e) {
    return e as VoiceGatewayError;
  }
  throw new Error("expected the call to reject");
}

describe("VoiceGatewayClient requests", () => {
  it("sends the key as a bearer token under /v1 and returns the parsed body", async () => {
    const client = new VoiceGatewayClient({ baseUrl: base, apiKey: KEY });
    const data = await client.get("/Accounts/acc-1/RecentCalls", {
      page: 1,
      count: 25,
    });
    expect(data).toStrictEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/v1/Accounts/acc-1/RecentCalls?page=1&count=25");
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0].headers.accept).toContain("application/json");
  });

  it.each([`${"/v1"}`, "/v1/", "/", ""])(
    "a base URL ending in %j still gives exactly one /v1",
    async (suffix) => {
      const client = new VoiceGatewayClient({
        baseUrl: `${base}${suffix}`,
        apiKey: KEY,
      });
      await client.get("/Accounts/a/RecentCalls");
      expect(seen[0].url).toBe("/v1/Accounts/a/RecentCalls");
    },
  );

  it("does not follow a redirect, so the key never reaches another host", async () => {
    respond = (res) => {
      res.writeHead(302, { Location: `${otherBase}/steal` });
      res.end("redirecting");
    };
    const client = new VoiceGatewayClient({ baseUrl: base, apiKey: KEY });
    const err = await rejection(client.get("/Accounts/a/RecentCalls"));
    expect(err).toBeInstanceOf(VoiceGatewayError);
    expect(err.status).toBe(302);
    expect(otherHits).toBe(0);
  });
});

describe("VoiceGatewayClient errors", () => {
  it("an HTTP error carries the status only, never the body or the key", async () => {
    respond = (res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ message: `bad key ${KEY} for caller +4915112345678` }),
      );
    };
    const client = new VoiceGatewayClient({ baseUrl: base, apiKey: KEY });
    const err = await rejection(client.get("/Accounts/a/RecentCalls"));
    expect(err.message).toBe("Voice Gateway request failed (HTTP 401).");
    expect(err.status).toBe(401);
    const dump = JSON.stringify(err) + String(err) + err.message + err.stack;
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("+4915112345678");
  });

  it("an unreachable host names the network class and code, not the URL", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const client = new VoiceGatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: KEY,
    });
    const err = await rejection(client.get("/Accounts/a/RecentCalls"));
    expect(err.message).toBe(
      "Voice Gateway request failed: the host could not be reached (ECONNREFUSED).",
    );
    expect(err.status).toBeUndefined();
    expect(err.message).not.toContain("127.0.0.1");
  });

  it("a request that is never answered times out with a fixed message", async () => {
    respond = () => undefined; // never answers
    const client = new VoiceGatewayClient({
      baseUrl: base,
      apiKey: KEY,
      timeoutMs: 80,
    });
    const err = await rejection(client.get("/Accounts/a/RecentCalls"));
    expect(err.message).toBe(
      "Voice Gateway request failed: the connection timed out (ECONNABORTED).",
    );
  });

  it("a response over the size cap is refused with a fixed message", async () => {
    respond = (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ blob: "x".repeat(4096) }));
    };
    const client = new VoiceGatewayClient({
      baseUrl: base,
      apiKey: KEY,
      maxResponseBytes: 1024,
    });
    const err = await rejection(client.get("/Accounts/a/RecentCalls"));
    expect(err.message).toBe(
      "Voice Gateway request failed: the response was too large.",
    );
  });

  it("returns an unparsable 200 body as a string, for the caller to validate", async () => {
    respond = (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{not json");
    };
    const client = new VoiceGatewayClient({ baseUrl: base, apiKey: KEY });
    const data = await client.get("/Accounts/a/RecentCalls");
    expect(typeof data).toBe("string");
  });
});
