/**
 * Engine cache pre-warm. The plugin's MCP server is launched through `npx -p
 * <engine spec>`, and a cold first launch (download + build) can outlast Claude
 * Code's 30s MCP connect timeout. `npx -p <spec> node --version` fetches and
 * builds the engine into npm's cache without starting the MCP server, so the
 * first real session boots from cache.
 */
import { detectOnPath, runCliTool } from "./cliRunner.js";
import { ENGINE_NPX_FLAGS } from "./forkIdentity.js";

const PREWARM_TIMEOUT_MS = 180_000;

export type PrewarmResult = { ok: true } | { ok: false; reason: string };

export function buildPrewarmArgs(spec: string): string[] {
  return [...ENGINE_NPX_FLAGS, "-y", "-p", spec, "node", "--version"];
}

/** Best-effort: never throws; failure is reported, not raised. */
export function prewarmEngine(spec: string): PrewarmResult {
  try {
    const npxPath = detectOnPath("npx");
    if (!npxPath) return { ok: false, reason: "npx was not found on PATH" };
    const res = runCliTool("npx", npxPath, buildPrewarmArgs(spec), {
      timeoutMs: PREWARM_TIMEOUT_MS,
    });
    if (res.error) return { ok: false, reason: res.error.message };
    if (res.status !== 0)
      return {
        ok: false,
        reason: `npx exited with status ${res.status} (if npm printed EALLOWGIT, see the README section "Troubleshooting the first start")`,
      };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
