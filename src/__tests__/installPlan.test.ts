import { describe, it, expect } from "@jest/globals";
import * as setupModule from "../setup.js";

// Namespace import so a missing planInstall export fails the planInstall
// tests individually instead of aborting the whole suite at link time.
const { parseFlags } = setupModule;
const planInstall = (
  setupModule as unknown as {
    planInstall: (flags: ReturnType<typeof parseFlags>) => unknown;
  }
).planInstall as (flags: ReturnType<typeof parseFlags>) => {
  scope?: string;
  clients?: string[];
  error?: string;
};

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
  mode: "equal" | "contains" = "equal",
): void {
  try {
    if (mode === "contains") {
      expect(String(actual)).toContain(String(expected));
    } else {
      expect(actual).toEqual(expected);
    }
  } catch {
    throw new Error(
      [
        `1. WHAT FAILED: ${testName}`,
        `2. REQUIREMENT VIOLATED: ${requirement}`,
        `3. EXPECTED${mode === "contains" ? " (substring)" : ""}: ${JSON.stringify(expected)}`,
        `4. ACTUAL: ${JSON.stringify(actual)}`,
        `5. GUIDANCE: ${guidance}`,
      ].join("\n"),
    );
  }
}

type Flags = ReturnType<typeof parseFlags>;

/** Build real flags through the parser, then force the client list. */
function flagsWith(argv: string[], clients?: string[]): Flags {
  const f = parseFlags(argv);
  if (clients !== undefined) {
    (f as unknown as { clients: string[] }).clients = clients;
  }
  return f;
}

describe("parseFlags: --project", () => {
  it("--project sets project to true", () => {
    check(
      "parseFlags(['--project']).project",
      "The --project flag is recognised",
      true,
      parseFlags(["--project"]).project,
      "Add a boolean project field set when --project is present.",
    );
  });

  it("project is exactly false (not undefined) when the flag is absent", () => {
    check(
      "parseFlags([]).project",
      "Absent flag yields false, a real boolean",
      false,
      parseFlags([]).project,
      "Initialise project to false.",
    );
  });

  it("--client claude-code --project keeps the client list and sets project", () => {
    const f = parseFlags(["--client", "claude-code", "--project"]);
    check(
      "parseFlags client + project: clients",
      "--project does not disturb client parsing",
      ["claude-code"],
      f.clients,
      "Parse --client independently of --project.",
    );
    check(
      "parseFlags client + project: project",
      "--project is honoured alongside --client",
      true,
      f.project,
      "Set project when --project appears anywhere in argv.",
    );
  });

  it("--project before key and url options still parses them exactly", () => {
    const f = parseFlags([
      "--project",
      "--api-key",
      "k",
      "--api-base-url",
      "u",
    ]);
    check(
      "parseFlags project + key/url: apiKey",
      "--project must not swallow the next token as a value",
      "k",
      f.apiKey,
      "Treat --project as a boolean flag that consumes no value.",
    );
    check(
      "parseFlags project + key/url: apiBaseUrl",
      "--project must not swallow the next token as a value",
      "u",
      f.apiBaseUrl,
      "Treat --project as a boolean flag that consumes no value.",
    );
    check(
      "parseFlags project + key/url: project",
      "--project is still recorded",
      true,
      f.project,
      "Set project when --project is present.",
    );
  });
});

describe("planInstall fed by the real parser (end to end)", () => {
  const PROJECT_PLAN = { scope: "project", clients: ["claude-code"] };

  it("['--project'] plans project scope with claude-code", () => {
    check(
      "planInstall(parseFlags(['--project']))",
      "Bare --project defaults to claude-code",
      PROJECT_PLAN,
      planInstall(parseFlags(["--project"])),
      "Parse --project to project=true and let the planner default the client.",
    );
  });

  it("['--client','claude-code','--project'] plans project scope with claude-code", () => {
    check(
      "planInstall(parseFlags(['--client','claude-code','--project']))",
      "Explicit claude-code plus --project is accepted",
      PROJECT_PLAN,
      planInstall(parseFlags(["--client", "claude-code", "--project"])),
      "Feed parser output straight into the planner.",
    );
  });

  it("duplicate --client claude-code collapses to a single client", () => {
    check(
      "planInstall(parseFlags(['--project','--client','claude-code','--client','claude-code']))",
      "Duplicates collapse, so the single-client rule still holds",
      PROJECT_PLAN,
      planInstall(
        parseFlags([
          "--project",
          "--client",
          "claude-code",
          "--client",
          "claude-code",
        ]),
      ),
      "De-duplicate clients in the parser or planner.",
    );
  });

  it("['--client','codex','--project'] is an error naming codex, nothing else", () => {
    const plan = planInstall(parseFlags(["--client", "codex", "--project"]));
    check(
      "planInstall(parseFlags(['--client','codex','--project'])): keys",
      "An unsupported client yields an error-only result",
      ["error"],
      Object.keys(plan),
      "Return only an error key.",
    );
    check(
      "planInstall(parseFlags(['--client','codex','--project'])): text",
      "The error names the offending client",
      "codex",
      String((plan as { error?: unknown }).error),
      "Include codex in the error text.",
      "contains",
    );
  });

  it("[] plans user scope with no clients", () => {
    check(
      "planInstall(parseFlags([]))",
      "No flags means user scope and an empty client list",
      { scope: "user", clients: [] },
      planInstall(parseFlags([])),
      "Do not inject defaults in user scope.",
    );
  });
});

describe("planInstall: user scope", () => {
  it("no project flag, several clients: user scope, clients unchanged and in order", () => {
    check(
      "planInstall user scope with clients",
      "User scope passes clients through untouched, same order",
      { scope: "user", clients: ["codex", "claude-code"] },
      planInstall(flagsWith([], ["codex", "claude-code"])),
      "Return { scope: 'user', clients } without sorting, filtering or adding keys.",
    );
  });

  it("no project flag, no clients: user scope with an empty list", () => {
    check(
      "planInstall user scope no clients",
      "Empty selection stays empty in user scope (the caller decides the default)",
      { scope: "user", clients: [] },
      planInstall(flagsWith([], [])),
      "Do not inject default clients in user scope.",
    );
  });

  it("user scope keeps desktop and antigravity selections", () => {
    check(
      "planInstall user scope non-code clients",
      "Only project scope restricts clients",
      { scope: "user", clients: ["claude-desktop", "antigravity"] },
      planInstall(flagsWith([], ["claude-desktop", "antigravity"])),
      "Apply the client restriction only when project is true.",
    );
  });
});

describe("planInstall: project scope", () => {
  it("project, no clients: defaults to claude-code only", () => {
    check(
      "planInstall project no clients",
      "Project scope defaults to the one supported client",
      { scope: "project", clients: ["claude-code"] },
      planInstall(flagsWith(["--project"], [])),
      "Return { scope: 'project', clients: ['claude-code'] } when none were chosen.",
    );
  });

  it("project, clients ['claude-code']: accepted as given", () => {
    check(
      "planInstall project claude-code",
      "Explicit claude-code is valid in project scope",
      { scope: "project", clients: ["claude-code"] },
      planInstall(flagsWith(["--project"], ["claude-code"])),
      "Pass the single supported client through.",
    );
  });

  it("project with unsupported clients: error only, naming offenders but not claude-code as one", () => {
    const plan = planInstall(
      flagsWith(["--project"], ["claude-code", "claude-desktop", "codex"]),
    );
    check(
      "planInstall project unsupported: shape",
      "The plan carries an error and no scope or clients (nothing is silently dropped)",
      ["error"],
      Object.keys(plan),
      "Return an object with only an error key; do not return a trimmed client list.",
    );
    const text = String((plan as { error?: unknown }).error);
    check(
      "planInstall project unsupported: mentions flag",
      "The error names the flag causing the restriction",
      "--project",
      text,
      "Mention --project in the error text.",
      "contains",
    );
    check(
      "planInstall project unsupported: offenders listed in order",
      "Offending clients are listed together in the order given",
      "claude-desktop, codex",
      text,
      "List the unsupported clients comma-separated with a space, preserving order.",
      "contains",
    );
    check(
      "planInstall project unsupported: states what is supported",
      "The error says project scope supports only claude-code",
      true,
      text.includes("only") && text.includes("claude-code"),
      "Say that only claude-code is supported with --project.",
    );
    check(
      "planInstall project unsupported: claude-code not an offender",
      "claude-code must not appear in the offender list",
      false,
      text.includes("claude-code, claude-desktop"),
      "List only the unsupported clients as offenders.",
    );
  });

  it("project with antigravity: error naming antigravity", () => {
    const plan = planInstall(flagsWith(["--project"], ["antigravity"]));
    check(
      "planInstall project antigravity: shape",
      "An unsupported client yields an error, not a plan",
      ["error"],
      Object.keys(plan),
      "Return only an error key.",
    );
    check(
      "planInstall project antigravity: text",
      "The error names the unsupported client",
      "antigravity",
      String((plan as { error?: unknown }).error),
      "Include the offending client name in the error.",
      "contains",
    );
  });

  it("project with a mix of claude-code and one other client is rejected, not narrowed", () => {
    const plan = planInstall(
      flagsWith(["--project"], ["codex", "claude-code"]),
    );
    check(
      "planInstall project mixed",
      "Other clients are never silently dropped in favour of claude-code",
      ["error"],
      Object.keys(plan),
      "Reject any selection that contains a non-claude-code client.",
    );
  });
});
