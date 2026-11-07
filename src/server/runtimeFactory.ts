/**
 * Builds the per-environment runtime (one API client + one ToolHandlers) for a
 * profile. Produces no output of its own besides the one-time proxy log and
 * makes no network calls; the key is only handed to the client.
 */
import { CognigyApiClient } from "../api/client.js";
import { ToolHandlers } from "../tools/handlers.js";
import { logProxyConfiguration } from "../utils/proxy.js";
import { VoiceGatewayClient } from "../voicegateway/client.js";
import type { Profile } from "../profiles/profiles.js";
import type { EnvironmentRuntime } from "../environments/registry.js";

export interface RuntimeFactoryDeps {
  auditAttribution: boolean;
  createClient?: (config: {
    baseUrl: string;
    apiKey: string;
    auditAttribution: boolean;
  }) => unknown;
  createHandlers?: (
    client: unknown,
    endpointBaseUrl: string,
    webchatBaseUrl: string,
    staticFilesBaseUrl: string,
    voiceGateway?: VoiceGatewayClient,
  ) => EnvironmentRuntime["handlers"];
  createVoiceGatewayClient?: (config: {
    baseUrl: string;
    apiKey: string;
  }) => VoiceGatewayClient;
  logProxy?: (apiBaseUrl: string) => void;
}

export function createRuntimeFactory(
  deps: RuntimeFactoryDeps,
): (profile: Profile) => EnvironmentRuntime {
  const createClient =
    deps.createClient ?? ((config) => new CognigyApiClient(config));
  const createHandlers =
    deps.createHandlers ??
    ((
      client,
      endpoint,
      webchat,
      staticFiles,
      voiceGateway?: VoiceGatewayClient,
    ) =>
      new ToolHandlers(
        client as CognigyApiClient,
        endpoint,
        webchat,
        staticFiles,
        voiceGateway,
      ));
  const createVoiceGatewayClient =
    deps.createVoiceGatewayClient ??
    ((config) => new VoiceGatewayClient(config));
  const logProxy = deps.logProxy ?? logProxyConfiguration;
  const loggedHosts = new Set<string>();

  return (profile) => {
    if (!loggedHosts.has(profile.apiBaseUrl)) {
      loggedHosts.add(profile.apiBaseUrl);
      logProxy(profile.apiBaseUrl);
    }
    const client = createClient({
      baseUrl: profile.apiBaseUrl,
      apiKey: profile.apiKey,
      auditAttribution: deps.auditAttribution,
    });
    const urls = [
      client,
      profile.endpointBaseUrl,
      profile.webchatBaseUrl,
      profile.staticFilesBaseUrl,
    ] as const;
    // Only an environment with Voice Gateway credentials gets a client; the
    // others call createHandlers exactly as before.
    const handlers =
      profile.voiceGatewayBaseUrl && profile.voiceGatewayApiKey
        ? createHandlers(
            ...urls,
            createVoiceGatewayClient({
              baseUrl: profile.voiceGatewayBaseUrl,
              apiKey: profile.voiceGatewayApiKey,
            }),
          )
        : createHandlers(...urls);
    return { profile, client, handlers };
  };
}
