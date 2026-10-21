---
name: environments
description: "Use when more than one Cognigy environment is configured, or the user mentions classic versus v4, staging, production, or switching between Cognigy environments — choosing the target environment, keeping it constant, and avoiding cross-environment mistakes."
---

# Working with more than one Cognigy environment

The plugin can be connected to several Cognigy environments at once (for example classic, v4, staging). Every tool accepts an `environment` argument that selects where the call runs.

## Choose the environment

1. Call `list_environments` first. It shows each environment's name, hosts, which one is the default, and any that are unusable. Pass `check: true` to also detect each platform release.
2. When more than one environment is configured, pass `environment` on every call except `list_environments` and `use_environment`, unless the session is pinned. A call without it is refused.
3. If the environment is ambiguous or unclear, ask the user which one they mean. Never guess between classic, v4 and staging.

The default marker (`isDefault`) in the `list_environments` output is not consent to use that environment: still ask or confirm with the user.

## Pin the session

- If the user names a tenant or profile, call `use_environment { name }` once at the start. Later calls then run there.
- A session can also be pinned at launch with `COGNIGY_ENVIRONMENT=<name>`, or by the Claude Code plugin setting "Default Cognigy profile" (source `plugin-settings`; `COGNIGY_ENVIRONMENT` overrides it). `list_environments` shows the pin (`pinned: true`) and where it came from.
- When the session is pinned, do not pass `environment` (or pass the pinned name). An explicit `environment` overrides the pin for that one call.
- Switch the pin only when the user asks, and say so. `use_environment { clear: true }` removes it.
- If the pinned environment is removed or broken, calls fail instead of going elsewhere. Tell the user; do not pick another one yourself.

## Keep it constant

- Carry the same environment through every step of a multi-step task that builds resources (agent creation, knowledge, tools, packages, snapshots, voice, webchat).
- Pick one environment per task and pass the same `environment` on every call in that task (or pin it once).
- Switch only when the user asks, and say so when you do.
- Every result carries an `_environment` marker; check that it matches the one you intended.

## Ids belong to one environment

- Project ids, agent ids, flow ids, endpoint ids and URLs, and package and snapshot references are valid only in the environment that produced them. Do not reuse one in another environment.
- To move something between environments, export it as a package from one and import it into the other with `manage_packages`, using each environment's own ids.

## Destructive operations

Before any destructive operation (delete, snapshot restore, overwrite) when more than one environment exists, confirm the target environment with the user, by name. Do this even when the session is pinned.
