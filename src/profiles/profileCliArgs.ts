/** Minimal argument parsing for `profile <subcommand>`; never prints values. */

export interface FlagSpec {
  /** Flags that take a value (`--flag value` or `--flag=value`). */
  value?: readonly string[];
  /** Boolean flags. */
  bool?: readonly string[];
}

export interface ParsedArgs {
  positionals: string[];
  values: Record<string, string>;
  flags: Set<string>;
}

export class ArgError extends Error {
  override name = "ArgError";
}

/** Throws ArgError (messages never quote a flag's value) on bad input. */
export function parseArgs(
  subcommand: string,
  tokens: string[],
  spec: FlagSpec,
): ParsedArgs {
  const valueFlags = new Set(spec.value ?? []);
  const boolFlags = new Set(spec.bool ?? []);
  const out: ParsedArgs = { positionals: [], values: {}, flags: new Set() };
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      out.positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (seen.has(flag)) {
      throw new ArgError(
        `Flag ${flag} for "profile ${subcommand}" was given more than once.`,
      );
    }
    seen.add(flag);
    if (valueFlags.has(flag)) {
      if (eq !== -1) {
        out.values[flag] = token.slice(eq + 1);
      } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        out.values[flag] = tokens[++i];
      } else {
        throw new ArgError(
          `Flag ${flag} for "profile ${subcommand}" needs a value.`,
        );
      }
    } else if (boolFlags.has(flag) && eq === -1) {
      out.flags.add(flag);
    } else {
      throw new ArgError(`Unknown flag ${flag} for "profile ${subcommand}".`);
    }
  }
  if (out.positionals.length > 1) {
    throw new ArgError(
      `"profile ${subcommand}" takes at most one name; got ${out.positionals.length}.`,
    );
  }
  return out;
}
