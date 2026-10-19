import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ToolHandlers } from "../tools/handlers.js";
import { ok, show } from "./helpers/specAssert.js";

/**
 * Real-transport test: talk_to_agent follows HTTP redirects, so a hop to a host
 * other than the configured endpoint host must never receive the conversation
 * payload. No axios mocking; two real loopback listeners on ephemeral ports.
 */

const SECRET = "synthetic-secret-message-42";
const TOKEN = "tok123";

interface Seen {
  method: string;
  url: string;
  host: string;
  body: string;
}

interface Listener {
  server: http.Server;
  port: number;
  seen: Seen[];
  /** Resolves once the request has fully arrived (body read). */
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
}

const listen = (host: string): Promise<Listener> =>
  new Promise((resolve, reject) => {
    const l = { seen: [] as Seen[] } as Listener;
    l.handler = (_req, res) => {
      res.writeHead(404).end();
    };
    l.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      // Record on arrival so a request is counted even if the client aborts
      // before sending the body.
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        host: String(req.headers.host ?? ""),
        body: "",
      };
      l.seen.push(entry);
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        entry.body = Buffer.concat(chunks).toString("utf8");
        l.handler(req, res);
      });
      req.on("error", () => {});
    });
    l.server.once("error", reject);
    l.server.listen(0, host, () => {
      l.port = (l.server.address() as AddressInfo).port;
      resolve(l);
    });
  });

const closeListener = (l: Listener | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (!l) return resolve();
    l.server.closeAllConnections?.();
    l.server.close(() => resolve());
  });

const stubClient = () =>
  ({
    get: async () => ({}),
    post: async () => ({}),
    patch: async () => ({}),
    delete: async () => ({}),
  }) as any;

const okJson = (res: http.ServerResponse, text: string) => {
  res
    .writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify({ text, outputStack: [] }));
};

/** Runs the tool; folds a thrown error or an error result into one outcome. */
const talk = async (
  endpointBase: string,
  startPath: string,
): Promise<{ succeeded: boolean; text: string }> => {
  const handlers = new ToolHandlers(
    stubClient(),
    endpointBase,
    "",
    "http://127.0.0.1:1",
  );
  try {
    const result: any = await handlers.handleToolCall("talk_to_agent", {
      endpointUrl: `${endpointBase}${startPath}`,
      message: SECRET,
    });
    const text = show(result);
    const failed =
      result?.isError === true ||
      (result && typeof result === "object" && "error" in result) ||
      /"error"\s*:/.test(text);
    return { succeeded: !failed, text };
  } catch (e) {
    return { succeeded: false, text: show(e) };
  }
};

describe("talk_to_agent redirect host guard (real transport)", () => {
  let a: Listener;
  let b: Listener;
  const savedEnv: Record<string, string | undefined> = {};
  const PROXY_VARS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ];

  beforeAll(() => {
    for (const k of PROXY_VARS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.NO_PROXY = "127.0.0.1,localhost,::1";
  });

  afterAll(() => {
    for (const k of PROXY_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  beforeEach(async () => {
    // Dual-stack so "localhost" (which may resolve to ::1) still reaches A;
    // otherwise a missing guard could pass test (b) by accident.
    try {
      a = await listen("::");
    } catch {
      a = await listen("127.0.0.1");
    }
    b = await listen("127.0.0.1");
    b.handler = (_req, res) => okJson(res, "from-B");
  });

  afterEach(async () => {
    await closeListener(a);
    await closeListener(b);
  });

  const base = () => `http://127.0.0.1:${a.port}`;

  describe.each([307, 308, 302])(
    "redirect status %i to another host",
    (status) => {
      it(`blocks the hop, never contacts the other host, and leaks nothing (${status})`, async () => {
        a.handler = (_req, res) => {
          res
            .writeHead(status, {
              Location: `http://127.0.0.1:${b.port}/stolen-path-b`,
            })
            .end();
        };

        const r = await talk(base(), `/${TOKEN}`);

        ok(
          b.seen.length === 0,
          `redirect ${status} to a different host`,
          "every redirect hop must be validated against the configured endpoint host before any request is sent to it",
          "server B receives 0 requests",
          `server B received ${b.seen.length} request(s); body seen: ${show(b.seen.map((s) => s.body))}`,
          "Refuse to contact any redirect destination whose host (including port) differs from the configured endpoint host.",
        );
        ok(
          r.succeeded === false,
          `redirect ${status} to a different host`,
          "a blocked redirect is a failure of the tool call, not a success",
          "the call does not succeed (rejects or returns an error)",
          `call outcome: ${r.text}`,
          "Surface a failure when the redirect is refused.",
        );
        ok(
          /redirect/i.test(r.text),
          `redirect ${status} error text`,
          "the caller must be told why the call failed",
          'error text contains the word "redirect"',
          r.text,
          "Describe the failure as a blocked redirect.",
        );
        ok(
          !r.text.includes(SECRET),
          `redirect ${status} error text`,
          "the conversation payload must never be echoed in errors",
          "error text does not contain the message",
          r.text,
          "Keep message content out of failure output.",
        );
        ok(
          !r.text.includes(`127.0.0.1:${b.port}`) &&
            !r.text.includes("stolen-path-b"),
          `redirect ${status} error text`,
          "the redirect destination (which may embed tokens) must not be echoed",
          "error text contains neither B's host:port nor B's path",
          r.text,
          "Do not echo the blocked destination URL in the error.",
        );
      });
    },
  );

  it("blocks a redirect to the same IP under a different hostname form (localhost)", async () => {
    a.handler = (req, res) => {
      if ((req.url ?? "").includes("after-redirect")) {
        okJson(res, "reached-via-localhost");
        return;
      }
      res
        .writeHead(307, {
          Location: `http://localhost:${a.port}/after-redirect`,
        })
        .end();
    };

    const r = await talk(base(), `/${TOKEN}`);

    ok(
      a.seen.length === 1,
      "redirect to localhost:<same port>",
      "the host string must match the configured endpoint host exactly; a different hostname form is a different host",
      "server A sees exactly 1 request (the original)",
      `server A saw ${a.seen.length} request(s): ${show(a.seen.map((s) => `${s.host} ${s.url}`))}`,
      "Treat any redirect whose host string differs from the configured endpoint host as blocked, even if it resolves to the same address.",
    );
    ok(
      r.succeeded === false && /redirect/i.test(r.text),
      "redirect to localhost:<same port> outcome",
      "a blocked redirect fails the call and says so",
      'call fails and error text contains "redirect"',
      r.text,
      "Return a failure describing a blocked redirect.",
    );
    ok(
      !r.text.includes(SECRET),
      "redirect to localhost error text",
      "the payload must not be echoed",
      "no message text in output",
      r.text,
      "Keep message content out of failure output.",
    );
  });

  it("still follows a redirect that stays on the endpoint host, resending the full body", async () => {
    a.handler = (req, res) => {
      if ((req.url ?? "").includes("start")) {
        res.writeHead(307, { Location: `${base()}/final` }).end();
      } else {
        okJson(res, "hello-from-A");
      }
    };

    const r = await talk(base(), `/start-${TOKEN}`);

    const second = a.seen[1];
    ok(
      a.seen.length === 2 &&
        second !== undefined &&
        second.url === "/final" &&
        second.body.includes(SECRET),
      "same-host redirect",
      "redirects within the configured endpoint host remain allowed and keep method and body (307)",
      "A receives 2 requests; the second is POST /final carrying the full message",
      `A saw: ${show(a.seen)}`,
      "Only block redirects that leave the configured endpoint host.",
    );
    ok(
      r.succeeded && r.text.includes("hello-from-A"),
      "same-host redirect outcome",
      "the call succeeds and returns A's response",
      'success containing "hello-from-A"',
      r.text,
      "Follow same-host redirects normally.",
    );
    ok(
      b.seen.length === 0,
      "same-host redirect",
      "no traffic reaches other hosts",
      "B receives 0 requests",
      `B received ${b.seen.length}`,
      "Do not contact unrelated hosts.",
    );
  });

  it("still works when there is no redirect", async () => {
    a.handler = (_req, res) => okJson(res, "plain-hello");

    const r = await talk(base(), `/${TOKEN}`);

    ok(
      r.succeeded && r.text.includes("plain-hello"),
      "no redirect",
      "a plain 200 response is returned unchanged",
      'success containing "plain-hello"',
      r.text,
      "Do not alter the non-redirect path.",
    );
    ok(
      a.seen.length === 1 && a.seen[0].body.includes(SECRET),
      "no redirect request",
      "the message is delivered to the endpoint host exactly once",
      "A sees 1 request carrying the message",
      show(a.seen),
      "Send the payload to the endpoint host once.",
    );
  });
});
