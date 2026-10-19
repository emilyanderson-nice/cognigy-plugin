// npm `prepare` hook. Runs in two very different situations:
//
//  1. Local development (`npm install` in a clone) — install the husky hooks.
//  2. A git install (`npx -p github:<fork-repo>#v<version> cognigy-mcp`)
//     — npm clones this repo, installs devDependencies, and runs `prepare`.
//     There is no published tarball and therefore no `dist/`, so the TypeScript
//     has to be compiled here or the `cognigy-mcp` bin (dist/index.js) will not
//     exist and the MCP server fails to boot with -32000.
//
// Neither step may hard-fail the other: husky is absent/irrelevant in a git
// install (no .git in the extracted copy), and rebuilding on every local
// install would be wasted work when dist is already present.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const run = (command, args) =>
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: isWindows,
  });

// 1. Husky — only meaningful in a real working copy with hooks to install.
//
// Invoked through its installed binary, never `npx husky`. A nested npx
// inside an npx install deadlocks: `npx -p github:… cognigy-mcp` runs this
// hook, and the inner `npm exec` hangs indefinitely at 0% CPU, so the MCP
// server never starts and the client just sees a dead connection.
const huskyBin = join(repoRoot, "node_modules", ".bin", "husky");
if (existsSync(join(repoRoot, ".git")) && existsSync(huskyBin)) {
  try {
    run(huskyBin, []);
  } catch {
    // A working copy without husky available is fine; hooks are a dev nicety,
    // never a reason to fail an install.
  }
}

// 2. Build — required when this was installed straight from git.
if (!existsSync(join(repoRoot, "dist", "index.js"))) {
  console.error("[prepare] dist/ missing — building the engine from source");
  run("npm", ["run", "build"]);
}
