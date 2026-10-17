---
name: environments
description: "Use when more than one Cognigy environment is configured, or the user mentions classic versus v4, staging, production, or switching between Cognigy environments — choosing the target environment, keeping it constant, and avoiding cross-environment mistakes."
---

# Working with more than one Cognigy environment

The plugin can be connected to several Cognigy environments at once (for example classic, v4, staging). Every tool accepts an `environment` argument that selects where the call runs.

## Choose the environment

1. Call `list_environments` first. It shows each environment's name, hosts, which one is the default, and any that are unusable. Pass `check: true` to also detect each platform release.
2. When more than one environment is configured, pass `environment` on every call except `list_environments`. A call without it is refused.
3. If the environment is ambiguous or unclear, ask the user which one they mean. Never guess between classic, v4 and staging.

The default marker (`isDefault`) in the `list_environments` output is not consent to use that environment: still ask or confirm with the user.

## Keep it constant

- Carry the same environment through every step of a multi-step task that builds resources (agent creation, knowledge, tools, packages, snapshots, voice, webchat).
- Pick one environment per task and pass the same `environment` on every call in that task.
- Switch only when the user asks, and say so when you do.
- Every result carries an `_environment` marker; check that it matches the one you intended.

## Ids belong to one environment

- Project ids, agent ids, flow ids, endpoint ids and URLs, and package and snapshot references are valid only in the environment that produced them. Do not reuse one in another environment.
- To move something between environments, export it as a package from one and import it into the other with `manage_packages`, using each environment's own ids.

## Destructive operations

Before any destructive operation (delete, snapshot restore, overwrite) when more than one environment exists, confirm the target environment with the user, by name.
