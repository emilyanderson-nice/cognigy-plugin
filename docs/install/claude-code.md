# Install for Claude Code

Covers the **Claude Code CLI** and the **Claude Desktop "Code" tab** — since the April 2026 Desktop redesign both read `~/.claude`, so one install serves both. For Claude Desktop **chat**, see [claude-desktop.md](claude-desktop.md).

|                  |                                                                   |
| ---------------- | ----------------------------------------------------------------- |
| **You get**      | Tools, skills, and agents                                         |
| **Credentials**  | Claude Code's credential store (`claude plugin install --config`) |
| **Extra steps**  | None — one command                                                |
| **Auto-updates** | Off by default; one-time opt-in (see below)                       |

## Install

[Run the installer](../../README.md#installation) and pick **Claude Code**.

It adds the `emilyanderson-nice/cognigy-plugin` marketplace (registered as `cognigy-plugin-v2`), installs the plugin at user scope, and routes your API key into Claude Code's per-user credential store via `claude plugin install --config`. Restart Claude Code (or run `/reload-plugins`) and you're done. The installer also downloads the engine ahead of time, so the first session does not time out connecting; if that step fails it warns you and the install still succeeds (run `/mcp` and reconnect).

**No `claude` CLI on PATH?** The installer falls back to writing `~/.cognigy-plugin/config.json` (`chmod 600`) and prints the commands to finish by hand:

```
/plugin marketplace add emilyanderson-nice/cognigy-plugin
/plugin install cognigy@cognigy-plugin-v2
```

In the Claude Desktop **"Code"** tab there is no slash-command install — use the plugin browser instead: **+** near the prompt → **Plugins** → **Add plugin** → marketplace `emilyanderson-nice/cognigy-plugin`.

## Install for one project

Run the installer with `--project` from the project's root folder to declare the plugin in that project's `.claude/settings.json` instead of your user profile:

```
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup install --project
```

Your key is stored in Claude Code's per-user credential store, never in the project, so the settings file is safe to commit. Credentials are per user: every project on the machine sees the same set of Cognigy environments, and when more than one is configured the assistant names the environment on each request (see [multiple environments](multiple-environments.md)). The plugin declares its URL and key as required settings and Claude Code does not start the server until both are set, which is why the installer passes them even at project scope. See the [README](../../README.md#install-for-one-project-claude-code) for the full walkthrough.

## Turn on auto-updates

Claude Code leaves auto-update **off** for third-party marketplaces, so new releases won't reach you until you opt in once:

```
/plugin → Marketplaces → cognigy-plugin-v2 → enable auto-update
```

Without it, update manually with `/plugin update cognigy@cognigy-plugin-v2` or `cognigy-setup update`.

## Windows

A normal restart often isn't enough — the old process lingers and the plugin won't load:

1. **Fully quit** Claude Code: end every **Claude** process in **Task Manager** (closing the window can leave it running).
2. Reopen it.
3. If the tools, skills, and agents still don't appear, **restart your machine**.

## Uninstall

```
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup uninstall --client claude-code
```

Without `--client` it removes the plugin from every client. Add `--purge` to also delete `~/.cognigy-plugin` — that file holds the credentials **all** clients fall back to, so purging while others stay installed breaks them. By hand: `/plugin uninstall cognigy@cognigy-plugin-v2` then `/plugin marketplace remove cognigy-plugin-v2`. A project-scope install is removed from inside that project with `claude plugin uninstall cognigy@cognigy-plugin-v2 --scope project`.

## Troubleshooting

- **Tools missing in a brand-new session** — the first session downloads and builds the engine from GitHub, which can outlast Claude Code's 30-second connect timeout if the installer's pre-download did not complete. Run `/mcp` and reconnect, or restart; later sessions start quickly because npx caches the build.
- **Everything loads but calls fail with a credentials error** — re-run the installer; it rewrites the stored URL and key.
