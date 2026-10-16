/**
 * talk_to_agent follows redirects in the real transport. The host guard only
 * vets the first URL, so a redirect from the environment's endpoint host to
 * another host must be refused before the message body is sent there.
 * Only ever talks to local http servers on 127.0.0.1 (ephemeral ports).
 */
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { ToolHandlers } from "../tools/handlers.js";
import { clearProxyAgentCache } from "../utils/proxy.js";

const PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];
const savedEnv: Record<string, string | undefined> = {};

let a: Server;
let b: Server;
let baseA: string;
let baseB: string;
let bodiesAtB: string[] = [];

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = async (server: Server): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
};

beforeAll(async () => {
  for (const key of PROXY_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  clearProxyAgentCache();
  b = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodiesAtB.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "from B" }));
    });
  });
  baseB = await listen(b);
  a = createServer((req, res) => {
    req.resume();
    if (req.url?.includes("/final")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "from A" }));
    } else if (req.url?.includes("sametoken")) {
      res.writeHead(307, { Location: `${baseA}/final` });
      res.end();
    } else {
      res.writeHead(307, { Location: `${baseB}/othertoken` });
      res.end();
    }
  });
  baseA = await listen(a);
});
afterAll(async () => {
  await close(a);
  await close(b);
  for (const key of PROXY_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  clearProxyAgentCache();
});
beforeEach(() => {
  bodiesAtB = [];
});

const handlers = () => new ToolHandlers({} as never, baseA);

describe("talk_to_agent redirect hops", () => {
  it("refuses a redirect to another host and never sends the body there", async () => {
    const result = await handlers().handleTalkToAgent({
      endpointUrl: `${baseA}/crosstoken`,
      message: "secret message for A only",
    });

    expect(bodiesAtB).toEqual([]);
    expect(result.agentResponse).toBeUndefined();
    expect(String(result.error)).toContain("Request failed");
    expect(String(result.detail)).toContain("redirect");
  });

  it("still follows a redirect that stays on the endpoint host", async () => {
    const result = await handlers().handleTalkToAgent({
      endpointUrl: `${baseA}/sametoken`,
      message: "hi",
    });

    expect(result.agentResponse).toBe("from A");
  });
});
