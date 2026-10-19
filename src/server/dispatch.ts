/**
 * Routes MCP tool calls to named Cognigy environments. Every tool gains an
 * optional `environment` argument; the registry resolves it, the call runs on
 * that profile's own handlers, and results carry an `_environment` marker.
 */
import {
  EnvironmentError,
  type EnvironmentRegistry,
} from "../environments/registry.js";
import { hostOf } from "../profiles/profiles.js";
import { redactKey } from "../utils/redact.js";
import { checkEndpointUrl } from "./hostGuard.js";

const RATE_LIMIT_KEY_LIST_ENVIRONMENTS = "__list_environments";

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

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { registry, logger } = deps;

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
          "Selects the Cognigy environment this call runs against. Required when more than one environment is configured; optional otherwise. Use list_environments to see the configured environments.",
        ...(names.length > 1 ? { enum: names } : {}),
      },
    };
    // `required` must mirror registry.resolve()'s ambiguity rule (more than one
    // configured name, broken ones included) so schema and runtime agree.
    if (names.length > 1) {
      const required = clone.inputSchema.required ?? [];
      clone.inputSchema.required = required.includes("environment")
        ? required
        : [...required, "environment"];
    }
    return clone;
  }

  function listTools(): ToolDefinition[] {
    const own = deps.listEnvironmentsTool.name;
    const { configuredNames } = registry.snapshot();
    return [
      ...deps.tools
        .filter((t) => t.name !== own)
        .map((t) => withEnvironmentProperty(t, configuredNames)),
      structuredClone(deps.listEnvironmentsTool),
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

    return deps.runWithTask(async () => {
      const ids = () => deps.taskContext?.() ?? {};
      let runtime;
      try {
        runtime = registry.resolve(environment);
      } catch (err) {
        logger.info(`Tool call received: ${name}`, {
          environment: undefined,
          ...ids(),
        });
        if (err instanceof EnvironmentError) {
          return text(
            {
              error: err.message,
              code: err.code,
              ...(err.environment !== undefined
                ? { environment: err.environment }
                : {}),
              available: err.available,
            },
            true,
          );
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
