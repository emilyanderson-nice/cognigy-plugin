/**
 * Routes tool calls to named Cognigy environments. Profiles are re-read on
 * every call; runtimes (client + handlers) are built lazily and cached per
 * profile. The registry never guesses which environment was meant.
 */
import {
  normalizeName,
  type Profile,
  type ProfileSet,
} from "../profiles/profiles.js";

export interface EnvironmentRuntime {
  profile: Profile;
  client: unknown;
  handlers: {
    handleToolCall(
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown>;
  };
}

export interface RegistryDeps {
  loadProfiles(): ProfileSet;
  createRuntime(profile: Profile): EnvironmentRuntime;
}

export type EnvironmentErrorCode = "none" | "unknown" | "broken" | "ambiguous";

export class EnvironmentError extends Error {
  override name = "EnvironmentError";
  readonly code: EnvironmentErrorCode;
  readonly environment?: string;
  readonly available: string[];

  constructor(
    code: EnvironmentErrorCode,
    message: string,
    available: string[],
    environment?: string,
  ) {
    super(message);
    this.code = code;
    this.available = available;
    if (environment !== undefined) this.environment = environment;
  }
}

export interface EnvironmentSnapshot {
  profiles: Profile[];
  problems: { name: string; reason: string }[];
  defaultName: string | undefined;
  configuredNames: string[];
  loadError?: string;
}

export interface EnvironmentRegistry {
  snapshot(): EnvironmentSnapshot;
  resolve(name?: string): EnvironmentRuntime;
}

const cacheKey = (p: Profile): string =>
  JSON.stringify([
    p.apiBaseUrl,
    p.apiKey,
    p.endpointBaseUrl,
    p.webchatBaseUrl,
    p.staticFilesBaseUrl,
  ]);

export function createEnvironmentRegistry(
  deps: RegistryDeps,
): EnvironmentRegistry {
  const cache = new Map<string, { key: string; runtime: EnvironmentRuntime }>();

  function load(): ProfileSet & { loadError?: string } {
    try {
      return deps.loadProfiles();
    } catch (err) {
      return {
        profiles: [],
        problems: [],
        defaultName: undefined,
        loadError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function snapshot(): EnvironmentSnapshot {
    const set = load();
    return {
      profiles: set.profiles,
      problems: set.problems.map((p) => ({ name: p.name, reason: p.reason })),
      defaultName: set.defaultName,
      configuredNames: [
        ...new Set([
          ...set.profiles.map((p) => p.name),
          ...set.problems.map((p) => p.name),
        ]),
      ].sort(),
      ...(set.loadError !== undefined ? { loadError: set.loadError } : {}),
    };
  }

  function resolve(name?: string): EnvironmentRuntime {
    const snap = snapshot();
    const available = snap.configuredNames;
    const list = available.join(", ");
    const wanted =
      name === undefined || name.trim() === ""
        ? undefined
        : normalizeName(name.trim());

    if (snap.loadError !== undefined) {
      throw new EnvironmentError(
        "broken",
        `Environment configuration could not be loaded: ${snap.loadError}. Fix or remove the configuration file; setup keeps a backup of the previous one as config.json.bak.`,
        available,
        wanted,
      );
    }
    if (wanted === undefined) {
      if (available.length === 0) {
        throw new EnvironmentError(
          "none",
          'No environment is configured. Run "cognigy-setup profile add" to add one.',
          available,
        );
      }
      if (available.length > 1) {
        throw new EnvironmentError(
          "ambiguous",
          `Pass an environment name; available environments: ${list}.` +
            (snap.profiles.some(
              (p) =>
                p.name === "default" &&
                (p.source === "legacy-env" || p.source === "legacy-file"),
            )
              ? ' "default" is your original COGNIGY_API_* setup.'
              : ""),
          available,
        );
      }
    }

    for (const cached of cache.keys()) {
      if (!snap.profiles.some((p) => p.name === cached)) cache.delete(cached);
    }

    // Exactly one configured environment (usable or not) is the only candidate.
    const target = wanted ?? available[0];
    const broken = snap.problems.find((p) => p.name === target);
    if (broken) {
      throw new EnvironmentError(
        "broken",
        `Environment "${target}" is unusable: ${broken.reason}`,
        available,
        target,
      );
    }
    const profile = snap.profiles.find((p) => p.name === target);
    if (!profile) {
      throw new EnvironmentError(
        "unknown",
        `Unknown environment "${target}"; available environments: ${list}.`,
        available,
        target,
      );
    }

    const key = cacheKey(profile);
    const hit = cache.get(profile.name);
    if (hit && hit.key === key) return hit.runtime;

    let runtime: EnvironmentRuntime;
    try {
      runtime = deps.createRuntime(profile);
    } catch {
      throw new EnvironmentError(
        "broken",
        `Environment "${profile.name}" could not be initialised.`,
        available,
        profile.name,
      );
    }
    cache.set(profile.name, { key, runtime });
    return runtime;
  }

  return { snapshot, resolve };
}
