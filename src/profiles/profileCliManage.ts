import {
  describeProfile,
  getProfile,
  hostOf,
  normalizeName,
  type Profile,
  type ProfileSet,
} from "./profiles.js";
import { ArgError, parseArgs, type ParsedArgs } from "./profileCliArgs.js";
import type { ProfileCliDeps } from "./profileCliTypes.js";

const EDITABLE: Profile["source"] = "file-profile";

function parse(
  sub: string,
  tokens: string[],
  deps: ProfileCliDeps,
  spec: { bool?: string[] },
): ParsedArgs | undefined {
  try {
    return parseArgs(sub, tokens, spec);
  } catch (e) {
    if (!(e instanceof ArgError)) throw e;
    deps.err(`${e.message}\n`);
    return undefined;
  }
}

const names = (set: ProfileSet): string =>
  set.profiles.map((p) => p.name).join(", ") || "none";

export function runList(tokens: string[], deps: ProfileCliDeps): number {
  const args = parse("list", tokens, deps, { bool: ["--json"] });
  if (!args) return 1;
  const set = deps.loadProfiles();
  if (args.flags.has("--json")) {
    deps.out(
      `${JSON.stringify({
        default: set.defaultName ?? null,
        profiles: set.profiles.map((p) => ({
          ...describeProfile(p),
          isDefault: p.name === set.defaultName,
          editable: p.source === EDITABLE,
        })),
        problems: set.problems,
      })}\n`,
    );
    return 0;
  }
  if (set.profiles.length === 0) {
    deps.out(
      "No environments are configured. Add one with: cognigy-setup profile add <name>\n",
    );
  }
  for (const p of set.profiles) {
    const d = describeProfile(p);
    deps.out(
      `${d.name}  ${d.apiHost}  ${d.source}${
        d.versionHint ? `  ${d.versionHint}` : ""
      }${p.name === set.defaultName ? "  (default)" : ""}${
        p.source === EDITABLE ? "  (editable)" : "  (read-only)"
      }\n`,
    );
  }
  if (set.problems.length > 0) {
    deps.out("Problems:\n");
    for (const pr of set.problems) deps.out(`  ${pr.name}: ${pr.reason}\n`);
  }
  return 0;
}

export function runShow(tokens: string[], deps: ProfileCliDeps): number {
  const args = parse("show", tokens, deps, {});
  if (!args) return 1;
  const set = deps.loadProfiles();
  let profile: Profile;
  try {
    profile = getProfile(set, args.positionals[0]);
  } catch (e) {
    deps.err(`${(e as Error).message}\n`);
    return 1;
  }
  const d = describeProfile(profile);
  deps.out(`Name: ${d.name}\n`);
  if (profile.name === set.defaultName) deps.out("Default: yes\n");
  deps.out(`Source: ${d.source}\n`);
  deps.out(`API host: ${d.apiHost}\n`);
  deps.out(`Endpoint host: ${d.endpointHost}\n`);
  deps.out(`Webchat host: ${hostOf(profile.webchatBaseUrl)}\n`);
  deps.out(`Static files host: ${hostOf(profile.staticFilesBaseUrl)}\n`);
  if (d.versionHint) deps.out(`Version hint: ${d.versionHint}\n`);
  deps.out(`API key: set (${profile.apiKey.length} characters)\n`);
  return 0;
}

/** The profile when it is a file profile; otherwise prints why not and undefined. */
function editableProfile(
  verb: string,
  name: string,
  deps: ProfileCliDeps,
): { profile?: Profile; code: number } {
  const set = deps.loadProfiles();
  const canonical = normalizeName(name);
  const profile = set.profiles.find((p) => p.name === canonical);
  if (!profile) {
    deps.err(`Unknown environment "${canonical}"; available: ${names(set)}.\n`);
    return { code: 1 };
  }
  if (profile.source !== EDITABLE) {
    deps.err(
      `Environment "${canonical}" comes from ${profile.source} (environment variables or the legacy settings), not from a saved profile, so it cannot be ${verb} here.` +
        (verb === "set as default"
          ? " Set COGNIGY_PROFILE to select it instead.\n"
          : " Change the variables where they are defined.\n"),
    );
    return { code: 1 };
  }
  return { profile, code: 0 };
}

export async function runRemove(
  tokens: string[],
  deps: ProfileCliDeps,
): Promise<number> {
  const args = parse("remove", tokens, deps, { bool: ["--yes"] });
  if (!args) return 1;
  if (args.positionals.length === 0) {
    deps.err("Usage: cognigy-setup profile remove <name> [--yes]\n");
    return 1;
  }
  const { profile, code } = editableProfile(
    "removed",
    args.positionals[0],
    deps,
  );
  if (!profile) return code;
  if (!args.flags.has("--yes")) {
    if (!deps.isTTY) {
      deps.err(
        "Removing a profile requires --yes when not run interactively.\n",
      );
      return 1;
    }
    const answer = (
      await deps.ask(`Remove environment '${profile.name}'? [y/N] `)
    )
      .trim()
      .toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      deps.out("Cancelled.\n");
      return 0;
    }
  }
  if (!deps.store.removeProfile(profile.name, { path: deps.configPath })) {
    deps.err(`Profile "${profile.name}" was not found in the config file.\n`);
    return 1;
  }
  deps.out(`Removed profile "${profile.name}".\n`);
  return 0;
}

export function runDefault(tokens: string[], deps: ProfileCliDeps): number {
  const args = parse("default", tokens, deps, { bool: ["--clear"] });
  if (!args) return 1;
  if (args.flags.has("--clear")) {
    deps.store.setDefaultProfile(undefined, { path: deps.configPath });
    deps.out("Cleared the default environment.\n");
    return 0;
  }
  if (args.positionals.length === 0) {
    deps.err("Usage: cognigy-setup profile default <name> | --clear\n");
    return 1;
  }
  const { profile, code } = editableProfile(
    "set as default",
    args.positionals[0],
    deps,
  );
  if (!profile) return code;
  deps.store.setDefaultProfile(profile.name, { path: deps.configPath });
  deps.out(`Default environment is now "${profile.name}".\n`);
  return 0;
}
