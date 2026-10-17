import { describe, it, jest } from "@jest/globals";
import {
  loadProfiles,
  type Profile,
  type ProfileSet,
} from "../profiles/profiles.js";
import {
  EnvironmentError,
  createEnvironmentRegistry,
  type EnvironmentRuntime,
} from "../environments/registry.js";
import { eq, ok, raises } from "./helpers/specAssert.js";

const P = "COGNIGY_PROFILE_";
const KEY_A = "fake-key-AAAA-distinct-1";
const KEY_B = "fake-key-BBBB-distinct-2";
const env = (name: string, key: string): Record<string, string> => ({
  [`${P}${name}_API_BASE_URL`]: `https://api-${name.toLowerCase()}.cognigy.ai`,
  [`${P}${name}_API_KEY`]: key,
});
/** A fresh ProfileSet each call: same content, new objects (like a re-read). */
const twoSet = (): ProfileSet =>
  loadProfiles({ env: { ...env("A", KEY_A), ...env("B", KEY_B) } });
const oneSet = (): ProfileSet => loadProfiles({ env: env("A", KEY_A) });

type Step = () => ProfileSet;
function sequenced(steps: Step[]) {
  let i = 0;
  const createRuntime = jest.fn(
    (profile: Profile): EnvironmentRuntime => ({
      profile,
      client: {},
      handlers: { handleToolCall: jest.fn(async () => "ok") },
    }),
  );
  const registry = createEnvironmentRegistry({
    loadProfiles: () => steps[Math.min(i++, steps.length - 1)](),
    createRuntime,
  });
  return { registry, createRuntime };
}
const failing: Step = () => {
  throw new Error("config.json is locked");
};

function brokenCode(fn: () => unknown, what: string): EnvironmentError {
  const e = raises(
    fn,
    EnvironmentError,
    what,
    "F1: a load failure is a 'broken' EnvironmentError",
    "Throw an EnvironmentError when configuration cannot be loaded.",
  );
  eq(
    e.code,
    "broken",
    what,
    "F1: code is 'broken'",
    "Use code 'broken' for a load failure.",
  );
  return e;
}

describe("registry under a transient load failure", () => {
  it("F1a: a loader error makes resolve throw 'broken' with or without a name", () => {
    const { registry } = sequenced([failing, failing]);
    brokenCode(() => registry.resolve(), "unnamed resolve on load error");
    brokenCode(() => registry.resolve("a"), "named resolve on load error");
  });

  it("F1b: a loadError does not prune the runtime cache; the same runtime object is reused afterwards", () => {
    const { registry, createRuntime } = sequenced([oneSet, failing, oneSet]);
    const before = registry.resolve("a");
    brokenCode(() => registry.resolve("a"), "resolve during failure");
    const after = registry.resolve("a");
    ok(
      after === before,
      "runtime identity after transient failure",
      "F1: unchanged profile keeps its cached runtime",
      "the very same runtime object",
      "a different runtime object",
      "Do not discard cached runtimes just because one load failed.",
    );
    eq(
      createRuntime.mock.calls.length,
      1,
      "createRuntime count",
      "F1: runtime built only once across the failure",
      "Do not rebuild runtimes after a transient failure.",
    );
  });

  it("F1c: a loadError between two environments never lets an unnamed call reach the survivor", () => {
    const { registry, createRuntime } = sequenced([twoSet, failing, twoSet]);
    const first = raises(
      () => registry.resolve(),
      EnvironmentError,
      "unnamed with two environments",
      "F1: ambiguous before the failure",
      "Require a name when two environments are configured.",
    );
    eq(
      first.code,
      "ambiguous",
      "before failure",
      "F1: ambiguous",
      "Report ambiguity.",
    );
    const during = brokenCode(
      () => registry.resolve(),
      "unnamed during failure",
    );
    ok(
      createRuntime.mock.calls.length === 0,
      "no runtime during failure",
      "F1: nothing is built or served while configuration is unreadable",
      "no runtime created",
      `${createRuntime.mock.calls.length} created`,
      "Never fall through to a surviving environment.",
    );
    ok(
      during.message.length > 0,
      "failure message",
      "F1: explanatory message present",
      "non-empty message",
      during.message,
      "Explain that configuration could not be loaded.",
    );
    const after = raises(
      () => registry.resolve(),
      EnvironmentError,
      "unnamed after recovery",
      "F1: ambiguous again once both are back",
      "Require a name again after recovery.",
    );
    eq(
      after.code,
      "ambiguous",
      "after recovery",
      "F1: ambiguous",
      "Report ambiguity.",
    );
  });

  it("F1d: a changed profile after a failure still gets a fresh runtime", () => {
    const changed = (): ProfileSet =>
      loadProfiles({ env: env("A", "fake-key-AAAA-ROTATED-5") });
    const { registry, createRuntime } = sequenced([oneSet, failing, changed]);
    const before = registry.resolve("a");
    brokenCode(() => registry.resolve("a"), "resolve during failure");
    const after = registry.resolve("a");
    ok(
      after !== before && createRuntime.mock.calls.length === 2,
      "rotated key rebuilds",
      "F1: cache invalidation by profile change still works",
      "a new runtime for the changed profile",
      `same=${after === before}, builds=${createRuntime.mock.calls.length}`,
      "Rebuild when the profile content changed.",
    );
  });
});
