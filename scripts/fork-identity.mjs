// The single definition of this fork's identity for the release/check scripts.
// Anything that needs the repo, the marketplace name or the engine pin imports
// it from here, so an upstream merge or a rename has exactly one place to fix.

export const FORK_REPO = "emilyanderson-nice/cognigy-plugin";
export const FORK_MARKETPLACE_NAME = "cognigy-plugin-v2";
export const UPSTREAM_REPO = "Cognigy/cognigy-plugin";
// The previous fork's identity; its pin form is still recognised so that a
// merge which reintroduces it is rewritten rather than left behind.
export const LEGACY_FORK_REPO = "pb-crackers/cognigy-plugin";
export const LEGACY_MARKETPLACE_NAME = "cognigy-plugin-pb";

/** The fork's engine spec with no version pin (what a merge resolves to before stamping). */
export const FORK_ENGINE_SPEC = `github:${FORK_REPO}`;

/** The npx engine spec for a release: the fork's GitHub repo at tag v<version>. */
export function enginePin(version) {
  return `github:${FORK_REPO}#v${version}`;
}

/** The suffix every newly stamped fork version carries: <base>-esc.<n>. */
export const FORK_VERSION_SUFFIX = "esc";
/** Older suffixes, still valid for reading (existing tags, history), never generated. */
export const LEGACY_VERSION_SUFFIXES = ["pb"];

/** A fork version: <upstream base>-(esc|pb).<n>, digits only. */
export const FORK_VERSION_RE = new RegExp(
  `^\\d+\\.\\d+\\.\\d+-(?:${[FORK_VERSION_SUFFIX, ...LEGACY_VERSION_SUFFIXES].join("|")})\\.\\d+$`,
);

// npm 12 refuses git specs by default (EALLOWGIT). As documented in npm's
// configuration reference, `root` is meant to allow only the top-level spec
// passed on the command line, not git dependencies of dependencies. Observed:
// npm 12.2.0 booted the pinned engine with `root`; the engine has no git
// dependencies. It must be the FIRST npx argument.
export const ENGINE_NPX_FLAGS = ["--allow-git=root"];

/** The full npx argument list that launches the engine for a release. */
export function engineLaunchArgs(version) {
  return [...ENGINE_NPX_FLAGS, "-y", "-p", enginePin(version), "cognigy-mcp"];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A github: spec for this fork or the previous fork, with an optional #v<tag>.
// Cognigy's own repo (UPSTREAM_REPO) is deliberately not matched.
const PIN_RE = new RegExp(
  `github:(?:${escapeRe(FORK_REPO)}|${escapeRe(LEGACY_FORK_REPO)})(?![\\w-])(?:#v[0-9A-Za-z.+-]*)?`,
  "g",
);

/** Rewrite every fork / previous-fork github spec in `text` to `spec`. */
export function replaceForkSpec(text, spec) {
  return text.replace(PIN_RE, () => spec);
}

/** Rewrite every fork / previous-fork github spec in `text` to the pin for `version`. */
export function replaceEnginePin(text, version) {
  return replaceForkSpec(text, enginePin(version));
}
