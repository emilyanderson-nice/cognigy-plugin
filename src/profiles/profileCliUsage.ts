/** Help texts for `profile` and each of its subcommands. */

export const SUBCOMMAND_USAGE: Record<string, string> = {
  add: [
    "Usage: cognigy-setup profile add <name> [flags]",
    "",
    "  --api-base-url <url>          API base URL (prompted when interactive)",
    "  --api-key-env <VAR>           read the API key from environment variable VAR",
    "  --api-key <key>               API key (can end up in shell history; prefer --api-key-env)",
    "  --endpoint-base-url <url>     endpoint base URL (derived when omitted)",
    "  --webchat-base-url <url>      webchat base URL (derived when omitted)",
    "  --static-files-base-url <url> static files base URL (derived when omitted)",
    "  --version-hint <text>         platform version hint, e.g. 2026.21",
    "  --force                       replace an existing or shadowed profile",
    "  --no-test                     skip the connection check after saving",
    "  --default                     make this the default environment",
    "",
  ].join("\n"),
  list: "Usage: cognigy-setup profile list [--json]\n\n  --json    print one JSON document (hosts only, never keys)\n",
  show: "Usage: cognigy-setup profile show [name]\n\nPrints hosts, source, version hint and the key length only.\n",
  remove:
    "Usage: cognigy-setup profile remove <name> [--yes]\n\n  --yes     do not ask for confirmation\n",
  default:
    "Usage: cognigy-setup profile default <name> | --clear\n\n  --clear   remove the saved default\n",
  test: "Usage: cognigy-setup profile test [name] [--all]\n\n  --all     test every environment, in name order\n",
};

export function profileUsage(): string {
  return [
    "Usage: cognigy-setup profile <subcommand>",
    "",
    "  add <name>      Save an environment (--api-base-url, --api-key-env, --default, --force, --no-test)",
    "  list [--json]   List environments",
    "  show [name]     Show one environment (hosts only; the key is never printed)",
    "  remove <name>   Remove a saved environment (--yes to skip the prompt)",
    "  default <name>  Set the default environment (--clear to unset)",
    "  test [name]     Check connectivity (--all for every environment)",
    "  help            Show this help",
    "",
    "Run `cognigy-setup profile <subcommand> --help` for a subcommand's flags.",
    "",
  ].join("\n");
}
