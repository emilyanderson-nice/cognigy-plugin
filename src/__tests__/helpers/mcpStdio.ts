/**
 * Minimal MCP stdio client for spawning the real TypeScript server entry.
 * Newline-delimited JSON-RPC 2.0 over the child's stdin/stdout.
 *
 * Isolation contract: every spawned server gets a fresh temp HOME/USERPROFILE
 * and inherits NO COGNIGY_* variables from the parent, so it can never read
 * the real ~/.cognigy-plugin or real credentials.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const ENTRY = join(REPO_ROOT, "src", "index.ts");

export const BOOT_TIMEOUT_MS = 30000;
export const REQUEST_TIMEOUT_MS = 20000;

export interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

export interface McpServer {
  home: string;
  /** Everything the child has written to stderr so far. */
  stderr(): string;
  /** Everything the child has written to stdout so far (raw). */
  stdout(): string;
  request(method: string, params?: unknown): Promise<any>;
  listTools(): Promise<Array<Record<string, any>>>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult>;
  /** Parsed JSON of the first text block of a tool result. */
  callToolJson(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ result: ToolCallResult; body: Record<string, any> }>;
  close(): Promise<void>;
}

export function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "cognigy-mcp-home-"));
}

function isolatedEnv(
  home: string,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^COGNIGY_/i.test(k)) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    ...(process.platform === "win32"
      ? { HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) }
      : {}),
    LOG_LEVEL: "info",
    ...extra,
  };
}

export async function startMcpServer(opts: {
  env?: Record<string, string>;
  /** Pre-created temp home (e.g. with a config file already written). */
  home?: string;
}): Promise<McpServer> {
  const home = opts.home ?? makeTempHome();
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--import", "tsx", ENTRY],
    {
      cwd: REPO_ROOT,
      env: isolatedEnv(home, opts.env ?? {}),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let err = "";
  let out = "";
  let buffer = "";
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  child.stderr.on("data", (c: Buffer) => (err += c.toString()));
  child.stdout.on("data", (c: Buffer) => {
    const s = c.toString();
    out += s;
    buffer += s;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter =
        typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(
          new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`),
        );
      } else waiter.resolve(msg.result);
    }
  });

  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );

  const cleanupHome = () => {
    if (!opts.home) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  };

  const close = async () => {
    for (const w of pending.values()) w.reject(new Error("server closed"));
    pending.clear();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
    cleanupHome();
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `server did not start in ${BOOT_TIMEOUT_MS}ms; stderr: ${err.slice(-500)}`,
        ),
      );
    }, BOOT_TIMEOUT_MS);
    const check = () => {
      if (err.includes("started successfully")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stderr.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `server exited during startup (code ${code}); stderr: ${err.slice(-500)}`,
        ),
      );
    });
    check();
  }).catch(async (e) => {
    await close();
    throw e;
  });

  const request = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });

  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-stdio-test", version: "0.0.0" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
  } catch (e) {
    await close();
    throw e;
  }

  const callTool = (name: string, args: Record<string, unknown> = {}) =>
    request("tools/call", { name, arguments: args }) as Promise<ToolCallResult>;

  return {
    home,
    stderr: () => err,
    stdout: () => out,
    request,
    listTools: async () => (await request("tools/list", {})).tools,
    callTool,
    callToolJson: async (name, args) => {
      const result = await callTool(name, args);
      return { result, body: JSON.parse(result.content[0].text) };
    },
    close,
  };
}
