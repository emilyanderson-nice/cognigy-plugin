import { jest } from "@jest/globals";
import {
  loadProfiles,
  type Profile,
  type ProfileSet,
} from "../../profiles/profiles.js";
import {
  createEnvironmentRegistry,
  type EnvironmentRuntime,
} from "../../environments/registry.js";
import {
  USE_ENVIRONMENT_TOOL,
  createSessionPin,
  createUseEnvironment,
} from "../../environments/sessionPin.js";
import {
  createDispatcher,
  type ToolDefinition,
  type ToolResult,
} from "../../server/dispatch.js";

export const KEY_A = "fake-key-AAAA-distinct-1";
export const KEY_B = "fake-key-BBBB-distinct-2";
export const KEY_BROKEN = "fake-key-BROKEN-distinct-4";
export const ALL_KEYS = [KEY_A, KEY_B, KEY_BROKEN];

const P = "COGNIGY_PROFILE_";
type Env = Record<string, string>;

export const apiUrl = (n: string): string => `https://api-${n}.cognigy.ai`;
export const endpointUrl = (n: string): string =>
  `https://endpoint-${n}.cognigy.ai`;

/** One usable env profile (NAME uppercase) with explicit api + endpoint URLs. */
export function usable(name: string, key: string): Env {
  const l = name.toLowerCase();
  return {
    [`${P}${name}_API_BASE_URL`]: apiUrl(l),
    [`${P}${name}_API_KEY`]: key,
    [`${P}${name}_ENDPOINT_BASE_URL`]: endpointUrl(l),
  };
}
/** A broken env profile: key present, URL missing. */
export function broken(name: string, key = KEY_BROKEN): Env {
  return { [`${P}${name}_API_KEY`]: key };
}
export const setOf = (...envs: Env[]): ProfileSet =>
  loadProfiles({ env: Object.assign({}, ...envs) });

export type HandlerImpl = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export const idTask = <T>(fn: () => Promise<T>): Promise<T> => fn();

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>))
      deepFreeze(v);
  }
  return value;
}

export const tool = (
  name: string,
  extra: Partial<ToolDefinition> = {},
): ToolDefinition => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", properties: { x: { type: "string" } } },
  ...extra,
});

export const LIST_ENV_TOOL: ToolDefinition = {
  name: "list_environments",
  description: "Lists environments",
  inputSchema: {
    type: "object",
    properties: { check: { type: "boolean", description: "probe" } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export interface HarnessOptions {
  set: ProfileSet;
  tools?: ReadonlyArray<ToolDefinition>;
  /** Per-environment handler behaviour; default echoes {echo:{name,args}}. */
  impl?: Record<string, HandlerImpl>;
  /** Passed to the dispatcher as deps.taskContext when given. */
  taskContext?: () => { taskId?: string; sessionId?: string };
  /** Wire a session pin and the use_environment tool, as bootstrap does. */
  session?: boolean;
}

export function harness(opts: HarnessOptions) {
  let current = opts.set;
  const handlerCalls: Record<
    string,
    jest.Mock<(n: string, a: Record<string, unknown>) => Promise<unknown>>
  > = {};
  const resolveSpy = { count: 0 };
  let loads = 0;
  const createRuntime = (profile: Profile): EnvironmentRuntime => {
    const impl: HandlerImpl =
      opts.impl?.[profile.name] ??
      (async (n, a) => ({ echo: { name: n, args: a } }));
    const fn = jest.fn<HandlerImpl>(impl);
    handlerCalls[profile.name] = fn;
    return { profile, client: {}, handlers: { handleToolCall: fn } };
  };
  const inner = createEnvironmentRegistry({
    loadProfiles: () => {
      loads++;
      return current;
    },
    createRuntime,
  });
  const registry = {
    snapshot: jest.fn(() => inner.snapshot()),
    resolve: jest.fn((name?: string) => {
      resolveSpy.count++;
      return inner.resolve(name);
    }),
  };
  const rateLimiter = {
    check: jest.fn<(key: string) => boolean>(() => true),
  };
  const logger = {
    info: jest.fn<(m: string, meta?: Record<string, unknown>) => void>(),
    warn: jest.fn<(m: string, meta?: Record<string, unknown>) => void>(),
    error: jest.fn<(m: string, meta?: Record<string, unknown>) => void>(),
  };
  const runWithTask = jest.fn<(fn: () => Promise<unknown>) => Promise<unknown>>(
    (fn) => fn(),
  );
  const listEnvironments = jest.fn<
    (a: Record<string, unknown>) => Promise<Record<string, unknown>>
  >(async () => ({ environments: [] }));
  const tools = opts.tools ?? [tool("alpha"), tool("talk_to_agent")];
  const pin = createSessionPin();
  const dispatcher = createDispatcher({
    registry,
    tools,
    rateLimiter,
    logger,
    runWithTask: runWithTask as unknown as <T>(
      fn: () => Promise<T>,
    ) => Promise<T>,
    listEnvironments,
    listEnvironmentsTool: LIST_ENV_TOOL,
    ...(opts.taskContext ? { taskContext: opts.taskContext } : {}),
    ...(opts.session
      ? {
          session: {
            pin,
            tool: USE_ENVIRONMENT_TOOL,
            use: createUseEnvironment({ registry, pin }),
          },
        }
      : {}),
  });
  return {
    dispatcher,
    registry,
    rateLimiter,
    logger,
    runWithTask,
    listEnvironments,
    handlerCalls,
    pin,
    loadCount: () => loads,
    setSet(next: ProfileSet) {
      current = next;
    },
  };
}

export const parse = (r: ToolResult): Record<string, unknown> =>
  JSON.parse(r.content[0].text) as Record<string, unknown>;

/** Every logged message+meta, serialised, across all levels. */
export function allLogged(h: ReturnType<typeof harness>): string {
  return JSON.stringify([
    h.logger.info.mock.calls,
    h.logger.warn.mock.calls,
    h.logger.error.mock.calls,
  ]);
}
