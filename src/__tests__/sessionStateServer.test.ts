/**
 * The real server (spawned over stdio) writes its session state file at boot
 * and removes it on every shutdown path. COGNIGY_SESSION_KEY names the file,
 * so no claude ancestor is needed. Each server runs in a temp HOME.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { existsSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import {
  BOOT_TIMEOUT_MS,
  makeTempHome,
  startMcpServer,
} from "./helpers/mcpStdio.js";

const KEY = "state-e2e-key-distinct-77";
const TIMEOUT = BOOT_TIMEOUT_MS + 30000;
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const boot = async (sessionKey: string, extra: Record<string, string> = {}) => {
  const home = makeTempHome();
  homes.push(home);
  const s = await startMcpServer({
    home,
    env: {
      COGNIGY_PROFILE_A_API_BASE_URL: "https://api-a.invalid",
      COGNIGY_PROFILE_A_API_KEY: KEY,
      COGNIGY_PROFILE_B_API_BASE_URL: "https://api-b.invalid",
      COGNIGY_PROFILE_B_API_KEY: KEY,
      COGNIGY_ENVIRONMENT: "b",
      COGNIGY_SESSION_KEY: sessionKey,
      ...extra,
    },
  });
  const file = join(home, ".cognigy-plugin", "sessions", `${sessionKey}.json`);
  return { s, home, file };
};

describe("session state file through the real server", () => {
  for (const how of ["SIGTERM", "SIGINT", "stdin-end"] as const) {
    it(
      `is written at boot and removed on ${how}`,
      async () => {
        const { s, home, file } = await boot(`e2e-${how}`);
        const raw = readFileSync(file, "utf8");
        expect(raw).not.toContain(KEY);
        expect(JSON.parse(raw)).toMatchObject({
          pinned: "b",
          pinSource: "COGNIGY_ENVIRONMENT",
          host: "api-b.invalid",
          configured: 2,
          claudePid: null,
        });
        const stable = join(home, ".cognigy-plugin", "statusline-segment.sh");
        expect(existsSync(stable)).toBe(true);
        if (process.platform !== "win32") {
          expect(statSync(stable).mode & 0o777).toBe(0o700);
        }
        await s.callToolJson("use_environment", { name: "a" });
        expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
          pinned: "a",
          pinSource: "use_environment",
        });
        await s.stop(how);
        expect(existsSync(file)).toBe(false);
      },
      TIMEOUT,
    );
  }

  it(
    "COGNIGY_SESSION_STATE=0 writes nothing",
    async () => {
      const { s, home } = await boot("e2e-off", { COGNIGY_SESSION_STATE: "0" });
      expect(existsSync(join(home, ".cognigy-plugin"))).toBe(false);
      await s.stop("SIGTERM");
    },
    TIMEOUT,
  );
});
