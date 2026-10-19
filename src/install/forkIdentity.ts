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
