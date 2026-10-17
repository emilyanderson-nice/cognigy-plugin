import { describe, it, jest } from "@jest/globals";
import { inspect } from "util";
import {
  loadProfiles,
  type Profile,
  type ProfileSet,
} from "../profiles/profiles.js";
import {
  EnvironmentError,
  createEnvironmentRegistry,
  type EnvironmentErrorCode,
  type EnvironmentRuntime,
} from "../environments/registry.js";
import { eq, ok, raises } from "./helpers/specAssert.js";

const P = "COGNIGY_PROFILE_";
const KEY_A = "fake-key-AAAA-distinct-1";
const KEY_B = "fake-key-BBBB-distinct-2";
const KEY_C = "fake-key-CCCC-distinct-3";
const KEY_BROKEN = "fake-key-BROKEN-distinct-4";
const ALL_KEYS = [KEY_A, KEY_B, KEY_C, KEY_BROKEN];

type Env = Record<string, string>;
const url = (n: string): string => `https://api-${n}.cognigy.ai`;

/** Env settings for one usable env profile. NAME is the env-style uppercase name. */
function usable(
  name: string,
  key: string,
  base = url(name.toLowerCase()),
): Env {
  return {
    [`${P}${name}_API_BASE_URL`]: base,
    [`${P}${name}_API_KEY`]: key,
  };
}
/** A broken env profile: key present, URL missing -> a per-profile problem. */
function broken(name: string, key = KEY_BROKEN): Env {
  return { [`${P}${name}_API_KEY`]: key };
}
const setOf = (...envs: Env[]): ProfileSet =>
  loadProfiles({ env: Object.assign({}, ...envs) });

function fakeRuntime(profile: Profile): EnvironmentRuntime {
  return {
    profile,
    client: {},
    handlers: { handleToolCall: jest.fn(async () => "ok") },
  };
}
function harness(initial: ProfileSet) {
  let current: () => ProfileSet = () => initial;
  const load = jest.fn(() => current());
  const createRuntime = jest.fn((p: Profile) => fakeRuntime(p));
  const registry = createEnvironmentRegistry({
    loadProfiles: load,
    createRuntime,
  });
  return {
    registry,
    load,
    createRuntime,
    setNext(next: ProfileSet | (() => ProfileSet)) {
      current = typeof next === "function" ? next : () => next;
    },
  };
}
function envError(
  fn: () => unknown,
  code: EnvironmentErrorCode,
  what: string,
  why: string,
): EnvironmentError {
  const e = raises(
    fn,
    EnvironmentError,
    what,
    why,
    "Throw an EnvironmentError describing why no environment could be resolved.",
  );
  eq(
    e.code,
    code,
    what,
    `${why} (error code)`,
    `Use error code '${code}' for this situation.`,
  );
  return e;
}
function noKeys(text: string, what: string, why: string): void {
  for (const k of ALL_KEYS)
    ok(
      !text.includes(k),
      what,
      why,
      "no API key in the text",
      `contains ${k.slice(0, 13)}...`,
      "Never include API keys in errors, snapshots or serialisations.",
    );
}

describe("snapshot", () => {
  it("R1: loads profiles fresh on every call and picks up edits", () => {
    const h = harness(setOf(usable("A", KEY_A)));
    eq(
      h.registry.snapshot().configuredNames,
      ["a"],
      "snapshot first call",
      "R1: reflects current profiles",
      "Report the configured names.",
    );
    h.setNext(setOf(usable("A", KEY_A), usable("B", KEY_B)));
    eq(
      h.registry.snapshot().configuredNames,
      ["a", "b"],
      "snapshot after edit",
      "R1: edits picked up without restart",
      "Re-read the profile configuration on each call.",
    );
    eq(
      h.load.mock.calls.length,
      2,
      "load call count",
      "R1: one load per snapshot()",
      "Do not cache the loaded set across snapshots.",
    );
  });

  it("R1: exposes profiles, problems and defaultName from the set; names sorted, unique, including problems", () => {
    const set = setOf(
      usable("ZED", KEY_A),
      usable("MID", KEY_B),
      broken("ALPHA"),
    );
    const snap = createEnvironmentRegistry({
      loadProfiles: () => ({ ...set, defaultName: "mid" }),
      createRuntime: fakeRuntime,
    }).snapshot();
    eq(
      snap.configuredNames,
      ["alpha", "mid", "zed"],
      "configuredNames",
      "R1: usable + broken names, sorted ascending",
      "Return every configured name once, sorted.",
    );
    eq(
      snap.profiles.map((p) => p.name),
      set.profiles.map((p) => p.name),
      "snapshot.profiles",
      "R1: profiles come from the set",
      "Pass the usable profiles through.",
    );
    eq(
      snap.problems,
      set.problems,
      "snapshot.problems",
      "R1: problems come from the set",
      "Pass the problems through.",
    );
    eq(
      snap.defaultName,
      "mid",
      "snapshot.defaultName",
      "R1: defaultName comes from the set",
      "Pass defaultName through.",
    );
    eq(
      snap.loadError,
      undefined,
      "snapshot.loadError",
      "R1: no loadError when loading succeeds",
      "Leave loadError unset on success.",
    );
  });

  it("R1: a loader failure yields an empty snapshot with loadError, never a throw", () => {
    const h = harness(setOf());
    h.setNext(() => {
      throw new Error("default profile 'ghost' is not defined");
    });
    let snap: ReturnType<typeof h.registry.snapshot> | undefined;
    try {
      snap = h.registry.snapshot();
    } catch (e) {
      ok(
        false,
        "snapshot on loader failure",
        "R1: never throws",
        "returns a snapshot",
        `threw ${(e as Error).message}`,
        "Catch loader errors and report them as loadError.",
      );
    }
    eq(
      snap,
      {
        profiles: [],
        problems: [],
        configuredNames: [],
        defaultName: undefined,
        loadError: "default profile 'ghost' is not defined",
      },
      "snapshot on loader failure",
      "R1: empty fields + loadError = thrown message",
      "Return empty collections and the error text.",
    );
  });
});

describe("resolve with a name", () => {
  it("R2: normalises the name (case, underscore, whitespace) and returns that runtime", () => {
    const h = harness(
      setOf(usable("V4-STAGING", KEY_A), usable("OTHER", KEY_B)),
    );
    const rt = h.registry.resolve("  V4_Staging ");
    eq(
      rt.profile.name,
      "v4-staging",
      "resolve normalised name",
      "R2: V4_Staging -> v4-staging",
      "Normalise the requested name before lookup.",
    );
  });

  it("R2: a broken profile raises 'broken' with the normalised name, its reason and no key", () => {
    const h = harness(setOf(usable("OK", KEY_A), broken("BAD_ONE")));
    const reason = h.registry.snapshot().problems[0].reason;
    const e = envError(
      () => h.registry.resolve("Bad_One"),
      "broken",
      "resolve broken profile",
      "R2: broken profile",
    );
    eq(
      e.environment,
      "bad-one",
      "error.environment",
      "R2: environment is the normalised name",
      "Set environment to the normalised name.",
    );
    ok(
      e.message.includes(reason) && e.message.includes("bad-one"),
      "broken message",
      "R2: message contains the profile's reason and its name",
      `message containing '${reason}' and 'bad-one'`,
      e.message,
      "Explain which environment is broken and why.",
    );
    noKeys(e.message, "broken message secrecy", "R7: no key in message");
  });

  it("R2: an unconfigured name raises 'unknown' listing the available names", () => {
    const h = harness(
      setOf(usable("B", KEY_B), usable("A", KEY_A), broken("C")),
    );
    const e = envError(
      () => h.registry.resolve("nope"),
      "unknown",
      "resolve unknown name",
      "R2: not configured",
    );
    eq(
      e.available,
      ["a", "b", "c"],
      "error.available",
      "R2: available = configuredNames",
      "List every configured name, sorted.",
    );
    for (const n of ["a", "b", "c"])
      ok(
        e.message.includes(n),
        "unknown message lists names",
        "R2: message lists available names",
        `mentions '${n}'`,
        e.message,
        "Tell the caller which environments exist.",
      );
    eq(
      e.environment,
      "nope",
      "error.environment",
      "R2: environment is the requested (normalised) name",
      "Record the requested name on the error.",
    );
  });

  it.each(["", "   ", "\t\n"])(
    "R2: %j counts as no name (single usable env resolves; two are ambiguous)",
    (blank) => {
      const one = harness(setOf(usable("A", KEY_A)));
      eq(
        one.registry.resolve(blank).profile.name,
        "a",
        "blank name, one env",
        "R2: blank = not given",
        "Treat a blank name as absent.",
      );
      const two = harness(setOf(usable("A", KEY_A), usable("B", KEY_B)));
      envError(
        () => two.registry.resolve(blank),
        "ambiguous",
        "blank name, two envs",
        "R2: blank = not given",
      );
    },
  );
});

describe("resolve without a name", () => {
  it("R3: zero configured -> 'none' pointing at cognigy-setup profile add, available empty", () => {
    const h = harness(setOf());
    const e = envError(
      () => h.registry.resolve(),
      "none",
      "resolve none",
      "R3: nothing configured",
    );
    ok(
      e.message.includes("cognigy-setup profile add"),
      "none message",
      "R3: points at setup",
      "message containing 'cognigy-setup profile add'",
      e.message,
      "Tell the user how to add an environment.",
    );
    eq(
      e.available,
      [],
      "none available",
      "R8: available is an empty array for none",
      "Use an empty array.",
    );
  });

  it("R3: exactly one usable -> that runtime", () => {
    const h = harness(setOf(usable("SOLO", KEY_A)));
    eq(
      h.registry.resolve().profile.name,
      "solo",
      "single usable",
      "R3: sole environment is used",
      "Use the only configured environment.",
    );
  });

  it("R3: exactly one broken -> 'broken' with its reason", () => {
    const h = harness(setOf(broken("ONLY")));
    const reason = h.registry.snapshot().problems[0].reason;
    const e = envError(
      () => h.registry.resolve(),
      "broken",
      "single broken",
      "R3: sole env is broken",
    );
    ok(
      e.message.includes(reason),
      "single broken message",
      "R3: message has reason",
      `contains '${reason}'`,
      e.message,
      "Explain why the only environment is unusable.",
    );
    noKeys(e.message, "single broken secrecy", "R7");
  });

  it("R3: two or more -> 'ambiguous' with sorted available and a hint to pass environment", () => {
    const h = harness(
      setOf(usable("B", KEY_B), usable("A", KEY_A), broken("C")),
    );
    const e = envError(
      () => h.registry.resolve(),
      "ambiguous",
      "ambiguous",
      "R3: several configured",
    );
    eq(
      e.available,
      ["a", "b", "c"],
      "ambiguous available",
      "R3: available = configuredNames",
      "List all names, sorted.",
    );
    ok(
      e.message.includes("environment"),
      "ambiguous message",
      "R3: tells caller to pass environment",
      "message mentioning 'environment'",
      e.message,
      "Tell the caller to specify an environment.",
    );
    for (const n of ["a", "b", "c"])
      ok(
        e.message.includes(n),
        "ambiguous message lists names",
        "R3: lists names",
        `mentions '${n}'`,
        e.message,
        "List the choices.",
      );
  });

  it("R3: never silently uses defaultName when two or more are configured", () => {
    const base = setOf(usable("A", KEY_A), usable("B", KEY_B));
    const h = harness({ ...base, defaultName: "a" });
    envError(
      () => h.registry.resolve(),
      "ambiguous",
      "default ignored",
      "R3: no silent default",
    );
    eq(
      h.createRuntime.mock.calls.length,
      0,
      "no runtime built for ambiguous call",
      "R3/R5: nothing built when ambiguous",
      "Do not build any runtime when ambiguous.",
    );
  });
});

describe("loadError", () => {
  it.each([undefined, "any-name"])(
    "R4: resolve(%j) throws 'broken' containing the loadError text",
    (name) => {
      const h = harness(setOf());
      h.setNext(() => {
        throw new Error("load-failure-text-777");
      });
      const e = envError(
        () => h.registry.resolve(name),
        "broken",
        "resolve on loadError",
        "R4: loader failure is a broken state",
      );
      ok(
        e.message.includes("load-failure-text-777"),
        "loadError message",
        "R4: message has loadError",
        "contains 'load-failure-text-777'",
        e.message,
        "Surface the configuration load failure.",
      );
    },
  );
});

describe("runtime caching", () => {
  it("R5: builds lazily and only for the resolved profile; same unchanged profile is the same object", () => {
    const h = harness(setOf(usable("A", KEY_A), usable("B", KEY_B)));
    eq(
      h.createRuntime.mock.calls.length,
      0,
      "before resolve",
      "R5: lazy",
      "Build nothing until resolve.",
    );
    h.registry.snapshot();
    eq(
      h.createRuntime.mock.calls.length,
      0,
      "after snapshot",
      "R5: snapshot builds nothing",
      "Do not build runtimes in snapshot().",
    );
    const first = h.registry.resolve("a");
    const second = h.registry.resolve("a");
    ok(
      first === second,
      "cache identity",
      "R5: same unchanged profile -> same object",
      "toBe-identical runtime",
      "different objects",
      "Return the cached runtime.",
    );
    eq(
      h.createRuntime.mock.calls.length,
      1,
      "createRuntime calls",
      "R5: built once, and not for b",
      "Create the runtime once for the resolved profile only.",
    );
    eq(
      (h.createRuntime.mock.calls[0][0] as Profile).name,
      "a",
      "createRuntime arg",
      "R5: built for the resolved profile",
      "Pass the resolved profile to createRuntime.",
    );
  });

  const changes: [string, () => Env][] = [
    ["apiKey", () => usable("A", KEY_C)],
    ["apiBaseUrl", () => usable("A", KEY_A, "https://api-moved.cognigy.ai")],
    [
      "endpointBaseUrl",
      () => ({
        ...usable("A", KEY_A),
        [`${P}A_ENDPOINT_BASE_URL`]: "https://ep.example.com",
      }),
    ],
    [
      "webchatBaseUrl",
      () => ({
        ...usable("A", KEY_A),
        [`${P}A_WEBCHAT_BASE_URL`]: "https://wc.example.com",
      }),
    ],
    [
      "staticFilesBaseUrl",
      () => ({
        ...usable("A", KEY_A),
        [`${P}A_STATIC_FILES_BASE_URL`]: "https://st.example.com",
      }),
    ],
  ];
  it.each(changes)(
    "R5: a changed %s builds a new runtime and leaves the old one untouched and usable",
    async (field, edit) => {
      const h = harness(setOf(usable("A", KEY_A)));
      const old = h.registry.resolve("a");
      const oldProfile = old.profile;
      const oldHandlers = old.handlers;
      const oldCall = oldHandlers.handleToolCall as jest.Mock;
      h.setNext(setOf(edit()));
      const fresh = h.registry.resolve("a");
      ok(
        fresh !== old,
        `changed ${field}`,
        "R5: cache key includes this field",
        "a new runtime object",
        "the old object was reused",
        "Rebuild when this setting changes.",
      );
      eq(
        h.createRuntime.mock.calls.length,
        2,
        `changed ${field} build count`,
        "R5: exactly one rebuild",
        "Create exactly one new runtime.",
      );
      ok(
        old.profile === oldProfile && old.handlers === oldHandlers,
        `old runtime after ${field}`,
        "R5: old runtime is not mutated",
        "same profile/handlers references",
        "mutated",
        "Never modify a runtime already handed out.",
      );
      eq(
        await old.handlers.handleToolCall("t", {}),
        "ok",
        `old runtime usable after ${field}`,
        "R5: old holders can still call",
        "Keep the old runtime working.",
      );
      eq(
        oldCall.mock.calls.length,
        1,
        `old handler calls ${field}`,
        "R5: old handler still wired",
        "Keep the old handler functional.",
      );
    },
  );

  it("R5: changing only source or versionHint does not rebuild", () => {
    const fileSet = loadProfiles({
      env: {},
      fileProfiles: {
        profiles: { a: { apiBaseUrl: url("a"), apiKey: KEY_A } },
        problems: [],
      },
    });
    const h = harness(setOf(usable("A", KEY_A)));
    const first = h.registry.resolve("a");
    h.setNext(fileSet); // same values, source file-profile instead of env-profile
    const second = h.registry.resolve("a");
    ok(
      first !== undefined &&
        fileSet.profiles[0].source !== first.profile.source,
      "fixture sanity",
      "R5: fixture differs only in source",
      "different source values",
      `${first.profile.source} vs ${fileSet.profiles[0].source}`,
      "Fix the test fixture.",
    );
    ok(
      second === first,
      "source-only change",
      "R5: source is not in the cache key",
      "same runtime object",
      "rebuilt",
      "Do not rebuild for source changes.",
    );
    const hinted = Object.create(fileSet.profiles[0], {
      versionHint: { value: "v4", enumerable: true },
    }) as Profile;
    h.setNext({ ...fileSet, profiles: [hinted] });
    ok(
      h.registry.resolve("a") === first,
      "versionHint-only change",
      "R5: versionHint is not in the cache key",
      "same runtime object",
      "rebuilt",
      "Do not rebuild for versionHint changes.",
    );
    eq(
      h.createRuntime.mock.calls.length,
      1,
      "build count",
      "R5: built once overall",
      "Create the runtime once.",
    );
  });

  it("R5: a profile removed and later re-added is rebuilt", () => {
    const h = harness(setOf(usable("A", KEY_A), usable("B", KEY_B)));
    const first = h.registry.resolve("a");
    h.setNext(setOf(usable("B", KEY_B)));
    envError(
      () => h.registry.resolve("a"),
      "unknown",
      "removed profile",
      "R2/R5: removed -> unknown",
    );
    h.setNext(setOf(usable("A", KEY_A), usable("B", KEY_B)));
    const again = h.registry.resolve("a");
    ok(
      again !== first,
      "re-added profile",
      "R5: removal drops the cache entry",
      "a new runtime",
      "the old runtime came back",
      "Rebuild after removal and re-add.",
    );
    eq(
      h.createRuntime.mock.calls.length,
      2,
      "build count",
      "R5: two builds for a",
      "Build again.",
    );
  });
});

describe("createRuntime failure", () => {
  it("R6: throws 'broken' with a fixed safe message, leaks nothing, and does not cache the failure", () => {
    const h = harness(setOf(usable("A", KEY_A)));
    h.createRuntime.mockImplementationOnce(() => {
      throw new Error(`secret-xyz ${KEY_A}`);
    });
    const e1 = envError(
      () => h.registry.resolve("a"),
      "broken",
      "createRuntime throws",
      "R6: build failure is broken",
    );
    ok(
      !e1.message.includes("secret-xyz"),
      "build failure message",
      "R6: thrown message not echoed",
      "no 'secret-xyz'",
      e1.message,
      "Use a fixed message that omits the underlying error text.",
    );
    noKeys(e1.message, "build failure secrecy", "R6/R7: no key");
    eq(
      e1.environment,
      "a",
      "build failure environment",
      "R6: error names the environment",
      "Record which environment failed to build.",
    );
  });

  it("R6: the failed build is retried on the next resolve and then succeeds", () => {
    const h = harness(setOf(usable("A", KEY_A)));
    h.createRuntime.mockImplementationOnce(() => {
      throw new Error("secret-xyz");
    });
    envError(
      () => h.registry.resolve("a"),
      "broken",
      "first build fails",
      "R6",
    );
    const rt = h.registry.resolve("a");
    eq(
      rt.profile.name,
      "a",
      "retry succeeds",
      "R6: failure is not cached",
      "Retry building.",
    );
    eq(
      h.createRuntime.mock.calls.length,
      2,
      "build attempts",
      "R6: createRuntime called again",
      "Call createRuntime again after a failure.",
    );
  });

  it("R6: the fixed message is identical regardless of the underlying error", () => {
    const msgFor = (text: string): string => {
      const h = harness(setOf(usable("A", KEY_A)));
      h.createRuntime.mockImplementationOnce(() => {
        throw new Error(text);
      });
      return envError(
        () => h.registry.resolve("a"),
        "broken",
        "fixed message",
        "R6",
      ).message;
    };
    eq(
      msgFor("one-text"),
      msgFor("another-text"),
      "fixed message",
      "R6: message independent of cause",
      "Use the same text for every build failure of the same environment.",
    );
  });
});

describe("secrecy and error shape", () => {
  function mixed() {
    return harness(
      setOf(usable("A", KEY_A), usable("B", KEY_B), broken("BAD", KEY_BROKEN)),
    );
  }
  it("R7: no key in snapshot, registry or serialised forms, even after resolving", () => {
    const h = mixed();
    h.registry.resolve("a");
    const snap = h.registry.snapshot();
    noKeys(JSON.stringify(snap), "JSON.stringify(snapshot())", "R7");
    noKeys(JSON.stringify(h.registry), "JSON.stringify(registry)", "R7");
    noKeys(
      JSON.stringify(snap.problems) + snap.configuredNames.join(),
      "problems/names",
      "R7",
    );
  });

  it("R7: no key in any EnvironmentError message or util.inspect output", () => {
    const h = mixed();
    h.createRuntime.mockImplementationOnce(() => {
      throw new Error(`boom ${KEY_A}`);
    });
    const thrown = [
      () => h.registry.resolve("a"),
      () => h.registry.resolve("bad"),
      () => h.registry.resolve("ghost"),
      () => h.registry.resolve(),
    ].map((f) => {
      try {
        f();
      } catch (e) {
        return e as EnvironmentError;
      }
      throw new Error("expected throw");
    });
    for (const e of thrown) {
      noKeys(e.message, "error message", "R7");
      noKeys(inspect(e, { depth: 6 }), "util.inspect(error)", "R7");
      noKeys(JSON.stringify(e), "JSON.stringify(error)", "R7");
    }
  });

  it("R8: EnvironmentError has name, Error ancestry and a sorted available array", () => {
    const h = mixed();
    for (const call of [
      () => h.registry.resolve(),
      () => h.registry.resolve("ghost"),
    ]) {
      const e = raises(
        call,
        EnvironmentError,
        "error shape",
        "R8",
        "Throw EnvironmentError.",
      );
      eq(
        e.name,
        "EnvironmentError",
        "error.name",
        "R8: name",
        "Set name to EnvironmentError.",
      );
      ok(
        e instanceof Error,
        "instanceof Error",
        "R8",
        "instanceof Error",
        "not an Error",
        "Extend Error.",
      );
      eq(
        e.available,
        [...e.available].sort(),
        "available sorted",
        "R8: sorted",
        "Keep available sorted ascending.",
      );
      ok(
        Array.isArray(e.available),
        "available array",
        "R8",
        "array",
        typeof e.available,
        "Always an array.",
      );
    }
  });
});
