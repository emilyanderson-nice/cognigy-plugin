# Contributing

Contributions are welcome!

## Development Setup

```bash
git clone https://github.com/emilyanderson-nice/cognigy-plugin.git
cd cognigy-plugin
npm ci
npm run build
```

This repo is a fork of `pb-crackers/cognigy-plugin` (itself a fork of `Cognigy/cognigy-plugin`; see
[`MAINTAINING.md`](../MAINTAINING.md)). It is **not published to npm**: the plugin manifests pin the
engine to this repo at a git tag (`github:emilyanderson-nice/cognigy-plugin#v<version>`), which npm
builds through the `prepare` hook. The plugin and the engine share one version
(`<x.y.z>-pb.<n>`), stamped by `npm run version:fork` — see [Versions](#versions).

To test your changes (engine + skills + agents) from the working tree, run `npm run plugin:dev` —
it installs a generated dev plugin that runs `src/` directly via tsx (no build) with skills
symlinked; iterate with `/reload-plugins` and restore the published plugin with
`npm run plugin:dev:off`. Do **not** edit the tracked `plugin/.claude-plugin/plugin.json` for
testing — `npm run check:manifest` guards its published form in pre-commit and CI. See
[`TESTING.md` — Local Dev Loop](./TESTING.md#1-local-dev-loop-dev--the-fast-path) and
[Marketplace path](./TESTING.md#2-test-via-the-marketplace--plugin-end-user-path) for details.

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message **must** follow this format:

```
<type>(<optional scope>): <description>
```

### Allowed types

The repository keeps upstream's [semantic-release](https://semantic-release.gitbook.io/)
configuration (`.releaserc.json`), and the table below is the bump upstream's rules would derive
from each type. On this fork the `Release` workflow needs secrets the fork does not have and
fails harmlessly, so **the type does not cut a release here**; commit types still matter for
commitlint and the changelog. See [Versions](#versions) for how a release is actually made.

| Type       | When to use                              | Upstream's bump | Shows in changelog? |
| ---------- | ---------------------------------------- | --------------- | ------------------- |
| `feat`     | New feature or capability                | minor           | Yes                 |
| `fix`      | Bug fix                                  | patch           | Yes                 |
| `perf`     | Performance improvement                  | patch           | Yes                 |
| `revert`   | Reverts a previous commit                | patch           | Yes                 |
| `docs`     | Documentation only                       | patch           | Yes                 |
| `refactor` | Code restructuring (no feature/fix)      | patch           | Yes                 |
| `style`    | Formatting, whitespace (no logic change) | none            | No                  |
| `test`     | Adding or updating tests                 | none            | No                  |
| `build`    | Build system or dependency changes       | none            | No                  |
| `ci`       | CI/CD pipeline changes                   | none            | No                  |
| `chore`    | Maintenance tasks                        | none            | No                  |

A `!` (or a `BREAKING CHANGE:` footer) is a **major** bump under upstream's rules regardless of type.

### Versions

The version is `<upstream base>-pb.<n>` and is stamped **by hand with `npm run version:fork`**,
which sets it in `package.json` and the plugin manifests and rewrites the engine pin in the four
pin files. Never edit a `version` or an engine pin yourself; `npm run check:manifest` fails if
they disagree. The pin resolves only once the git tag `v<version>` exists on origin, so a release
includes tagging the pushed branch head (`npm run release:tag`) before the merge. The maintainer
makes that decision; the steps are in [`MAINTAINING.md`](../MAINTAINING.md#releasing-a-version).

### Examples

```bash
git commit -m "feat(tools): add manage_packages tool"
git commit -m "fix(llm): handle timeout on connection test"
git commit -m "chore: update dev dependencies"
git commit -m "docs(readme): update install instructions"
```

### Breaking changes

Add `!` after the type/scope for breaking changes:

```bash
git commit -m "feat(tools)!: rename manage_webchat to configure_webchat"
```

Commit messages are validated by **commitlint** in CI — PRs with non-conforming messages will
fail the check.

## Pull Request titles

PRs are **squash-merged**, and the squash commit message is the **PR title**. That single commit
is what lands on `main`. Therefore:

- **Your PR title must itself be a valid Conventional Commit** (same format and types as above).
- CI lints the PR title and re-runs the check whenever the title is edited. A non-conventional
  title fails the check and blocks the merge.

## Guidelines

Pull requests are validated with tests, a Prettier formatting check, and commitlint
on changed files. Prettier and commitlint are installed as project `devDependencies`,
so a separate global install is not required.

## Scripts

| Command                                | Description                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run build`                        | Clean `dist` and compile TypeScript                                                                                |
| `npm run dev`                          | Watch mode (tsx)                                                                                                   |
| `npm start`                            | Run the built server (`node dist/index.js`)                                                                        |
| `npm test`                             | Run test suite                                                                                                     |
| `npm run lint`                         | Run ESLint                                                                                                         |
| `npm run prettier:check -- <files...>` | Check formatting with Prettier for specific files                                                                  |
| `npm run prettier:write -- <files...>` | Format specific files with Prettier                                                                                |
| `npm run plugin:dev`                   | Install local dev plugin serving the working tree ([TESTING.md](./TESTING.md#1-local-dev-loop-dev--the-fast-path)) |
| `npm run plugin:dev:off`               | Remove the dev plugin, restore the published one                                                                   |
| `npm run check:manifest`               | Validate the tracked plugin manifests: engine pin, versions in sync, marketplace name (pre-commit/CI guard)        |
| `npm run version:fork`                 | Stamp the fork version and the engine pin in the manifests (see [Versions](#versions))                             |
| `npm run release:tag`                  | Dry-run the release tag; `-- --create --push` makes and pushes it (maintainer decision)                            |
| `npm run doctor`                       | Check that the plugin installed in Claude Code is this fork and that its engine boots                              |
| `npm run merge:resolve`                | Resolve the manifest/version conflicts of an upstream merge ([MAINTAINING.md](../MAINTAINING.md))                  |

## Submitting Changes

Open a pull request on [GitHub](https://github.com/emilyanderson-nice/cognigy-plugin). Issues and feature requests can be filed there too.
