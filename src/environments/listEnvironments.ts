/**
 * The `list_environments` tool: read-only, secret-free view of the configured
 * environments. With `check: true` it also reports each environment's detected
 * platform release (in parallel, each bounded by a timeout).
 */
import type { ToolDefinition } from "../server/dispatch.js";
import { describeProfile, type Profile } from "../profiles/profiles.js";
import type { ReleaseInfo } from "../profiles/release.js";
import type { EnvironmentRegistry } from "./registry.js";

export const LIST_ENVIRONMENTS_TOOL: ToolDefinition = {
  name: "list_environments",
  description:
    "List the configured Cognigy environments (name, hosts, default, problems). " +
    "Pass check: true to also detect each environment's platform release. " +
    "Read-only; never returns API keys.",
  inputSchema: {
    type: "object",
    properties: {
      check: {
        type: "boolean",
        description: "Also detect the platform release of each environment.",
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export interface ListEnvironmentsDeps {
  registry: EnvironmentRegistry;
  detectRelease(profile: Profile): Promise<ReleaseInfo>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

type ReleaseFields = { release?: string; releaseStatus: string };

const toFields = (info: ReleaseInfo): ReleaseFields =>
  info.release
    ? { release: info.release.raw, releaseStatus: "detected" }
    : { releaseStatus: "unknown" };

/** Never echoes a probe's error text: it may carry request details. */
async function detectWithTimeout(
  deps: ListEnvironmentsDeps,
  profile: Profile,
): Promise<ReleaseFields> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ReleaseFields>((resolve) => {
    timer = setTimeout(
      () => resolve({ releaseStatus: "timed out" }),
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  });
  const probe = (async (): Promise<ReleaseFields> => {
    try {
      return toFields(await deps.detectRelease(profile));
    } catch {
      return { releaseStatus: "unknown" };
    }
  })();
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createListEnvironments(
  deps: ListEnvironmentsDeps,
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (args) => {
    const snap = deps.registry.snapshot();
    const profiles = [...snap.profiles].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    const releases =
      args?.check === true
        ? await Promise.all(profiles.map((p) => detectWithTimeout(deps, p)))
        : [];
    return {
      environments: profiles.map((p, i) => ({
        ...describeProfile(p),
        editable: p.source === "file-profile",
        isDefault: p.name === snap.defaultName,
        ...(releases[i] ?? {}),
      })),
      problems: snap.problems,
      default: snap.defaultName ?? null,
      configured: snap.configuredNames.length,
      environmentArgumentRequired: snap.configuredNames.length >= 2,
      ...(snap.loadError !== undefined ? { loadError: snap.loadError } : {}),
    };
  };
}
