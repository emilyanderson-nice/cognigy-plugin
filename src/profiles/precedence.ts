/**
 * Source precedence for named profiles. Every definition of a name (usable or
 * not) is recorded with its source; the highest-precedence source then decides
 * the outcome: its profile is active, or, when it is unusable, the name has no
 * active profile and only that source's problems are reported.
 */
import type { Profile, ProfileSource } from "./profiles.js";
import type { ProfileProblem } from "./profilesFile.js";

/** Higher wins: env-profile > legacy-env > file-profile > legacy-file. */
const RANK: Record<ProfileSource, number> = {
  "env-profile": 4,
  "legacy-env": 3,
  "file-profile": 2,
  "legacy-file": 1,
};

/** One configured definition of a profile name: a built profile or a reason. */
export type Definition = { name: string; source: ProfileSource } & (
  | { profile: Profile; reason?: undefined }
  | { profile?: undefined; reason: string }
);

/** Applies precedence per name; problems keep the plain `ProfileProblem` shape. */
export function resolveDefinitions(definitions: Definition[]): {
  profiles: Map<string, Profile>;
  problems: ProfileProblem[];
} {
  const byName = new Map<string, Definition[]>();
  for (const def of definitions) {
    byName.set(def.name, [...(byName.get(def.name) ?? []), def]);
  }
  const profiles = new Map<string, Profile>();
  const problems: ProfileProblem[] = [];
  for (const [name, defs] of byName) {
    const top = Math.max(...defs.map((d) => RANK[d.source]));
    const winners = defs.filter((d) => RANK[d.source] === top);
    const failures = winners.filter((d) => d.reason !== undefined);
    const usable = winners.find((d) => d.profile !== undefined);
    if (usable?.profile && failures.length === 0) {
      profiles.set(name, usable.profile);
    }
    for (const f of failures) problems.push({ name, reason: f.reason ?? "" });
  }
  return { profiles, problems };
}
