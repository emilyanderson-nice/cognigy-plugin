# NiCE Cognigy Plugin

> Distributed exclusively through each client's native plugin mechanism — a **plugin** on **Claude Code**, **Claude Desktop**, **ChatGPT + Codex**, and **Antigravity**, a **plugin** on **Cursor**, and an [**Agent Plugins**](https://agent-plugins.org)-standard plugin on any conformant host (**Kiro**, **VS Code + Copilot**, …) — with more clients to come. Each package installs the server engine and ships skills + agents.

A plugin that connects your AI assistant to the [Cognigy.AI](https://www.cognigy.com) REST API. Create, test, and improve LLM-based AI Agents through a self-improvement loop — without leaving your client.

**Quick links:** [Installation](#installation) · [Install for one project](#install-for-one-project-claude-code) · [Add another environment](#add-another-environment) · [Staying up to date](#staying-up-to-date)

## Features

- **20 workflow tools** (including `list_environments`, for working with several Cognigy environments at once) for flow building, agent creation, deployment, packaging, backup, voice setup, and agent-to-agent (A2A) delegation
- **Flow building without an agent**: create standalone Flows (shared subroutines, error handlers, classic Node dialogs) and chain nodes onto them directly
- **One-call agent setup**: creates Agent + Flow + AI Agent Job Node + REST Endpoint automatically
- **Self-improvement loop**: talk to your agent, evaluate responses, update the job description, repeat
- **Knowledge store support**: attach RAG knowledge stores to agents as tools
- **Browser voice deployment**: create Voice Gateway endpoints with WebRTC demo URLs
- **Voice preview setup**: configure supported speech providers for voice experiences
- **Skills + agents**: workflow guidance auto-loads as skills in supporting clients; build/go-live loops run as subagents
- **Built-in docs lookup**: bundles the official [Cognigy documentation](https://docs.cognigy.com) MCP server — your assistant searches and reads the docs before answering platform questions, instead of guessing from training data
- Built-in rate limiting, Zod input validation, and RFC 7807 error responses

## Installation

**Two steps.** Step 1 is the same for every client. Step 2 is where you check what your client still needs from you — for most clients that's nothing, but the answer is in the table, so look your client up rather than assuming.

### Step 1 — run the installer

One installer covers every client. Run it, pick your client(s), enter your Cognigy API base URL (Enter for the trial default) and API key (masked as you type), then restart the client.

You need [Node.js 20+](https://nodejs.org) and `git` on your PATH. This is a fork of the NiCE Cognigy plugin that installs straight from GitHub (it is not published to npm), so run the installer from this repository:

```
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup
```

The first run downloads and builds the engine, which takes about 2 minutes on a cold start (measured 110-150 s); later runs use npm's cache (about 13 s warm).

> **Do not use** the upstream `install.sh` / `install.ps1` one-liners or `npx -p @cognigy/plugin-engine@latest …` — they install Cognigy's published engine, which does not contain this fork's changes.

### Install for one project (Claude Code)

To add the plugin to a single project instead of your whole user profile, run this from the **project's root folder**, in a terminal:

```
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup install --project
```

It asks for your Cognigy API base URL and API key (the key is hidden as you type). It then:

1. Declares the marketplace and enables the plugin in the project's `.claude/settings.json`.
2. Stores your key in Claude Code's own per-user credential store (and in `~/.cognigy-plugin/config.json`) — **never in the project**, so `.claude/settings.json` is safe to commit.
3. Downloads the engine ahead of time so the first session does not time out connecting.

Then restart Claude Code (or run `/reload-plugins`) and check with `/mcp`. Claude Code may ask you to trust the project's settings the first time it opens the project.

`--project` works with Claude Code only. Run it again at any time to change the URL or key.

Things to know:

- **Credentials are per user, not per project.** Every project on the same machine sees the same set of Cognigy environments. When more than one is configured, the assistant names the environment on each request instead — see [Add another environment](#add-another-environment).
- **Teammates:** commit `.claude/settings.json`. Each person still runs the command above once, because their own key lives on their own machine.

**Asking Claude to do it.** In a fresh VS Code window with Claude Code open on your project, paste:

```
Install the Cognigy plugin for this project. Do not ask me for my API key in
chat. Tell me to run this in the terminal at the project root, where it asks for
the URL and key privately:
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup install --project
Then tell me to restart Claude Code and check /mcp.
```

### Step 2 — check your client's row

The installer wires your credentials everywhere and installs the plugin wherever it can, but some clients need one manual step from you. Find your client below and do what **Extra step after the installer** says — **None** means step 1 finished the job. Each guide has the full instructions, Windows notes, how to verify it worked, and troubleshooting.

Cursor is the one client that needs no installer at all: it collects your credentials itself, so you can start at its guide and skip step 1.

| Client                                                                    | Tools | Skills | Agents | Extra step after the installer           | Auto-updates             |
| ------------------------------------------------------------------------- | ----- | ------ | ------ | ---------------------------------------- | ------------------------ |
| **[Claude Code](docs/install/claude-code.md)** (CLI + Desktop "Code" tab) | ✅    | ✅     | ✅     | None                                     | Enable once <sup>1</sup> |
| **[Claude Desktop chat](docs/install/claude-desktop.md)**                 | ✅    | ✅     | ✅     | Install the plugin in-app                | Automatic                |
| **[ChatGPT + Codex](docs/install/chatgpt-codex.md)** (CLI + IDE)          | ✅    | ✅     | —      | None                                     | Automatic                |
| **[Antigravity](docs/install/antigravity.md)** (IDE + `agy` CLI)          | ✅    | ✅     | ✅     | None                                     | Automatic                |
| **[Cursor](docs/install/cursor.md)**                                      | ✅    | ✅     | ✅     | Install + set two variables <sup>2</sup> | Managed by Cursor        |
| **[Other hosts](docs/install/other-hosts.md)** (VS Code, Kiro, …)         | ✅    | ✅     | ✅     | Install the plugin in the host itself    | Manual <sup>3</sup>      |

<sup>1</sup> Claude Code leaves auto-update off for third-party marketplaces — turn it on once under `/plugin → Marketplaces → cognigy-plugin`.
<sup>2</sup> Cursor asks for the credentials itself (Plugins → Configure), so it doesn't need the installer — see its guide.
<sup>3</sup> The host owns the plugin version.

> **Which clients run this fork's engine.** Claude Code, ChatGPT + Codex and Cursor load the plugin from this repository's manifests, which pin this fork's engine, so they get this fork's changes. The installer paths for **Claude Desktop chat** and **Antigravity** still fetch Cognigy's published engine from npm instead — they work, but without this fork's changes, and the installer says so when you pick them. Giving them a fork engine source is planned work.

<details>
<summary>Scripting / CI</summary>

Skip the prompts with flags:

```
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup \
  --client claude-code --client claude-desktop --client codex \
  --client antigravity --client other-hosts \
  --api-base-url https://api-trial.cognigy.ai --api-key <key>
```

`--client` is repeatable; valid values are `claude-code`, `claude-desktop`, `codex`, `antigravity`, and `other-hosts`. Omit it in interactive mode to pick from the menu. `--project` replaces `--client` and installs Claude Code for the current project only (see above).

</details>

### Troubleshooting the first start

**`EALLOWGIT` from npm.** npm 12 refuses `github:` specs by default (its `allow-git` setting). This is an npm security default, not a plugin bug. The engine is installed from GitHub, so it needs the flag `--allow-git=root`, which, as documented in npm's configuration documentation for `allow-git`, allows only the git spec you name on the command line (and git dependencies defined in the project's own `package.json`), not git dependencies of dependencies (the engine has none). Observed on Windows, checked 2026-10-20: on npm 12.2.0, `--allow-git=root` started the pinned engine (20 tools); npm 10.9.9 and 11.21.1 accepted the flag without error. Every command in this README and the plugin manifests already pass `--allow-git=root` as the first `npx` argument, and older npm (10 and 11) accepts it silently. If you see `EALLOWGIT`, you are running a command without the flag.

**The first connection times out.** A first start downloads and builds the engine, which can take about 2 minutes, while Claude Code waits only 30 s for an MCP server to connect. The installer pre-warms npm's cache to avoid this. If you added the plugin without the installer, wait for the first start to finish, then run `/mcp` and reconnect.

## Staying up to date

See the **Auto-updates** column in the table above for what each client does on its own. To pull a new release now instead of waiting for the client to notice:

```
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup update
```

The installer doubles as a manager:

```
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup status      # what's installed, per client
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup update      # pull the latest where it isn't automatic
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup uninstall   # remove from every client (--client narrows it; --purge also clears ~/.cognigy-plugin)
npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup profile list # manage several Cognigy environments, see "Add another environment" below
```

Beyond the MCP tools, the plugin ships **skills** and **agents** that surface the workflows automatically:

- **Skills** (`/skills`) — one per workflow (agent creation, knowledge/RAG, voice gateway, voice go-live checklist, webchat, flow nodes, packages, settings, LLM providers, tools, red-teaming, troubleshooting). Claude loads the matching skill automatically when your request fits. Red-teaming runs in your main session — not as a subagent — so it can agree the scope contract, get approval before applying fixes, and open the finished report for you.
- **Agents** (`/agents`) — `cognigy-agent-builder` runs the full build-and-test loop for a new agent, and `cognigy-voice-go-live` audits a voice agent against the Go-Live Checklist and applies the safe fixes. Each runs in its own context and reports back a summary.

## Configuration

The [installer](#installation) collects your **Cognigy API base URL** and **API key** and wires them per client: on Claude Code into Claude Code's own per-user **credential store**, on Claude Desktop into `claude_desktop_config.json` (`chmod 600`). The engine receives them as environment variables. If either is missing for a given launch, the engine falls back to `~/.cognigy-plugin/config.json` (`chmod 600`), which the installer also writes — so credentials resolve from the environment first, then that file. ChatGPT + Codex, Antigravity, and other hosts rely on that file exclusively: their client configs carry no secrets.

A value that arrives as an unexpanded `${...}` placeholder counts as missing. Hosts other than Claude Code don't implement `userConfig` and pass the manifest's `${user_config.cognigy_api_key}` through literally; treating that as a real credential would both fail the request and shadow the file fallback. The optional variables below can be set in the MCP server `env` if you need to override defaults.

| Variable                            | Required | Default | Description                                                    |
| ----------------------------------- | -------- | ------- | -------------------------------------------------------------- |
| `COGNIGY_API_BASE_URL`              | Yes      | —       | Your Cognigy API base URL                                      |
| `COGNIGY_API_KEY`                   | Yes      | —       | Your Cognigy API key                                           |
| `LOG_LEVEL`                         | No       | `info`  | `debug`, `info`, `warn`, `error`                               |
| `RATE_LIMIT_MAX_REQUESTS`           | No       | `100`   | Max requests per window                                        |
| `RATE_LIMIT_WINDOW_MS`              | No       | `60000` | Rate limit window in ms                                        |
| `COGNIGY_DISABLE_AUDIT_ATTRIBUTION` | No       | unset   | Set to `1` to stop naming the plugin in Cognigy's audit events |
| `HTTPS_PROXY` / `HTTP_PROXY`        | No       | unset   | Corporate proxy to tunnel Cognigy requests through             |
| `NO_PROXY`                          | No       | unset   | Comma-separated hosts to reach directly, bypassing the proxy   |
| `NODE_EXTRA_CA_CERTS`               | No       | unset   | Path to your corporate root CA, for TLS-inspecting proxies     |
| `COGNIGY_PROXY_CONNECT_TIMEOUT_MS`  | No       | `30000` | Deadline for reaching the proxy and completing the tunnel      |
| `COGNIGY_ENDPOINT_BASE_URL`         | No       | derived | Endpoint host, when it cannot be derived from the API host     |
| `COGNIGY_WEBCHAT_BASE_URL`          | No       | derived | Webchat host, when it cannot be derived from the API host      |
| `COGNIGY_STATIC_FILES_BASE_URL`     | No       | derived | Static-files host, when it cannot be derived from the API host |

### Add another environment

You can keep several Cognigy environments on one machine — for example a classic trial tenant and a newer one — each with its own URL and key. Every command below is shown without its prefix; run each as `npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup <command>`.

> **How the assistant uses them.** Every tool takes an optional `environment` argument. With one environment configured nothing changes. With two or more it is **required** on every call (except `list_environments`), the tool schemas mark it required, and the server never guesses: a call without it, or with an unknown name, is refused with the list of available environments. Every answer says which environment served it (`_environment`). Ask the assistant to run `list_environments` first, and to confirm the environment by name before anything destructive.

1. **Add it.** Pick a short lower-case name and give the base URL:

   ```
   profile add v4-staging --api-base-url https://staging-v4.cognigy.ai --api-key-env MY_V4_KEY
   ```

   The key comes from a hidden prompt (the default in a terminal), from the environment variable named by `--api-key-env`, or from `--api-key KEY` — avoid the last one, it lands in your shell history.

2. **Check what you have.**

   ```
   profile list
   profile test --all        # read-only checks; a profile that cannot be used counts as a failure
   profile show v4-staging   # hosts and key length, never the key
   ```

3. **Optionally mark a default.** `list_environments` shows it, but with two or more environments the assistant must still name the environment on every call, and it is told not to treat the marker as consent.

   ```
   profile default v4-staging    # or: profile default --clear
   ```

4. **Use it.** Ask in plain words, for example:

   ```
   List my Cognigy environments, then list the projects in v4-staging.
   ```

5. **Remove one you no longer need.**

   ```
   profile remove v4-staging --yes
   ```

Profiles live in `~/.cognigy-plugin/config.json` (readable only by you). Re-running the installer keeps them. You can also define them with `COGNIGY_PROFILE_<NAME>_API_BASE_URL` and `_API_KEY` environment variables. See [docs/install/multiple-environments.md](docs/install/multiple-environments.md) for the details, file protection and troubleshooting.

### Audit attribution

Everything this plugin changes is recorded in **Admin Center → Audit Events** with `performedBy.actor = "mcp-plugin"`, so plugin-made changes are distinguishable from ones people made by hand (which carry no `performedBy`). Each MCP tool call gets its own `taskId` and each engine run its own `sessionId`, so the writes of one tool call group together.

Requires Cognigy.AI 2026.17.0 or newer; older versions ignore the attribution and record the action normally. The "Performed by" column in the UI is gated behind the platform's `FEATURE_ENABLE_PLATFORM_AGENT_MFE` flag, but the attribution is always recorded and always readable through `list_resources { resourceType: "audit_event", actor: ["mcp-plugin"] }`.

Set `COGNIGY_DISABLE_AUDIT_ATTRIBUTION=1` to opt out; plugin actions are then recorded like any other API action.

### Corporate proxies

If your network requires a proxy, set it in the MCP server `env` block (or export it before starting your client) and the plugin tunnels every Cognigy request through it:

```json
"env": {
  "HTTPS_PROXY": "http://proxy.corp.example:8080",
  "NO_PROXY": "localhost,127.0.0.1",
  "NODE_EXTRA_CA_CERTS": "/etc/ssl/certs/corporate-root-ca.pem"
}
```

Lower-case spellings (`https_proxy`) work too, as do credentials in the URL (`http://user:password@proxy.corp.example:8080`). HTTP and HTTPS proxies are supported; SOCKS proxies are not.

The proxy is chosen per request, so `NO_PROXY` can exclude one host while another still goes through the proxy — a package download link, for example, points at wherever the platform staged the archive rather than at the API host.

If a proxy is configured but cannot be used — a malformed URL, or a SOCKS proxy — requests **fail with a configuration error** rather than quietly connecting directly, which would send your API key outside the sanctioned path. Exclude the host with `NO_PROXY` if you genuinely want a direct connection.

A proxy that accepts the connection and then never completes the tunnel would otherwise hang a tool call indefinitely, so connecting and negotiating is bounded at 30 seconds. Raise `COGNIGY_PROXY_CONNECT_TIMEOUT_MS` if your proxy is simply slow.

**If your proxy inspects TLS** (Zscaler, Netskope, BlueCoat and similar), it presents its own certificate signed by a corporate root CA that Node does not trust by default. Point `NODE_EXTRA_CA_CERTS` at that CA file — Node reads it only at startup, so restart your client afterwards. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0` instead; that disables certificate verification for every connection the engine makes.

To confirm the engine picked the settings up, set `LOG_LEVEL=debug` and look for `Cognigy API requests route through a proxy` in your client's MCP log. GUI clients (Claude Desktop, Antigravity) start the engine with a minimal environment and often do not inherit your shell's proxy variables, so set them in the config file rather than your shell profile.

### Self-hosted and local clusters

The engine talks to more than one Cognigy host: the API for everything, the endpoint host for `talk_to_agent`, and the webchat and static hosts for embed snippets. The other three are derived from `COGNIGY_API_BASE_URL` by swapping its `api` segment — `api-dev.cognigy.ai` gives `endpoint-dev.cognigy.ai`, `cognigy-api-na1.nicecxone.com` gives `cognigy-endpoint-na1.nicecxone.com`, and a local cluster's `api.test` gives `endpoint.test`. If your hostnames follow no such pattern, set `COGNIGY_ENDPOINT_BASE_URL`, `COGNIGY_WEBCHAT_BASE_URL` and `COGNIGY_STATIC_FILES_BASE_URL` explicitly; the engine warns at startup (`Could not derive the endpoint host`) when it had to fall back to the API host.

A cluster that serves a self-signed certificate is rejected with `DEPTH_ZERO_SELF_SIGNED_CERT`, because Node does not consult the operating-system trust store. Point `NODE_EXTRA_CA_CERTS` at the certificate (or the local CA that issued it), exactly as for a TLS-inspecting proxy above.

## Usage Examples

### 1. Create a customer support agent

```
Create a Cognigy AI Agent called "Support Bot" in project <projectId> with a helpful
customer support persona. If the project has no working LLM, first look for another
project with an llm_model that has a connectionId, import that LLM and its connection
via manage_packages, and only fall back to setup_llm if no reusable LLM exists.
Return the endpoint URL only after the project has a confirmed working LLM.
```

The MCP server should first check whether the target project already has a working LLM. If not, it should prefer reusing the required LLM resource set plus its connection resources from another project via `manage_packages`, and only use `setup_llm` as the last resort before calling `create_ai_agent`.

### 2. Test and improve the agent

```
Talk to my Support Bot at <endpointUrl> and ask "How do I reset my password?".
Then update the job description to make the response more concise and actionable.
Talk to it again and compare the responses.
```

This triggers the self-improvement loop: `talk_to_agent` → evaluate → `update_ai_agent` → `talk_to_agent` again.

### 3. Add a knowledge store for RAG

```
Create a knowledge store in project <projectId>, add the URL
https://docs.example.com/faq as a source, then attach it to my Support Bot
so the agent can search it when answering questions.
```

The server will call `manage_knowledge` to create the store and ingest the URL,
then `create_tool` to attach it as a knowledge search tool on the agent's job
node.

If the project will use Knowledge Search, the server should first configure
Knowledge AI Settings with `manage_settings { operation: 'set_knowledge_ai',
... }` using model IDs from the same project.

For normal AI-agent knowledge flows, this should happen before
`manage_knowledge { operation: 'create_store', ... }`.

The model roles are different:

- The knowledge store itself needs an embedding-capable model for the index.
- `knowledgeSearchModelId` is a separate Knowledge AI setting for search
  behavior, but the accepted model type is instance-dependent.
- If reusing another project's knowledge setup, identify the exact source-project
  Knowledge Search model first and import it into the target project before the
  first `set_knowledge_ai` attempt.
- Import the full required knowledge model set in one pass. If the embedding
  model, Knowledge Search model, and agent model share one connection, transfer
  that single connection once alongside all of those models.
- After importing LLMs into the target project, enumerate the target
  project's `llm_model` resources and try those same-project IDs before
  creating a new model.
- For Knowledge Search specifically, use `list_resources` with
  `resourceType: 'llm_model'` and `useCase: 'knowledgeSearch'` so the
  candidates match the Settings UI dropdown rather than the unfiltered
  project-wide LLM list.
- Do not substitute a fresh or generic model for `knowledgeSearchModelId`
  unless the user explicitly asks for that and existing same-project candidates
  have already failed API validation.
- If the exact source-project Knowledge Search model is missing from the target
  project, import it before trying a different model.
- If all same-project candidates fail, report the exact attempted model IDs
  and API errors rather than claiming a platform-side bug.
- Do not describe an untried model as "likely" unsupported or rejected.
- Treat model names in examples as examples only, not as the source of truth.

### 4. List all projects and agents

```
List all my Cognigy projects and show which AI Agents exist in each one.
```

Uses `list_resources` with `resourceType: 'project'` and `resourceType: 'agent'`.

### 5. Import a package into a project

```
Upload the package at /absolute/path/to/support-bot.zip into project <projectId>,
show me the import preview, then import it using the default selections.
```

Uses `manage_packages` with `operation: 'upload_and_inspect'`, then `operation: 'import'`.

### 6. Export a package from project resources

```
Create a package named "support-bot" from these resource IDs in project <projectId>,
include dependencies, and save the zip to /absolute/path/to/exports/.
```

Uses `manage_packages` with `operation: 'list_exportable'` to discover candidates, then `operation: 'export'`, then `operation: 'download'` when needed.

### 7. Configure voice preview and create a browser voice endpoint

```
Set the voice preview provider for project <projectId> to Microsoft, then create
a Voice Gateway endpoint for flow <flowId> named "Support Voice" and give me the
WebRTC demo URL I can open in the browser.
```

This uses `manage_settings` with `operation: 'set_voice_preview'` to configure speech, then `manage_voice_gateway` to provision a `voiceGateway2` endpoint with a `webrtcDemoUrl`.

### 8. Configure Knowledge AI settings for search

```
Configure Knowledge AI settings for project <projectId> by setting the Knowledge Search
model and the Content Parser. If I am creating a new project and another project already
has a working knowledge setup, reproduce that exact Knowledge Search model and Content
Parser choice in the new project before trying generic defaults.
```

This uses `manage_settings` with `operation: 'set_knowledge_ai'` to configure
`knowledgeSearch` and `contentParser` at the project-settings level. Reusing
settings does not mean copying another project's settings alone; the required
model must exist in the target project first, either by import or by creating it there.
For knowledge workflows, the MCP should import the full required source-project model set
in one pass, reuse shared connections only once, and try the imported same-project model
IDs before falling back to `setup_llm`.

## Tools

| Tool                   | Type  | Description                                                                                                    |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| `create_ai_agent`      | Write | Create a complete AI Agent with auto-provisioned flow, job node, and REST endpoint                             |
| `update_ai_agent`      | Write | Update persona, guardrails, job config (role, procedures, LLM, temperature)                                    |
| `setup_llm`            | Write | Create an LLM resource (GPT-4, Claude, Mistral, etc.) with automatic connection validation                     |
| `talk_to_agent`        | Write | Send a message to an AI Agent and get its response (uses Endpoint Test Mode, so it is not counted as billable) |
| `list_resources`       | Read  | List projects, agents, flows, endpoints, LLMs, knowledge stores, and more                                      |
| `get_resource`         | Read  | Get detailed information about a single resource                                                               |
| `delete_resource`      | Write | Permanently delete a resource                                                                                  |
| `manage_knowledge`     | Write | Create knowledge stores, add sources (URL, text, file), list chunks for RAG                                    |
| `create_tool`          | Write | Add a tool (HTTP, knowledge, email, MCP, A2A) to an agent's job node                                           |
| `update_tool`          | Write | Update an existing tool node's configuration                                                                   |
| `manage_webchat`       | Write | Create or configure a Webchat v3 endpoint for website deployment                                               |
| `manage_flow_nodes`    | Write | Create, update, delete, or list flow nodes for conversation logic                                              |
| `manage_packages`      | Write | List exportable resources, upload, inspect, import, export, and download Cognigy package zip files             |
| `manage_voice_gateway` | Write | Create or configure a Voice Gateway endpoint with WebRTC for browser-based voice interaction                   |
| `manage_a2a_server`    | Write | Deploy a Flow as an A2A (Agent2Agent) server endpoint that other agents can discover and call                  |
| `manage_settings`      | Write | Manage project-level settings including voice preview and Knowledge AI configuration                           |
| `audit_voice_agent`    | Write | Audit a voice agent against the Go-Live Checklist; reports by default, applies safe fixes on demand            |
| `manage_snapshots`     | Write | Create and restore project Snapshots so agent changes can be rolled back                                       |

Detailed workflow guidance (agent creation, knowledge/RAG, voice, webchat, A2A, flow nodes, packages, settings, LLM providers, tools, troubleshooting) ships as **skills** that load automatically when your request matches, in clients that support them (e.g. Claude Code) — see the **Skills** column in the client table under [Installation](#installation).

## Security

- API keys are passed via environment variables and never logged
- All inputs are validated using Zod schemas before reaching the API
- Rate limiting is built in to prevent API abuse

## Privacy Policy

This MCP server transmits requests to the Cognigy.AI API endpoint configured via `COGNIGY_API_BASE_URL`. No data is collected, stored, or shared by this MCP server itself — all data remains between your AI client and your Cognigy.AI instance.

Full privacy policy: [https://www.cognigy.com/privacy-policy](https://www.cognigy.com/privacy-policy)

## Support

- **Issues**: [GitHub Issues](https://github.com/emilyanderson-nice/cognigy-plugin/issues)
- **Documentation**: see [`docs/`](https://github.com/emilyanderson-nice/cognigy-plugin/tree/main/docs) folder

## Documentation

- [docs/install/](https://github.com/emilyanderson-nice/cognigy-plugin/tree/main/docs/install) — per-client install guides ([Claude Code](docs/install/claude-code.md), [Claude Desktop](docs/install/claude-desktop.md), [ChatGPT + Codex](docs/install/chatgpt-codex.md), [Antigravity](docs/install/antigravity.md), [Cursor](docs/install/cursor.md), [other hosts](docs/install/other-hosts.md))
- [docs/ARCHITECTURE.md](https://github.com/emilyanderson-nice/cognigy-plugin/blob/main/docs/ARCHITECTURE.md) — tool design, self-improvement loop, ID formats
- [docs/USAGE.md](https://github.com/emilyanderson-nice/cognigy-plugin/blob/main/docs/USAGE.md) — detailed usage reference
- [docs/TESTING.md](https://github.com/emilyanderson-nice/cognigy-plugin/blob/main/docs/TESTING.md) — how to test the plugin and a local engine build
- [docs/CONTRIBUTING.md](https://github.com/emilyanderson-nice/cognigy-plugin/blob/main/docs/CONTRIBUTING.md) — development setup and contribution guide

## License

[MIT](LICENSE)
