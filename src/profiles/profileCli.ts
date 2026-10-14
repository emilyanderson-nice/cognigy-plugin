import { runAdd } from "./profileCliAdd.js";
import { runDefault, runList, runRemove, runShow } from "./profileCliManage.js";
import { runTest } from "./profileCliTest.js";
import { profileUsage, SUBCOMMAND_USAGE } from "./profileCliUsage.js";
import { ProfileConfigError } from "./profiles.js";
import type { ProfileCliDeps } from "./profileCliTypes.js";

export type { ProfileCliDeps } from "./profileCliTypes.js";
export { profileUsage } from "./profileCliUsage.js";

const HINT =
  "Hint: run `cognigy-setup profile default --clear` to drop the saved default, or unset COGNIGY_PROFILE.";

const isHelp = (t: string): boolean => t === "--help" || t === "-h";

async function dispatch(
  sub: string,
  rest: string[],
  deps: ProfileCliDeps,
): Promise<number> {
  switch (sub) {
    case "add":
      return runAdd(rest, deps);
    case "list":
      return runList(rest, deps);
    case "show":
      return runShow(rest, deps);
    case "remove":
      return runRemove(rest, deps);
    case "default":
      return runDefault(rest, deps);
    case "test":
      return runTest(rest, deps);
    default:
      deps.err(`Unknown profile subcommand "${sub}".\n${profileUsage()}`);
      return 1;
  }
}

export async function runProfileCommand(
  argv: string[],
  deps: ProfileCliDeps,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || isHelp(sub)) {
    deps.out(profileUsage());
    return 0;
  }
  if (Object.hasOwn(SUBCOMMAND_USAGE, sub) && rest.some(isHelp)) {
    deps.out(SUBCOMMAND_USAGE[sub]);
    return 0;
  }
  try {
    return await dispatch(sub, rest, deps);
  } catch (e) {
    if (!(e instanceof ProfileConfigError)) throw e;
    deps.err(`${e.message}\n${HINT}\n`);
    return 1;
  }
}
