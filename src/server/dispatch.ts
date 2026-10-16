/**
 * Routes MCP tool calls to named Cognigy environments. Every tool gains an
 * optional `environment` argument; the registry resolves it, the call runs on
 * that profile's own handlers, and results carry an `_environment` marker.
 * A call without `environment` goes to the session pin when one is set.
 */
import {
  EnvironmentError,
  type EnvironmentRegistry,
} from "../environments/registry.js";
import {
  describeLaunchSource,
  type SessionPin,
} from "../environments/sessionPin.js";
import { hostOf } from "../profiles/profiles.js";
import { redactKey } from "../utils/redact.js";
import { checkEndpointUrl } from "./hostGuard.js";

const RATE_LIMIT_KEY_LIST_ENVIRONMENTS = "__list_environments";
const RATE_LIMIT_KEY_USE_ENVIRONMENT = "__use_environment";

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  annotations?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

type LogFn = (message: string, meta?: Record<string, unknown>) => void;

export interface DispatcherDeps {
  registry: EnvironmentRegistry;
  tools: ReadonlyArray<ToolDefinition>;
  rateLimiter: { check(key: string): boolean };
  logger: { info: LogFn; warn: LogFn; error: LogFn };
  runWithTask<T>(fn: () => Promise<T>): Promise<T>;
  /** Ids of the running task, read inside runWithTask for the call log. */
  taskContext?(): { taskId?: string; sessionId?: string };
  listEnvironments(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  listEnvironmentsTool: ToolDefinition;
  /** Session pin and the use_environment tool that sets it. */
  session?: {
    pin: SessionPin;
    tool: ToolDefinition;
    use(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  /**
   * Observers for the session state file. Called after a pin change and after
   * a successfully dispatched call; a throwing observer is ignored.
   */
  onPinChanged?(): void;
  onDispatched?(environment: { name: string; host: string }): void;
}

export interface Dispatcher {
  listTools(): ToolDefinition[];
  callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<ToolResult>;
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (body: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  ...(isError ? { isError: true } : {}),
});

const environmentErrorBody = (
  err: EnvironmentError,
): Record<string, unknown> => ({
  error: err.message,
  code: err.code,
  ...(err.environment !== undefined ? { environment: err.environment } : {}),
  available: err.available,
});

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { registry, logger } = deps;

  const notify = (fn: (() => void) | undefined) => {
    if (!fn) return;
    try {
      fn();
    } catch {
      // Observers are best-effort and must never affect a tool call.
    }
  };

  function withEnvironmentProperty(
    tool: ToolDefinition,
    names: string[],
  ): ToolDefinition {
    const clone = structuredClone(tool);
    clone.inputSchema.properties = {
      ...(clone.inputSchema.properties ?? {}),
      environment: {
        type: "string",
        description:
          "Selects the Cognigy environment this call runs against. Required when more than one environment is configured, unless the session is pinned with use_environment (or at launch by COGNIGY_ENVIRONMENT or the plugin setting); optional otherwise. An explicit value overrides the pin for this call. Use list_environments to see the configured environments.",
        ...(names.length > 1 ? { enum: names } : {}),
      },
    };
    return clone;
  }

  function listTools(): ToolDefinition[] {
    const own = [deps.listEnvironmentsTool, deps.session?.tool]
      .filter((t): t is ToolDefinition => t !== undefined)
      .map((t) => t.name);
    const { configuredNames } = registry.snapshot();
    return [
      ...deps.tools
        .filter((t) => !own.includes(t.name))
        .map((t) => withEnvironmentProperty(t, configuredNames)),
      structuredClone(deps.listEnvironmentsTool),
      ...(deps.session ? [structuredClone(deps.session.tool)] : []),
    ];
  }

  async function callTool(
    name: string,
    rawArgs: Record<string, unknown> | undefined,
  ): Promise<ToolResult> {
    const { environment, ...args } = rawArgs ?? {};
    if (name === deps.listEnvironmentsTool.name) {
      if (!deps.rateLimiter.check(RATE_LIMIT_KEY_LIST_ENVIRONMENTS)) {
        return text({ error: "Rate limit exceeded" });
      }
      try {
        return text(await deps.listEnvironments(args));
      } catch (err) {
        return text({ error: messageOf(err) }, true);
      }
    }
    const session = deps.session;
    if (session && name === session.tool.name) {
      if (!deps.rateLimiter.check(RATE_LIMIT_KEY_USE_ENVIRONMENT)) {
        return text({ error: "Rate limit exceeded" });
      }
      try {
        const result = await session.use(args);
        logger.info("Session environment pin changed", {
          environment: session.pin.get()?.name,
        });
        notify(deps.onPinChanged);
        return text(result);
      } catch (err) {
        if (err instanceof EnvironmentError) {
          return text(environmentErrorBody(err), true);
        }
        return text({ error: messageOf(err) }, true);
      }
    }
    if (!deps.tools.some((t) => t.name === name)) {
      return text({ error: `Unknown tool: ${name}` }, true);
    }

    if (environment !== undefined && typeof environment !== "string") {
      return text(
        {
          error:
            'Invalid "environment" argument: expected a string naming an environment.',
        },
        true,
      );
    }

    // An explicit argument wins; otherwise the pin, if any, decides.
    const explicit =
      typeof environment === "string" && environment.trim() !== ""
        ? environment
        : undefined;
    const pin = explicit === undefined ? session?.pin.get() : undefined;
    const rejected =
      explicit === undefined && pin === undefined
        ? session?.pin.rejected()
        : undefined;

    return deps.runWithTask(async () => {
      const ids = () => deps.taskContext?.() ?? {};
      if (rejected) {
        logger.info(`Tool call received: ${name}`, {
          environment: undefined,
          ...ids(),
        });
        const available = registry.snapshot().configuredNames;
        return text(
          {
            error: `${describeLaunchSource(rejected)} does not name a usable environment, so this session is not pinned. Available environments: ${available.join(", ") || "(none)"}. Pass \`environment\` explicitly, or call use_environment to pin one.`,
            code: "pin_invalid",
            environment: rejected.value,
            reason: rejected.reason,
            available,
          },
          true,
        );
      }
      let runtime;
      try {
        runtime = registry.resolve(explicit ?? pin?.name);
      } catch (err) {
        logger.info(`Tool call received: ${name}`, {
          environment: undefined,
          ...ids(),
        });
        if (err instanceof EnvironmentError) {
          const body = environmentErrorBody(err);
          if (pin) {
            // Fail closed: a pin that no longer resolves never falls back.
            body.error = `This session is pinned to environment "${pin.name}" (set by ${pin.source}), which cannot be used: ${err.message} Calls are not sent to another environment; pass \`environment\` explicitly, or call use_environment to pin another.`;
            body.pinned = pin;
          }
          return text(body, true);
        }
        return text({ error: messageOf(err) }, true);
      }

      const { profile } = runtime;
      const marker = {
        name: profile.name,
        host: hostOf(profile.apiBaseUrl),
      };
      logger.info(`Tool call received: ${name}`, {
        environment: profile.name,
        ...ids(),
      });

      if (!deps.rateLimiter.check(profile.name)) {
        logger.warn(`Tool call rate limited: ${name}`, {
          environment: profile.name,
        });
        return text({ error: "Rate limit exceeded", _environment: marker });
      }

      const url = args.endpointUrl;
      const hostCheck =
        name === "talk_to_agent" && typeof url === "string" && url !== ""
          ? checkEndpointUrl(url, profile.endpointBaseUrl)
          : undefined;
      if (hostCheck && !hostCheck.ok) {
        logger.warn(`Tool call rejected by endpoint host guard: ${name}`, {
          environment: profile.name,
        });
        const endpointHost = hostOf(profile.endpointBaseUrl);
        const error =
          hostCheck.urlHost !== undefined
            ? `endpointUrl host "${hostCheck.urlHost}" does not match the endpoint host "${endpointHost}" of environment "${profile.name}". To use a custom endpoint host, declare it with COGNIGY_ENDPOINT_BASE_URL or the profile setting endpointBaseUrl.`
            : `endpointUrl must be an absolute http(s) URL matching the endpoint host "${endpointHost}" of environment "${profile.name}".`;
        return text({ error, _environment: marker }, true);
      }

      try {
        const result = await runtime.handlers.handleToolCall(name, args);
        notify(deps.onDispatched && (() => deps.onDispatched?.(marker)));
        return text({
          ...(isPlainObject(result) ? result : { result }),
          _environment: marker,
        });
      } catch (error) {
        const e = error as {
          message?: string;
          status?: unknown;
          code?: unknown;
          traceId?: unknown;
        };
        const redact = (v: unknown) =>
          typeof v === "string" ? redactKey(v, profile.apiKey) : v;
        const message = redactKey(String(e?.message ?? error), profile.apiKey);
        logger.error("Tool execution error", {
          tool: name,
          environment: profile.name,
          error: message,
        });
        return text(
          {
            error: message,
            status: redact(e?.status),
            code: redact(e?.code),
            traceId: redact(e?.traceId),
            _environment: marker,
          },
          true,
        );
      }
    });
  }

  return { listTools, callTool };
}
