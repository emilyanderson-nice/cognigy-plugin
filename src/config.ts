/**
 * Configuration for NiCE Cognigy Plugin
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readUserConfigFile, USER_CONFIG_FILE } from "./userConfigFile.js";
import {
  deriveEndpointBaseUrl,
  deriveStaticFilesBaseUrl,
  deriveWebchatBaseUrl,
  hostDerivationFailed,
  normalizeApiBaseUrl,
} from "./hosts.js";
import { placeholderHint, usableEnv } from "./placeholders.js";

export interface Config {
  apiBaseUrl: string;
  endpointBaseUrl: string;
  webchatBaseUrl: string;
  staticFilesBaseUrl: string;
  apiKey: string;
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

/**
 * Load configuration from environment variables
 */
export function loadConfig(): Config {
  // Environment variables win (terminal install stores them via userConfig /
  // keychain). Only when one is missing — or arrived as an unexpanded
  // `${user_config.*}` placeholder, which is the same thing — do we consult the
  // on-disk fallback written by the `cognigy-setup` CLI. That is the path hosts
  // take when their installer never prompted for credentials.
  const envApiBaseUrl = usableEnv(process.env.COGNIGY_API_BASE_URL);
  const envApiKey = usableEnv(process.env.COGNIGY_API_KEY);

  const fileConfig = envApiBaseUrl && envApiKey ? {} : readUserConfigFile();

  const apiBaseUrl = envApiBaseUrl || fileConfig.COGNIGY_API_BASE_URL;
  const apiKey = envApiKey || fileConfig.COGNIGY_API_KEY;

  if (!apiBaseUrl) {
    throw new Error(
      `COGNIGY_API_BASE_URL is not set.` +
        placeholderHint(process.env.COGNIGY_API_BASE_URL) +
        ` Provide it via the plugin install prompt, ` +
        `or run "npx -y -p @cognigy/plugin-engine cognigy-setup" to write ${USER_CONFIG_FILE}.`,
    );
  }

  if (!apiKey) {
    throw new Error(
      `COGNIGY_API_KEY is not set.` +
        placeholderHint(process.env.COGNIGY_API_KEY) +
        ` Provide it via the plugin install prompt, ` +
        `or run "npx -y -p @cognigy/plugin-engine cognigy-setup" to write ${USER_CONFIG_FILE}.`,
    );
  }

  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);

  // The sibling hosts (endpoint, webchat, static) are normally derived from the
  // API host. Explicit overrides win, from the environment or — for hosts whose
  // credentials already come from the setup file, i.e. GUI clients — from that
  // same file, so a self-hosted layout can be described in one place.
  const endpointBaseUrl =
    usableEnv(process.env.COGNIGY_ENDPOINT_BASE_URL) ||
    fileConfig.COGNIGY_ENDPOINT_BASE_URL ||
    deriveEndpointBaseUrl(normalizedApiBaseUrl);

  const webchatBaseUrl =
    usableEnv(process.env.COGNIGY_WEBCHAT_BASE_URL) ||
    fileConfig.COGNIGY_WEBCHAT_BASE_URL ||
    deriveWebchatBaseUrl(normalizedApiBaseUrl);

  const staticFilesBaseUrl =
    usableEnv(process.env.COGNIGY_STATIC_FILES_BASE_URL) ||
    fileConfig.COGNIGY_STATIC_FILES_BASE_URL ||
    deriveStaticFilesBaseUrl(normalizedApiBaseUrl);

  // Without a recognisable "api" segment every derived URL silently equals
  // the API URL, and the first symptom is talk_to_agent posting endpoint
  // traffic at service-api. Say so at boot, once, where the MCP log shows it.
  if (
    hostDerivationFailed(normalizedApiBaseUrl) &&
    endpointBaseUrl === normalizedApiBaseUrl
  ) {
    console.error(
      `[config] Could not derive the endpoint host from ${normalizedApiBaseUrl} ` +
        `(no "api" segment in the hostname); endpoint requests will go to the ` +
        `API host. Set COGNIGY_ENDPOINT_BASE_URL (and COGNIGY_WEBCHAT_BASE_URL, ` +
        `COGNIGY_STATIC_FILES_BASE_URL) if your deployment uses other hosts.`,
    );
  }

  return {
    apiBaseUrl: normalizedApiBaseUrl,
    endpointBaseUrl,
    webchatBaseUrl,
    staticFilesBaseUrl,
    apiKey,
    serverName: process.env.MCP_SERVER_NAME || "cognigy-api-mcp",
    serverVersion: process.env.MCP_SERVER_VERSION || PACKAGE_VERSION,
    logLevel: (() => {
      const raw = process.env.LOG_LEVEL || "info";
      if (!VALID_LOG_LEVELS.has(raw)) {
        console.error(
          `[config] Invalid LOG_LEVEL "${raw}", falling back to "info"`,
        );
        return "info" as Config["logLevel"];
      }
      return raw as Config["logLevel"];
    })(),
    // Opt-out only: attributing the plugin in a customer's audit log is the
    // desirable default, but it changes what gets recorded, so leave an escape
    // hatch.
    auditAttribution: !isEnvFlagSet(
      process.env.COGNIGY_DISABLE_AUDIT_ATTRIBUTION,
    ),
    rateLimit: {
      maxRequests: parseIntWithDefault(
        process.env.RATE_LIMIT_MAX_REQUESTS,
        100,
      ),
      windowMs: parseIntWithDefault(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    },
  };
}
