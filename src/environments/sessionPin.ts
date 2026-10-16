/**
 * Session pin: one MCP server process serves one session, so the session can
 * be pinned to one environment, at launch (COGNIGY_ENVIRONMENT) or with the
 * `use_environment` tool. Calls without an `environment` argument then route
 * to the pin; the dispatcher never falls back to another environment.
 */
import type { ToolDefinition } from "../server/dispatch.js";
import { hostOf } from "../profiles/profiles.js";
import type { EnvironmentRegistry } from "./registry.js";

export const PIN_ENV_VAR = "COGNIGY_ENVIRONMENT";

export type PinSource = typeof PIN_ENV_VAR | "use_environment";

export interface Pin {
  name: string;
  source: PinSource;
}

/** A launch value that could not pin the session. */
export interface RejectedPin {
  value: string;
  reason: string;
}

export interface SessionPin {
  get(): Pin | undefined;
  rejected(): RejectedPin | undefined;
  /** Pins the session and forgets any rejected launch value. */
  set(pin: Pin): void;
  reject(rejected: RejectedPin): void;
  /** Removes the pin and any rejected launch value. */
  clear(): void;
}

export function createSessionPin(): SessionPin {
  let pin: Pin | undefined;
  let bad: RejectedPin | undefined;
  return {
    get: () => (pin ? { ...pin } : undefined),
    rejected: () => (bad ? { ...bad } : undefined),
    set(next) {
      pin = { ...next };
      bad = undefined;
    },
    reject(next) {
      pin = undefined;
      bad = { ...next };
    },
    clear() {
      pin = undefined;
      bad = undefined;
    },
  };
}

/**
 * Applies COGNIGY_ENVIRONMENT at boot. Never throws: an unknown or unusable
 * value leaves no pin, is remembered as rejected, and returns a warning.
 */
export function applyLaunchPin(
  registry: EnvironmentRegistry,
  pin: SessionPin,
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const { profile } = registry.resolve(value);
    pin.set({ name: profile.name, source: PIN_ENV_VAR });
    return undefined;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    pin.reject({ value, reason });
    return `${PIN_ENV_VAR}="${value}" does not name a usable environment, so this session is not pinned: ${reason} Calls without an environment argument will fail until use_environment pins one.`;
  }
}

export const USE_ENVIRONMENT_TOOL: ToolDefinition = {
  name: "use_environment",
  description:
    "Pin this session to one Cognigy environment, so later calls without an `environment` argument run there. " +
    "Pass name to pin (validated; unknown names are refused with the available ones) or clear: true to remove the pin. " +
    "An explicit `environment` argument still overrides the pin for that call. Never returns API keys.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Environment to pin, as listed by list_environments. Case and _/- do not matter.",
      },
      clear: {
        type: "boolean",
        description: "Pass true to remove the pin.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export interface UseEnvironmentDeps {
  registry: EnvironmentRegistry;
  pin: SessionPin;
}

/** Throws on bad arguments, or an EnvironmentError for an unusable name. */
export function createUseEnvironment(
  deps: UseEnvironmentDeps,
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (args) => {
    const { name, clear } = args ?? {};
    if (clear !== undefined && clear !== true) {
      throw new Error('Invalid "clear" argument: pass clear: true or omit it.');
    }
    if (clear === true) {
      if (name !== undefined) {
        throw new Error('Pass either "name" or "clear: true", not both.');
      }
      const previous = deps.pin.get()?.name ?? null;
      deps.pin.clear();
      return { pinned: null, cleared: previous };
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(
        'Pass "name" (an environment from list_environments) to pin, or "clear: true" to remove the pin.',
      );
    }
    const { profile } = deps.registry.resolve(name);
    const previous = deps.pin.get()?.name ?? null;
    deps.pin.set({ name: profile.name, source: "use_environment" });
    return {
      pinned: {
        name: profile.name,
        host: hostOf(profile.apiBaseUrl),
        source: "use_environment",
      },
      previous,
    };
  };
}
