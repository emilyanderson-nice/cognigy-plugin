/**
 * The one place this fork's identity lives (repo slug, marketplace name, plugin
 * id, engine spec). Upstream merges should never need to touch the installer
 * modules for a rename — only this file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FORK_REPO = "emilyanderson-nice/cognigy-plugin";
export const FORK_MARKETPLACE_NAME = "cognigy-plugin-v2";
export const FORK_PLUGIN_ID = `cognigy@${FORK_MARKETPLACE_NAME}`;

/**
 * npx flags every git-spec engine launch needs (twin of ENGINE_NPX_FLAGS in
 * scripts/fork-identity.mjs): npm 12 blocks git specs by default. As documented
 * in npm's configuration reference, `root` is meant to allow only the top-level
 * spec; observed: npm 12.2.0 booted the pinned engine with `root`, and the
 * engine has no git dependencies.
 */
export const ENGINE_NPX_FLAGS: readonly string[] = ["--allow-git=root"];

/** The one-command installer, as a user types it. */
export const SETUP_COMMAND = `npx ${ENGINE_NPX_FLAGS.join(" ")} -y -p github:${FORK_REPO} cognigy-setup`;

/** Our own version, from the package.json two levels above src/ and dist/. */
function packageVersion(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const file = join(dir, "..", "..", "package.json");
  try {
    return (JSON.parse(readFileSync(file, "utf-8")) as { version: string })
      .version;
  } catch (cause) {
    throw new Error(
      `Cannot determine the engine version: failed to read package.json at ${file}`,
      { cause },
    );
  }
}

/**
 * npm spec for the engine, pinned to this release's tag on the fork. Read
 * lazily so importing this module never touches the filesystem.
 */
export function getEngineSpec(): string {
  return `github:${FORK_REPO}#v${packageVersion()}`;
}
