/**
 * Doc-claim tests for the log feature (amendment A14f): claims only as
 * evidenced. Retention is "typically about 24 hours", never a guarantee; no
 * text may say debug/trace are "only returned when asked for" or that the
 * platform "lags a few seconds". Definitions are read from the module, the hint
 * text from readLogs with a mocked client, docs from disk.
 */
import { describe, it, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  LOG_DOC_FILES,
  definitionLogTexts,
  listDef,
  norm,
  readRepo,
  section,
} from "./helpers/docText.js";
import {
  Mock,
  PROJECT,
  expectExact,
  opts,
  page,
  queue,
} from "./helpers/logFixtures.js";

const BANNED_CLAIMS = [
  "retained about",
  "kept about",
  "only returned when asked",
  "lags a few seconds",
];
const TYPICAL = "typically about 24 hours";

const FIX_BANNED =
  "retention: 'typically about 24 hours'; levels: 'request debug/trace levels via logLevel if you need them'; timing: 'the newest lines of a test that just finished may not be visible yet; retry once'";

/** All hint strings readLogs can produce on the window and session paths. */
async function allHints(): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const run = async (label: string, args: object, responses: unknown[]) => {
    const client = jest.fn() as Mock;
    queue(client, responses);
    const r = await readLogs(
      { get: client } as any,
      { projectId: PROJECT, ...args } as any,
      opts,
    );
    out.push([`${label} hint.action`, String(r.hint?.action ?? "")]);
    out.push([`${label} hint.warning`, String(r.hint?.warning ?? "")]);
  };
  await run("summary", {}, [page(3, 3)]);
  await run("truncated summary", {}, [
    page(100, 900),
    page(100, 900),
    page(100, 900),
  ]);
  await run("empty summary", {}, [{ items: [], total: 0 }]);
  await run("entries", { view: "entries" }, [page(3, 3)]);
  await run("session", { sessionId: "s1" }, [page(3, -1)]);
  return out;
}

describe("log doc claims only as evidenced (A14f)", () => {
  it.each(definitionLogTexts())(
    "list_resources %s contains none of the unevidenced claims",
    (label, text) => {
      expectExact(
        BANNED_CLAIMS.filter((b) => norm(text).includes(b)),
        [],
        {
          what: `list_resources ${label} unevidenced claim`,
          why: "A14f: retention and platform timing are not guaranteed; claims must be worded as observed",
          fix: FIX_BANNED,
        },
      );
    },
  );

  it("every readLogs hint (all views and outcomes) contains none of the unevidenced claims", async () => {
    const found = (await allHints())
      .filter(([, text]) => BANNED_CLAIMS.some((b) => norm(text).includes(b)))
      .map(([label]) => label);
    expectExact(found, [], {
      what: "readLogs hint text unevidenced claims",
      why: "A14f: hints must not state retention as 'retained about' / 'kept about'",
      fix: FIX_BANNED,
    });
  });

  it.each(LOG_DOC_FILES)(
    "%s contains none of the unevidenced claims anywhere",
    (rel) => {
      const whole = norm(readRepo(rel));
      expectExact(
        BANNED_CLAIMS.filter((b) => whole.includes(b)),
        [],
        {
          what: `${rel} unevidenced claim`,
          why: "A14f: docs may not say 'kept about 24 hours', 'only returned when asked for' or 'lags a few seconds'",
          fix: FIX_BANNED,
        },
      );
    },
  );

  it("the list_resources description says 'typically about 24 hours'", () => {
    expectExact(norm(String(listDef.description)).includes(TYPICAL), true, {
      what: "list_resources description retention wording",
      why: "A14f: retention is observed, not guaranteed, so it is worded 'typically about 24 hours'",
      fix: "write 'retained' claims as: runtime logs, typically about 24 hours",
    });
  });

  it("readLogs hint.action on a successful summary says 'typically about 24 hours'", async () => {
    const client = jest.fn() as Mock;
    queue(client, [page(3, 3)]);
    const r = await readLogs(
      { get: client } as any,
      { projectId: PROJECT } as any,
      opts,
    );
    expectExact(norm(String(r.hint?.action)).includes(TYPICAL), true, {
      what: "readLogs hint.action retention wording",
      why: "A14f: every successful result's hint.action carries the retention note worded 'typically about 24 hours'",
      fix: "change the retention sentence in the hint to 'Logs are typically about 24 hours old at most' style wording containing 'typically about 24 hours'",
    });
  });

  it("every successful readLogs hint.action (entries and session too) keeps the '24 hours' note", async () => {
    const missing = (await allHints())
      .filter(
        ([label, text]) =>
          label.endsWith("hint.action") &&
          !label.startsWith("empty") &&
          !norm(text).includes("24 hours"),
      )
      .map(([label]) => label);
    expectExact(missing, [], {
      what: "hint.action retention note across views",
      why: "A14f keeps the contract rule that every successful result mentions retention (24 hours)",
      fix: "keep the retention sentence in every success hint",
    });
  });

  it("SKILL.md log section says 'typically about 24 hours'", () => {
    const log = norm(
      section(
        readRepo("plugin/skills/troubleshooting/SKILL.md"),
        /^#+ .*project logs/i,
      ),
    );
    expectExact([log.length > 0, log.includes(TYPICAL)], [true, true], {
      what: "SKILL.md log section retention wording",
      why: "A14f: retention is worded 'typically about 24 hours'",
      fix: "replace 'Logs are kept about 24 hours' with 'Logs typically last about 24 hours' wording that contains 'typically about 24 hours'",
    });
  });

  it.each(LOG_DOC_FILES)(
    "%s: any retention mention in the log section is worded 'typically about 24 hours'",
    (rel, heading) => {
      const log = norm(section(readRepo(rel), heading));
      const mentions = log.includes("24 hours");
      expectExact([mentions ? log.includes(TYPICAL) : true], [true], {
        what: `${rel} log section retention wording`,
        why: "A14f: never state retention as a guarantee",
        fix: "use 'typically about 24 hours'",
      });
    },
  );
});
