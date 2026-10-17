/**
 * Non-credential runtime settings (server identity, logging, audit
 * attribution, rate limit). Never reads an API key or base URL and never
 * throws, so it is safe to use before any environment is resolved.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface RuntimeSettings {
  serverName: string;
  serverVersion: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /**
   * Whether to declare plugin-performed actions as the `mcp-plugin` actor in
   * Cognigy's audit events (see utils/actorContext.ts). On by default.
   */
  auditAttribution: boolean;
  rateLimit: {
    maxRequests: number;
    windowMs: number;
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPackageVersion(): string {
  try {
    const packageJsonPath = join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: string;
    };
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const PACKAGE_VERSION = getPackageVersion();

const VALID_LOG_LEVELS = new Set<string>(["debug", "info", "warn", "error"]);

/** True for the usual affirmative env spellings. */
function isEnvFlagSet(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseIntWithDefault(
  envVar: string | undefined,
  defaultValue: number,
): number {
  if (!envVar) return defaultValue;
  const parsed = parseInt(envVar, 10);
  if (Number.isNaN(parsed)) {
    console.error(
      `[config] Invalid integer "${envVar}", using default ${defaultValue}`,
    );
    return defaultValue;
  }
  return parsed;
}

export function loadRuntimeSettings(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSettings {
  const rawLevel = env.LOG_LEVEL || "info";
  let logLevel: RuntimeSettings["logLevel"] = "info";
  if (VALID_LOG_LEVELS.has(rawLevel)) {
    logLevel = rawLevel as RuntimeSettings["logLevel"];
  } else {
    console.error(
      `[config] Invalid LOG_LEVEL "${rawLevel}", falling back to "info"`,
    );
  }
  return {
    serverName: env.MCP_SERVER_NAME || "cognigy-api-mcp",
    serverVersion: env.MCP_SERVER_VERSION || PACKAGE_VERSION,
    logLevel,
    // Opt-out only: attributing the plugin in a customer's audit log is the
    // desirable default, but it changes what gets recorded, so leave an escape
    // hatch.
    auditAttribution: !isEnvFlagSet(env.COGNIGY_DISABLE_AUDIT_ATTRIBUTION),
    rateLimit: {
      maxRequests: parseIntWithDefault(env.RATE_LIMIT_MAX_REQUESTS, 100),
      windowMs: parseIntWithDefault(env.RATE_LIMIT_WINDOW_MS, 60000),
    },
  };
}
