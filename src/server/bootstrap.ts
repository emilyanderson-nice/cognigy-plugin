/**
 * Assembles the registry and dispatcher the MCP server runs on. Needs no
 * credentials and never throws for zero configured environments.
 */
import { tools } from "../tools/definitions.js";
import {
  loadRuntimeSettings,
  type RuntimeSettings,
} from "../runtimeSettings.js";
import {
  createEnvironmentRegistry,
  type EnvironmentRegistry,
  type EnvironmentRuntime,
} from "../environments/registry.js";
import {
  createListEnvironments,
  LIST_ENVIRONMENTS_TOOL,
} from "../environments/listEnvironments.js";
import {
  USE_ENVIRONMENT_TOOL,
  applyLaunchPin,
  createSessionPin,
  createUseEnvironment,
  type SessionPin,
} from "../environments/sessionPin.js";
import {
  loadProfilesFromSystem,
  type Profile,
  type ProfileSet,
} from "../profiles/profiles.js";
import { createReleaseDetector, type HttpGetter } from "../profiles/release.js";
import { RateLimiter } from "../utils/rateLimiter.js";
import { logger } from "../utils/logger.js";
import { getSessionId, getTaskId, runWithTask } from "../utils/actorContext.js";
import {
  createDispatcher,
  type Dispatcher,
  type ToolDefinition,
} from "./dispatch.js";
import { createRuntimeFactory } from "./runtimeFactory.js";
import {
  DISABLED_SESSION_STATE,
  createSessionState,
  installStatuslineScript,
  sessionStateDisabled,
  type SessionState,
  type SessionStateOptions,
} from "../environments/sessionState.js";

export interface BootstrapDeps {
  env?: NodeJS.ProcessEnv;
  loadProfiles?: () => ProfileSet;
  createRuntime?: (profile: Profile) => EnvironmentRuntime;
  /** Status line state file; false disables it (default: the real one). */
  sessionState?: SessionStateOptions | false;
}

export interface ServerParts {
  settings: RuntimeSettings;
  registry: EnvironmentRegistry;
  dispatcher: Dispatcher;
  rateLimiter: RateLimiter;
  pin: SessionPin;
  /** The status line state file; remove() on shutdown. */
  sessionState: SessionState;
  /** Boot-time warnings, evaluated from a fresh snapshot on each call. */
  startupNotices(): string[];
}

export function buildServerParts(deps: BootstrapDeps = {}): ServerParts {
  const env = deps.env ?? process.env;
  const settings = loadRuntimeSettings(env);
  const registry = createEnvironmentRegistry({
    loadProfiles:
      deps.loadProfiles ??
      (() => loadProfilesFromSystem({ env, strict: true })),
    createRuntime:
      deps.createRuntime ??
      createRuntimeFactory({ auditAttribution: settings.auditAttribution }),
  });
  const rateLimiter = new RateLimiter(settings.rateLimit);
  const pin = createSessionPin();
  const pinWarning = applyLaunchPin(registry, pin, env);
  const launchPin = pin.get();
  if (launchPin) {
    logger.info("Session pinned to environment", {
      environment: launchPin.name,
      source: launchPin.source,
    });
  }

  const sessionState = startSessionState(registry, pin, env, deps.sessionState);

  // One detector per runtime object: a rebuilt runtime gets a fresh one.
  const detectors = new WeakMap<
    EnvironmentRuntime,
    ReturnType<typeof createReleaseDetector>
  >();
  const detectRelease = (profile: Profile) => {
    const runtime = registry.resolve(profile.name);
    let detector = detectors.get(runtime);
    if (!detector) {
      detector = createReleaseDetector(runtime.client as HttpGetter);
      detectors.set(runtime, detector);
    }
    return detector.detect();
  };

  const dispatcher = createDispatcher({
    registry,
    tools: tools as unknown as ReadonlyArray<ToolDefinition>,
    rateLimiter,
    logger,
    runWithTask,
    taskContext: () => ({ taskId: getTaskId(), sessionId: getSessionId() }),
    listEnvironments: createListEnvironments({ registry, detectRelease, pin }),
    listEnvironmentsTool: LIST_ENVIRONMENTS_TOOL,
    session: {
      pin,
      tool: USE_ENVIRONMENT_TOOL,
      use: createUseEnvironment({ registry, pin }),
    },
    onPinChanged: () => sessionState.write(),
    onDispatched: (environment) => sessionState.dispatched(environment),
  });
  const startupNotices = (): string[] => {
    const pinNotices =
      pinWarning !== undefined && pin.rejected() ? [pinWarning] : [];
    const snap = registry.snapshot();
    if (snap.loadError !== undefined) {
      return [
        `Environment configuration could not be loaded: ${snap.loadError}`,
        ...pinNotices,
      ];
    }
    return snap.configuredNames.length === 0
      ? [
          'No Cognigy environment is configured; tool calls will fail until one is added. Run "cognigy-setup profile add".',
          ...pinNotices,
        ]
      : pinNotices;
  };
  return {
    settings,
    registry,
    dispatcher,
    rateLimiter,
    pin,
    sessionState,
    startupNotices,
  };
}

/** Writes the boot state file and installs the status line script. */
function startSessionState(
  registry: EnvironmentRegistry,
  pin: SessionPin,
  env: NodeJS.ProcessEnv,
  options: SessionStateOptions | false | undefined,
): SessionState {
  const log = (message: string, meta?: Record<string, unknown>) =>
    logger.debug(message, meta);
  if (options === false) return DISABLED_SESSION_STATE;
  const opts: SessionStateOptions = { env, log, ...options };
  const state = createSessionState(registry, pin, opts);
  state.write();
  if (!sessionStateDisabled(opts.env ?? env)) {
    installStatuslineScript(opts.homeDir, opts.scriptSources, opts.log);
  }
  return state;
}
