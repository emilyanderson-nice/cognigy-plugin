/**
 * Configuration for NiCE Cognigy Plugin
 */
import { readUserConfigFile, USER_CONFIG_FILE } from "./userConfigFile.js";
import {
  deriveEndpointBaseUrl,
  deriveStaticFilesBaseUrl,
  deriveWebchatBaseUrl,
  hostDerivationFailed,
  normalizeApiBaseUrl,
} from "./hosts.js";
import { placeholderHint, usableEnv } from "./placeholders.js";
import { FORK_REPO } from "./install/forkIdentity.js";
import {
  loadRuntimeSettings,
  type RuntimeSettings,
} from "./runtimeSettings.js";

export interface Config extends RuntimeSettings {
  apiBaseUrl: string;
  endpointBaseUrl: string;
  webchatBaseUrl: string;
  staticFilesBaseUrl: string;
  apiKey: string;
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
        `or run "npx -y -p github:${FORK_REPO} cognigy-setup" to write ${USER_CONFIG_FILE}.`,
    );
  }

  if (!apiKey) {
    throw new Error(
      `COGNIGY_API_KEY is not set.` +
        placeholderHint(process.env.COGNIGY_API_KEY) +
        ` Provide it via the plugin install prompt, ` +
        `or run "npx -y -p github:${FORK_REPO} cognigy-setup" to write ${USER_CONFIG_FILE}.`,
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
    ...loadRuntimeSettings(),
  };
}
