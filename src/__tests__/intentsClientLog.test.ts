/**
 * The API client must not log upstream error text for NLU (intent) endpoints,
 * because it can echo training sentences. Talks only to a local http server on
 * 127.0.0.1 (ephemeral port); the logger is spied on, never the network.
 */
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { CognigyApiClient } from "../api/client.js";
import { logger } from "../utils/logger.js";

const SENTINEL = "SENTINEL_UPSTREAM_DETAIL_zq91";
const FLOW = "ffffffffffffffffffffff01";
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: 400,
        title: "Bad Request",
        detail: `Sentence rejected: ${SENTINEL}`,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

let spies: ReturnType<typeof jest.spyOn>[];
beforeEach(() => {
  spies = (["info", "debug", "warn", "error"] as const).map((level) =>
    jest.spyOn(logger, level).mockImplementation(() => {}),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});

const allLogged = (): string =>
  JSON.stringify(spies.flatMap((s) => s.mock.calls));
const responseErrors = (): any[] =>
  (spies[3].mock.calls as any[][])
    .filter(([m]) => m === "API Response Error")
    .map(([, meta]) => meta);

const client = () =>
  new CognigyApiClient({
    baseUrl,
    apiKey: "Some-Key-0123456789",
    maxRetries: 0,
  });

describe("API Response Error log for intent endpoints", () => {
  it("withholds the upstream detail for a URL containing /intents", async () => {
    const url = `/v2.0/flows/${FLOW}/intents`;
    await expect(client().get(url)).rejects.toBeDefined();

    expect(allLogged()).not.toContain(SENTINEL);
    const entries = responseErrors();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("[withheld: NLU endpoint]");
    expect(entries[0].status).toBe(400);
    expect(entries[0].url).toBe(url);
  });

  it("also withholds it for a nested intent URL", async () => {
    const url = `/v2.0/flows/${FLOW}/intents/aaaaaaaaaaaaaaaaaaaa0001/sentences`;
    await expect(client().patch(url, {})).rejects.toBeDefined();
    expect(allLogged()).not.toContain(SENTINEL);
    expect(responseErrors()[0].message).toBe("[withheld: NLU endpoint]");
  });

  it("still logs the detail for a URL without /intents", async () => {
    const url = `/v2.0/flows/${FLOW}`;
    await expect(client().get(url)).rejects.toBeDefined();

    const entries = responseErrors();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe(`Sentence rejected: ${SENTINEL}`);
    expect(entries[0].status).toBe(400);
    expect(entries[0].url).toBe(url);
  });

  it("leaves the rejected error unchanged: its message still carries the detail", async () => {
    const url = `/v2.0/flows/${FLOW}/intents`;
    const err: any = await client()
      .get(url)
      .then(
        () => undefined,
        (e) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`Sentence rejected: ${SENTINEL}`);
    expect(err.status).toBe(400);
  });
});
