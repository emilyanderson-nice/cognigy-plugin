# Multiple environments

One install can hold several Cognigy environments (for example a classic `api-trial-us` tenant and a newer `api-staging-v4` one), each with its own URL and API key, without one overriding the other.

> **How it works.** Every tool takes an optional `environment` argument that selects which environment the call runs against. With one environment configured nothing changes: the argument is optional and calls go to it. With two or more it is required on every call (except `list_environments` and `use_environment`), unless the session is pinned, and the server never guesses.

## Manage environments

```
cognigy-setup profile add v4-staging --api-base-url https://staging-v4.cognigy.ai --api-key-env MY_V4_KEY
cognigy-setup profile list
cognigy-setup profile test --all          # GET/release checks; unusable profiles also count as failures
cognigy-setup profile show v4-staging     # hosts and key length, never the key
cognigy-setup profile default v4-staging  # or: default --clear
cognigy-setup profile remove v4-staging --yes
```

Every subcommand has `--help`. Names are lower-case; `V4_Staging` is stored as `v4-staging`.

Give the key with the hidden prompt (default in a terminal), `--api-key-env VAR`, or `--api-key KEY`. The last one is stored in your shell history, so prefer the other two.

## Using several environments from the assistant

- Ask the assistant to run `list_environments` first. It shows each environment's name, host, source and default marker, and with `check: true` the detected platform release.
- After that every call carries `environment` (case and `_`/`-` do not matter: `V4_Staging` is `v4-staging`), and every answer says which environment served it in `_environment`.
- Instead of guessing, the server refuses: no `environment` with two or more configured (even when a default is set), an unknown name (it lists the available ones), a broken definition (it gives the reason), or no environment at all (it points at `cognigy-setup profile add`).
- Ids, endpoint URLs, package and snapshot references belong to one environment. `talk_to_agent` rejects an `endpointUrl` whose host is not the chosen environment's endpoint host.
- The rate limit (100 calls per minute by default; `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS`) is counted per environment. It used to be one shared counter.
- If the credentials file cannot be read (locked or corrupt), calls fail with an error instead of quietly falling back to fewer environments.
- Editing an environment's URL or key while the server runs takes effect on the next call. Per-session memory for that environment, such as "backup already offered", starts over.
- The server now starts even when no environment is configured: it logs a warning and answers each call with how to add one, instead of exiting at startup.
- Some clients cache the tool list, so the environment names in a tool's schema can be out of date. The name is always checked when the call arrives.

## Pin a session

Each assistant session runs its own server, so a session can be pinned to one environment. Calls without `environment` then go there.

- **At launch:** set `COGNIGY_ENVIRONMENT=<name>` in the server's environment. The name is matched like the `environment` argument (`V4_Staging` is `v4-staging`).
- **From the assistant:** `use_environment { name: "v4-staging" }` pins the session and returns the name and host (never the key). `use_environment { clear: true }` removes the pin.
- `list_environments` marks the pinned environment with `pinned: true` and shows `pin: { name, source }`, where `source` is `COGNIGY_ENVIRONMENT` or `use_environment`.
- An explicit `environment` argument still wins for that call. Every answer still carries `_environment`.
- Without a pin nothing changes: with two or more environments the argument is still required.
- If `COGNIGY_ENVIRONMENT` names an unknown or broken environment, the server still starts. It logs a warning, sets no pin, and calls that rely on the pin fail with the bad value and the available environments (`code: "pin_invalid"`). Fix it with `use_environment`, `use_environment { clear: true }`, or by passing `environment`.
- If the pinned environment is removed from the profiles or breaks later, calls fail. They are never sent to another environment.
- The assistant still confirms the environment by name before destructive operations (delete, snapshot restore, overwrite), even when pinned.

## Where environments come from

| Source               | How it is defined                                                                             | Editable with `profile` |
| -------------------- | --------------------------------------------------------------------------------------------- | ----------------------- |
| Environment variable | `COGNIGY_PROFILE_<NAME>_API_BASE_URL` and `_API_KEY` (underscores in `<NAME>` become hyphens) | no                      |
| Config file          | `profiles` in `~/.cognigy-plugin/config.json`, written by `profile add`                       | yes                     |
| Single environment   | `COGNIGY_API_BASE_URL` + `COGNIGY_API_KEY` (env or config file) becomes the profile `default` | no                      |

If the same name is defined twice, the environment-variable definition wins over the config file. A config-file profile named `default` replaces the legacy flat keys from the config file, but never `COGNIGY_API_*` environment variables; this also applies when only one of the URL or key is set in the environment and the other is read from the config file.

Optional per-profile settings: `_ENDPOINT_BASE_URL`, `_WEBCHAT_BASE_URL`, `_STATIC_FILES_BASE_URL` (derived from the API host when omitted) and `_PLATFORM_VERSION`, an informational hint only. The platform release is detected from the environment itself (`profile test` prints it); later releases will use it to choose behaviour.

## How the key file is protected

- Re-running any installer keeps your saved profiles. Earlier versions replaced the whole file.
- Writes are atomic and serialised by a lock file, and a corrupt file is backed up (`config.json.bak`, then `.bak.1` to `.bak.5`) before it is replaced.
- On Windows the file and its folder are restricted to your account with `icacls`; on macOS and Linux they use mode 0600 and 0700. If restriction fails you get a warning and the write still succeeds.
- Keys are never printed by any command, and are not in error messages.

## Troubleshooting

- **"Another process is updating the credentials file."** Retry. A lock left by a crashed process clears itself after 30 seconds.
- **"Default profile ... is not configured."** The saved default names a profile that no longer exists. Run `cognigy-setup profile default --clear`, or unset `COGNIGY_PROFILE`.
- **`FAIL ... HTTP 401`.** The key is wrong for that host (a key from one region does not work on another).
