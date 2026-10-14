# Multiple environments

One install can hold several Cognigy environments (for example a classic `api-trial-us` tenant and a newer `api-staging-v4` one), each with its own URL and API key, without one overriding the other.

> **Status.** This release adds the storage and the `cognigy-setup profile` commands. Choosing an environment per tool call arrives in a later release; until then the engine keeps using the single environment it uses today (`COGNIGY_API_BASE_URL` + `COGNIGY_API_KEY`).

## Manage environments

```
cognigy-setup profile add v4-staging --api-base-url https://staging-v4.cognigy.ai --api-key-env MY_V4_KEY
cognigy-setup profile list
cognigy-setup profile test --all          # GET check + detected platform release, per environment
cognigy-setup profile show v4-staging     # hosts and key length, never the key
cognigy-setup profile default v4-staging  # or: default --clear
cognigy-setup profile remove v4-staging --yes
```

Every subcommand has `--help`. Names are lower-case; `V4_Staging` is stored as `v4-staging`.

Give the key with the hidden prompt (default in a terminal), `--api-key-env VAR`, or `--api-key KEY`. The last one is stored in your shell history, so prefer the other two.

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
