# Maintaining this fork

`emilyanderson-nice/cognigy-plugin` (this repo, `https://github.com/emilyanderson-nice/cognigy-plugin`) is a fork of [`pb-crackers/cognigy-plugin`](https://github.com/pb-crackers/cognigy-plugin), which is itself a fork of [`Cognigy/cognigy-plugin`](https://github.com/Cognigy/cognigy-plugin). It keeps the automatic error tracing and guards that the `pb-crackers` fork adds to every Cognigy Code Node the plugin writes, and adds multi-environment routing (see `docs/install/multiple-environments.md`).

```
Cognigy/cognigy-plugin  ->  pb-crackers/cognigy-plugin  ->  emilyanderson-nice/cognigy-plugin (this repo)
      (upstream)               (previous fork)                      (marketplace: cognigy-plugin-v2)
```

The local `upstream` remote currently points at `pb-crackers/cognigy-plugin`; `origin` is this fork.

## How this fork is distributed

Cognigy's upstream publishes its engine to npm as `@cognigy/plugin-engine` and its manifests pin the engine through an npm alias:

```
npx -y -p cognigy-engine@npm:@cognigy/plugin-engine@<version> cognigy-mcp
```

**This fork is not published to npm.** It is installed straight from GitHub. The plugin manifests pin the engine to a **git tag** on this repo:

```
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin#v<version> cognigy-mcp
```

`<version>` is the `version` in `package.json`, in the form `<x.y.z>-esc.<n>` (for example `v1.22.2-esc.1`). npm clones the repo at that tag, installs its dependencies, runs the `prepare` hook (`scripts/prepare.mjs`), which compiles `src/` to `dist/`, and then runs the `cognigy-mcp` bin. So the engine that runs **is this repo's source at that tag**.

Consequences worth knowing:

- **The pin resolves only once the tag `v<version>` exists on origin.** Manifests on `main` name a tag; until that tag is pushed, every install from `main` fails to start the engine. This is why the tag is created before the merge, never after (see [Releasing a version](#releasing-a-version)).
- **The spec no longer tracks the default branch.** It is frozen at a tag, so a push to `main` does not change what a client runs; only a new version (a new tag and new manifests) does. (Historical: before the tag pin, the spec was an unpinned `github:` spec that followed `main`.)
- **The first cold start is slower than an npm install**: a clone, a dependency install and a TypeScript build, measured at about 2 minutes (110-150 s over three runs, 13 s warm). npx caches by spec, so a given version should be fast after its first start; a new version is a new spec and pays the cold start once per machine. (These figures were measured on 2026-10-20 with the tag pin on npm 12.2.0, Windows; other machines and networks will differ.)

### Versions

The fork's version is `<upstream base>-esc.<n>`; the current value is the `version` in `package.json`. The base names the upstream release this is built on; the suffix keeps the number distinct from upstream's, which is the second half of the cache collision described below.

`-pb.<n>` is the legacy form: it stays valid for existing tags and history, but nothing generates it any more.

`npm run version:fork` stamps it: no argument bumps the suffix (`-esc.1` becomes `-esc.2`; a legacy `-pb.<n>` restarts at `-esc.1`), an upstream version rebases onto it (`npm run version:fork 1.20.0` becomes `1.20.0-esc.1`; `npm run version:fork 1.22.2` becomes `1.22.2-esc.1`), and `npm run version:fork 1.20.0 3` sets both. It rewrites the `version` in `package.json` and the plugin manifests that carry one, **and** the engine pin in the four files that carry a pin:

- `plugin/.claude-plugin/plugin.json`
- `plugin/mcp.json`
- `plugin/.codex-plugin/mcp.json`
- `plugin/.cursor-plugin/plugin.json`

The merge resolver (`node scripts/resolve-upstream-merge.mjs`) calls it for you during a merge. `npm run check:manifest` fails if `package.json` is not a fork version, if any manifest pin differs from `github:emilyanderson-nice/cognigy-plugin#v<package.json version>`, if a manifest version differs from `package.json`, or if the marketplace name is not the fork's. It therefore also rejects the npm alias form. Never hand-bump versions in any file: use `version:fork`.

The `Release` GitHub workflow (`.github/workflows/release.yml`) and `.releaserc.json` are upstream's semantic-release setup. On this fork the workflow needs secrets the fork does not have, so it fails harmlessly; the fork versions by hand with `version:fork`. `.releaserc.json` has been adjusted so that, were it ever to run, it would not publish to npm (`@semantic-release/npm` with `npmPublish: false`). If the workflow is ever made to succeed, semantic-release would compute its own number; `check:manifest` is what catches a non-fork version.

### Why this fork's marketplace is named apart from upstream's

`.claude-plugin/marketplace.json` names this marketplace **`cognigy-plugin-v2`** (plugin id `cognigy@cognigy-plugin-v2`), not upstream's `cognigy-plugin` and not the previous fork's `cognigy-plugin-pb`. That is load-bearing, not cosmetic.

Claude Code caches a plugin at `<marketplace>/<plugin>/<version>`. While the fork and upstream both used the marketplace name `cognigy-plugin` and the fork had merged upstream to the same version number, that path was identical for two different repositories. A stale upstream entry left in the cache was then served under the fork's install:

- right marketplace name
- right version number
- plugin enabled, no error anywhere
- and the **stock engine** running, with none of the fork's behaviour

Nothing in the repo could detect it, because nothing in the repo was wrong. `npm run check:manifest` enforces the name so an upstream merge cannot quietly restore the collision. A distinct marketplace name plus a distinct version form (`-esc.<n>`) is what keeps the cache keys apart.

### Check what is actually installed

```bash
npm run doctor
```

Reports the registered marketplaces, which plugin is enabled, the engine spec in every cached manifest, whether credentials resolve, and, the one that matters most, whether the engine **actually starts and serves the fork's tools**. The boot check runs `npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin#v<package.json version> cognigy-mcp`, so it needs the tag to exist on origin. Exits non-zero if Claude Code is running anything other than this fork. Pass `--no-boot` to skip the boot check when offline. `npm run plugin:dev:off` runs it automatically, since switching back is when the wrong plugin tends to get left behind.

It flags, among other things:

- **required plugin config not set**: the manifest's env block expands `${user_config.*}` and both options are declared required, so Claude Code refuses to start the server without them. The engine can be entirely healthy and the client still never launches it. This is what "2 userConfig options not yet set" after `claude plugin install` means; it is not a warning you can skip.
- upstream's marketplace (`Cognigy/cognigy-plugin`) being registered alongside the fork's (that is how the wrong plugin gets installed)
- the previous fork's marketplace (`pb-crackers/cognigy-plugin`, registered as `cognigy-plugin-pb`) being registered
- a cached manifest under the fork's marketplace pinning the npm engine (the stale-cache failure above)
- the fork registered under a name other than `cognigy-plugin-v2`

To recover from a poisoned cache:

```bash
claude plugin uninstall cognigy@cognigy-plugin-v2
rm -rf ~/.claude/plugins/cache/cognigy-plugin-v2
claude plugin marketplace remove cognigy-plugin-v2
claude plugin marketplace add emilyanderson-nice/cognigy-plugin
claude plugin install cognigy@cognigy-plugin-v2
```

Then `/reload-plugins` in Claude Code. (`rm -rf` is shown for a POSIX shell; on Windows PowerShell use `Remove-Item -Recurse -Force`.)

### Never nest npx in an install-time script

The plugin installs from git, so npm runs `prepare`, and everything it calls, **inside** an npx install. A nested `npx` or `npm exec` there deadlocks: the inner process parks at 0% CPU forever, the TypeScript build never finishes, `dist/index.js` is never written, the `cognigy-mcp` bin does not exist, and the MCP server simply never appears. No error, no log.

This happened: `build` used `npx tsc` and `prepare.mjs` used `npx husky`. Both now call the local binaries; npm already puts `node_modules/.bin` on PATH for lifecycle scripts, so the nesting bought nothing. `installScripts.test.ts` fails if `npx` reappears in either.

It is nasty to diagnose because it only reproduces on a **cold npx cache** (the first boot of a version, a cleared cache, a new machine). Checking with `npm install github:...` does not reproduce it either: that path is not nested under npx.

### Boot times

|                                         |                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Cold (no npx cache for the pinned spec) | about 2 minutes (110-150 s measured with the tag pin, npm 12.2.0, Windows): clone, install, TypeScript build |
| Warm                                    | about 13 s (measured, same setup)                                                                            |

The figures in the table were measured on 2026-10-20 with the tag pin on npm 12.2.0, Windows. The cold path runs close to a client's MCP startup timeout, so after a release run `npm run doctor`: it boots the engine end to end, which both verifies the pin and leaves the npx cache warm for the next client start.

### The trap to watch for

If an upstream merge restores the npm pin in any manifest, the plugin silently runs **Cognigy's stock engine** instead of this fork: no error, the error tracing just quietly stops happening. `scripts/check-plugin-manifest.mjs` fails the build if that happens (it requires the exact `github:emilyanderson-nice/cognigy-plugin#v<version>` args), `scripts/sync-plugin-version.mjs` aborts if it sees `@cognigy/plugin-engine@`, and the resolver script rewrites alias and previous-fork specs back to this fork's spec. Do not "fix" a failure by relaxing the check.

## Fork identity

The fork's identity (repo slug, marketplace name, plugin id, engine pin form) lives in exactly two files, and everything else imports them:

| File                          | Used by             | Exports                                                                                                                                                                                                                                |
| ----------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/install/forkIdentity.ts` | TypeScript (`src/`) | `FORK_REPO`, `FORK_MARKETPLACE_NAME`, `FORK_PLUGIN_ID`, `ENGINE_NPX_FLAGS`, `SETUP_COMMAND`, `getEngineSpec()` (reads `package.json` lazily and returns `github:<repo>#v<version>`)                                                    |
| `scripts/fork-identity.mjs`   | `scripts/*.mjs`     | `FORK_REPO`, `FORK_MARKETPLACE_NAME`, `UPSTREAM_REPO`, `LEGACY_FORK_REPO`, `LEGACY_MARKETPLACE_NAME`, `FORK_ENGINE_SPEC`, `ENGINE_NPX_FLAGS`, `engineLaunchArgs(version)`, `enginePin(version)`, `replaceForkSpec`, `replaceEnginePin` |

The two files must agree; `forkIdentity.test.ts` and `forkIdentityScripts.test.ts` pin the same repo slug, marketplace name and pin form in each. A rename or move of the fork is a change to these two files (plus the manifests, which `version:fork` re-stamps), not a hunt across the codebase. Guard tests keep the literals out of everything else:

- `noUpstreamIdentityInSrc.test.ts`: no `Cognigy/cognigy-plugin`, `pb-crackers` or fork-owner literal in `src/` outside `forkIdentity.ts`; the `@cognigy/plugin-engine` literal only in the Desktop/Antigravity install paths.
- `scriptsIdentityGuard.test.ts`: no `scripts/*.mjs` other than `fork-identity.mjs` contains the identity literals.

**Metadata that intentionally stays upstream's.** The package name `@cognigy/plugin-engine`, and the `repository` field in `package.json` and in the plugin manifests (`https://github.com/Cognigy/cognigy-plugin`; also `author` and `homepage`), are left as upstream has them so merges stay clean. They are descriptive only: nothing resolves the engine from them (the pin does that), and nothing should be "corrected" to the fork's slug without weighing the cost in merge conflicts.

## Releasing a version

There is no automated release on this fork. Never publish or tag without the maintainer's explicit approval.

1. **Stamp and push the branch.** Run `npm run version:fork` (optionally with the upstream base, e.g. `npm run version:fork 1.23.0`). That sets the version and the four pins. Run `npm run check:manifest`, commit, and push the PR branch.
2. **Tag the pushed head.** Dry run first:

   ```bash
   npm run release:tag
   ```

   It prints the tag and target commit, lists any problems, and changes nothing. Then, **only with the maintainer's explicit decision**, on the **pushed** branch head:

   ```bash
   npm run release:tag -- --create --push
   ```

   `--create` makes an annotated tag `v<version>` at `HEAD`; `--push` pushes only that one tag (`refs/tags/v<version>`, never `--tags` and never a branch). `--push` alone pushes an existing local tag. The script refuses (non-zero exit) when: the working tree is dirty, the tag already exists locally or on origin, any of the four pin files does not carry this version's pin (run `version:fork`), the version is not a `<x.y.z>-esc.<n>` fork version (legacy `-pb.<n>` also passes), `HEAD` is not contained in an `origin/*` branch (judged from the last fetch), origin's tags cannot be read, or, for `--push` alone, the local tag does not point at `HEAD`.

   **The tag is created before the merge, never after.** Until the tag exists on origin, every install from `main` fails to start the engine.

3. **Verify the pin resolves.** Run `npm run doctor`, or boot the pin directly: `npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin#v<version> cognigy-mcp` (it should start and wait for MCP traffic on stdio).
4. **Merge** the PR on GitHub.

## Taking updates from upstream

Nothing arrives automatically. Pull when you want to.

**Do not use the GitHub Releases API to decide whether you are behind.** A repo's published releases can lag its actual version (this was observed on Cognigy's repo: `releases/latest` reported v1.15.1 while `main` was already on 1.19.0). Compare the `version` field in `package.json` on each repo's `main` instead.

```bash
git fetch upstream
git merge upstream/main     # conflicts are expected: see below
node scripts/resolve-upstream-merge.mjs   # resolves the manifest/version boilerplate
# resolve any remaining SOURCE conflicts by hand
npm test && npm run check:manifest && npm run build
git commit                  # complete the merge
```

Run the script directly, not through `npm run merge:resolve`: while the merge leaves `package.json` with conflict markers, npm cannot start and exits with EJSONPARSE. The npm script name is only a convenience for when `package.json` parses.

Then follow [Releasing a version](#releasing-a-version) (branch, PR, tag, merge); do not push merge results straight to `main`.

The resolver script (`node scripts/resolve-upstream-merge.mjs`) handles the conflicts that are identical every time: the plugin manifests, `package.json`, `package-lock.json`, `.claude-plugin/marketplace.json`. For the manifests it takes the incoming side, normalises every engine spec form it can meet (the npm alias, the previous fork's `github:` spec, this fork's pinned spec) to this fork's unpinned `github:emilyanderson-nice/cognigy-plugin`, and then re-stamps the fork version onto the incoming base with `version:fork <base> 1`, which re-applies the tag pin. For `.claude-plugin/marketplace.json` it keeps **our** side (marketplace identity is the fork's) and warns if it did. It deliberately refuses to touch source conflicts: those need judgement, and quietly picking a side is how a merge loses a feature. A manifest that still holds a conflict marker or no longer parses as JSON is left untouched and reported.

The rules live in `scripts/merge-resolution.mjs`; `resolve-upstream-merge.mjs` applies them to the files git reports as conflicted.

The `upstream` remote is already configured. If it is ever missing:

```bash
git remote add upstream https://github.com/pb-crackers/cognigy-plugin.git
```

To merge from Cognigy's repository directly, add it as a further remote (`https://github.com/Cognigy/cognigy-plugin.git`) and merge from that; the resolver script handles both sources (see its header comment).

### Where conflicts will happen

| File                                                                   | Risk              | Notes                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/errorTrace.ts`                                              | None              | Fork-only file. Upstream will never touch it.                                                                                                                                                                                                                               |
| `src/install/forkIdentity.ts`, `scripts/fork-identity.mjs`             | None              | Fork-only files holding the fork's identity (see [Fork identity](#fork-identity)).                                                                                                                                                                                          |
| `src/tools/handlers.ts`                                                | **High**          | Upstream's busiest file and very large. The fork adds small hunks: the wrap-on-create/update hooks, `createErrorGuard`, `createWrappedCodeNode`, and the http-tool pre/post-process call sites.                                                                             |
| `src/tools/definitions.ts`                                             | Medium            | `errorTrace` / `errorGuard` / `errorHandlerFlowId` in the `manage_flow_nodes` input schema.                                                                                                                                                                                 |
| `src/tools/nodeRegistry.ts`                                            | Low               | The `executeFlow` entry.                                                                                                                                                                                                                                                    |
| `src/schemas/tools.ts`                                                 | Low               | The three Zod fields.                                                                                                                                                                                                                                                       |
| `plugin/*/plugin.json`, `plugin/*/mcp.json`, `package.json`            | **Every release** | Upstream bumps the version and restores the npm alias pin. The resolver script takes their version, restores the fork's `github:` spec and re-stamps `-esc.<n>`.                                                                                                            |
| `.claude-plugin/marketplace.json`                                      | Medium            | The marketplace name must stay `cognigy-plugin-v2`; the resolver script keeps our side and `check:manifest` enforces it.                                                                                                                                                    |
| `scripts/check-plugin-manifest.mjs`, `scripts/sync-plugin-version.mjs` | Medium            | Both derive the expected engine spec from `scripts/fork-identity.mjs` (`enginePin`) instead of hardcoding it; keep that import when upstream's version of the file comes in.                                                                                                |
| `.releaserc.json`                                                      | Low               | The fork's file keeps `@semantic-release/npm` with `npmPublish: false` and a `prepareCmd` that only runs `sync-plugin-version.mjs`. Re-check against upstream's version on each merge (`@semantic-release/git` assets must list the manifests that carry a version or pin). |
| `plugin/skills/flow-nodes/SKILL.md`                                    | Low               | The error-handling section under `### code`.                                                                                                                                                                                                                                |

Deliberately kept small: almost all the error-tracing logic lives in `errorTrace.ts`, which cannot conflict. The call sites in `handlers.ts` are a few lines each.

### Historical: resolutions from the 1.15.1 to 1.19.0 merge

Recorded as a worked example from the `pb-crackers` era; the engine-spec details below describe the unpinned `github:` form that was current then, not today's tag pin. Seven conflicts, all of them predicted by the table above:

| Conflict                | Resolution                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The four manifests      | Took upstream's `version` (1.19.0), kept the fork's `github:` engine spec.                                                                                    |
| `.releaserc.json`       | Upstream deleted `scripts/build-gemini-extension.mjs`, so the fork's `prepareCmd` referenced a missing file. Took upstream's shape minus `npm publish`.       |
| `src/schemas/tools.ts`  | Upstream reshaped `createToolSchema` (added `flowId`/`parentNodeId` plus refines). Took their structure and re-added `errorGuard` to both tool config blocks. |
| `src/tools/handlers.ts` | One conflict. Upstream added a code-node runtime-API hint that returns early; the fork's wrap + guard must run first. Both kept, fork's block first.          |

Upstream's new hint analyses `data.config.code` (the author's code, not the wrapped form), so the envelope's own `api.*` calls are not flagged. Keep it that way if that code moves.

Upstream's new hint test asserted `api.post` was called exactly once, which the fork's guard node breaks. It now counts posts of `type: "code"` instead. Prefer that shape over raw call counts: the node chain grows, and positional or count-based assertions fail for the wrong reason when it does.

Rehearsed against a simulated upstream 1.20.0 at the time: seven conflicts, all of them manifest boilerplate, all resolved by the resolver script, with upstream's change to `src/tools/handlers.ts` merging cleanly on its own and every fork feature intact.

### After any merge, check these three things

1. `npm run check:manifest`: every engine pin is `github:emilyanderson-nice/cognigy-plugin#v<version>` (not the npm alias, not unpinned), the versions match `package.json`, and the marketplace name is `cognigy-plugin-v2`.
2. `npm test`: the `errorTrace` and `errorGuard` suites, and the identity guard tests, still pass.
3. A real code node still comes out wrapped. Fastest check:
   ```bash
   npm run plugin:dev     # then /reload-plugins
   ```
   Create a code node and confirm the saved code contains `/* cognigy-plugin:error-trace:v1 */` and that an `Error Guard:` node follows it.

## What the fork changes

See `plugin/skills/flow-nodes/SKILL.md` (the `### code` section) for the full contract. In short:

- Every code node written through `manage_flow_nodes`, and every http-tool pre/post-process node, is wrapped in a try/catch. An uncaught throw in a Code Node otherwise **stops flow execution**: the turn ends with an empty response and nothing is logged, and neither `hasError` (transpile only) nor `input.codeNodeError` (timeouts only) covers it.
- The trace lands in `context.errors`, `context.lastError`, `input.errorTrace` and the project logs, and sets `input.hasError`.
- `flowId` / `nodeId` are baked in as literals because a Code Node has no runtime accessor for them. That is why creating one is a two-pass operation: POST the node, then PATCH the code with the real id.
- An `if {{input.hasError}}` guard follows each code node as a branch point. Its then-branch is empty by design: the catch block already logged, and what the caller experiences belongs to the flow that failed.
- `executeFlow` is registered as a node type; upstream does not expose it.

## Local development

```bash
npm install
npm run plugin:dev      # Claude Code runs this working tree via tsx; /reload-plugins to iterate
npm run doctor          # confirm the INSTALLED plugin is this fork, not upstream
npm run plugin:dev:off  # restore the GitHub-installed plugin (marketplace emilyanderson-nice/cognigy-plugin)
```

Credentials come from `~/.cognigy-plugin/config.json` (`COGNIGY_API_BASE_URL`, `COGNIGY_API_KEY`, mode 0600) when the env vars are unset, so `plugin:dev` does not need the key re-entered each time it reinstalls the plugin.
