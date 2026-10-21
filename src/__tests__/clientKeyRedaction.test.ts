/**
 * An upstream error body that echoes the API key must not put the key in any
 * log line. CognigyApiClient ("API Response Error") and ToolHandlers ("Tool
 * call failed") both log before the dispatcher redacts its own result.
 * Only ever talks to a local http server on 127.0.0.1 (ephemeral port).
 */
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { CognigyApiClient } from "../api/client.js";
import { ToolHandlers } from "../tools/handlers.js";

const API_KEY = "Leaky-Key-0123456789";
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
        detail: `Invalid credential ${API_KEY}`,
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

describe("API key redaction in client and handler logs", () => {
  it("no log line contains the key when the API echoes it in an error detail", async () => {
    const lines: string[] = [];
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    try {
      const client = new CognigyApiClient({
        baseUrl,
        apiKey: API_KEY,
        maxRetries: 0,
      });
      const handlers = new ToolHandlers(client, "http://127.0.0.1:1");
      await expect(
        handlers.handleToolCall("list_resources", { resourceType: "project" }),
      ).rejects.toBeDefined();
    } finally {
      spy.mockRestore();
    }

    expect(lines.some((l) => l.includes("API Response Error"))).toBe(true);
    expect(lines.some((l) => l.includes("Tool call failed"))).toBe(true);
    const leaked = lines.filter((l) =>
      l.toLowerCase().includes(API_KEY.toLowerCase()),
    );
    expect(leaked).toEqual([]);
  });
});
