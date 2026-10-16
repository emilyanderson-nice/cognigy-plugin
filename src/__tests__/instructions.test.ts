/**
 * Module D: SERVER_INSTRUCTIONS gains an ENVIRONMENTS section (always-on
 * guidance for clients that do not load skills) without losing existing rules.
 *
 * Assumption: the section is introduced by a line starting with "ENVIRONMENTS"
 * (like the existing "RULES:" / "CAPABILITIES:" headings) and runs to the next
 * all-caps heading or the end of the text.
 */
import { describe, it } from "@jest/globals";
import { SERVER_INSTRUCTIONS } from "../instructions.js";
import { ok, show } from "./helpers/specAssert.js";

// Current length is 12174 characters; allow +3000 for the new section.
const MAX_LENGTH = 15200;

function environmentsSection(): string {
  const m = /^ENVIRONMENTS\b.*$/im.exec(SERVER_INSTRUCTIONS);
  if (!m) return "";
  const rest = SERVER_INSTRUCTIONS.slice(m.index + m[0].length);
  const next = /\n\n[A-Z][A-Z &/()_-]{3,}:/.exec(rest);
  return m[0] + (next ? rest.slice(0, next.index) : rest);
}

const sentences = (s: string): string[] =>
  s
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

function expectSentence(what: string, rule: string, ...parts: RegExp[]) {
  const section = environmentsSection();
  const hit = sentences(section).find((s) => parts.every((p) => p.test(s)));
  ok(
    hit !== undefined,
    `instructions::${what}`,
    `Rule: ${rule}`,
    `one sentence of the ENVIRONMENTS section matching ${parts.map(String).join(" AND ")}`,
    section === ""
      ? "no ENVIRONMENTS section found"
      : show(section.slice(0, 600)),
    "State this rule explicitly, in a single sentence, inside an ENVIRONMENTS section.",
  );
}

describe("SERVER_INSTRUCTIONS environments guidance", () => {
  it("has an ENVIRONMENTS section", () => {
    ok(
      environmentsSection() !== "",
      "instructions::section",
      "Rule: the instructions contain an ENVIRONMENTS section",
      "a heading line starting with ENVIRONMENTS",
      "heading missing",
      "Add a heading line starting with ENVIRONMENTS.",
    );
  });

  it("names the environment argument and the list_environments tool", () => {
    expectSentence(
      "argument",
      "mentions the `environment` argument",
      /`environment`|environment (argument|parameter)/i,
    );
    expectSentence(
      "list_tool",
      "mentions the list_environments tool",
      /list_environments/,
    );
  });

  it("requires environment on every call when more than one exists, kept constant per task", () => {
    expectSentence(
      "every_call",
      "with more than one environment, `environment` must be passed on every call except list_environments",
      /more than one environment/i,
      /every (tool )?call/i,
      /except[^.]*list_environments|list_environments[^.]*except/i,
    );
    expectSentence(
      "constant",
      "the environment stays constant within one task",
      /(constant|same environment|consistent|switch)/i,
      /task/i,
    );
  });

  it("requires confirming the target before destructive operations", () => {
    expectSentence(
      "confirm_destructive",
      "confirm the target environment with the user before destructive operations when more than one exists",
      /confirm/i,
      /destructive/i,
      /user/i,
      /more than one|several|multiple/i,
    );
  });

  it("says ids, endpoint urls and package/snapshot references are environment-scoped", () => {
    expectSentence(
      "scoped",
      "ids, endpoint URLs and package/snapshot references belong to one environment and must not be reused in another",
      /\bids?\b/i,
      /endpoint url/i,
      /package/i,
      /snapshot/i,
      /(not|never)[^.]*(reuse|reused|use)/i,
    );
  });

  it("says to ask the user when the environment is unclear", () => {
    expectSentence(
      "ask_user",
      "ask the user when it is unclear which environment is meant",
      /ask the user/i,
      /unclear|ambiguous|not sure|unsure/i,
    );
  });
});

describe("SERVER_INSTRUCTIONS environments guidance (G6)", () => {
  it("says the default marker is not consent and the model must still ask or confirm", () => {
    const section = environmentsSection();
    const ss = sentences(section);
    const i = ss.findIndex(
      (x) =>
        /default/i.test(x) &&
        /consent|permission|not a reason/i.test(x) &&
        /environment/i.test(x),
    );
    ok(
      i >= 0 && /ask|confirm/i.test(`${ss[i]} ${ss[i + 1] ?? ""}`),
      "instructions::default_not_consent",
      "Rule: the isDefault marker in list_environments is not permission to use that environment; still ask or confirm",
      "a sentence with default + (consent|permission|not a reason) + environment, itself or the next sentence saying ask/confirm",
      section === "" ? "no ENVIRONMENTS section" : show(section.slice(0, 800)),
      "Say that a default marker never replaces asking or confirming with the user.",
    );
  });

  it("says to carry the same environment through every step of a multi-step task", () => {
    expectSentence(
      "same_env_every_step",
      "carry the same environment through every step of a multi-step build",
      /same environment/i,
      /every (step|call)/i,
    );
  });
});

describe("SERVER_INSTRUCTIONS session pin guidance", () => {
  it("says a pinned session needs no environment argument", () => {
    expectSentence(
      "pinned_no_arg",
      "when the session is pinned, do not pass `environment` (or pass the pinned name)",
      /pinned/i,
      /`environment`/,
      /(do not|don't|omit|no need)/i,
    );
  });

  it("says to call use_environment once at the start when the user names a tenant or profile", () => {
    expectSentence(
      "use_once",
      "call use_environment once at the start when the user names a tenant/profile",
      /use_environment/,
      /once/i,
      /(tenant|profile)/i,
    );
  });

  it("says to switch the pin only when the user asks, and to say so", () => {
    expectSentence(
      "switch_on_request",
      "switch only when the user asks and say so",
      /switch/i,
      /user asks/i,
      /say so|tell the user/i,
    );
  });

  it("says destructive operations are still confirmed by name even when pinned", () => {
    expectSentence(
      "confirm_when_pinned",
      "confirm the target environment by name before destructive operations even when pinned",
      /confirm/i,
      /destructive/i,
      /pinned/i,
      /by name/i,
    );
  });
});

describe("SERVER_INSTRUCTIONS existing content", () => {
  it.each([
    "NiCE Cognigy Plugin — builds and iteratively improves LLM-powered AI Agents.",
    "create_ai_agent auto-provisions flow + AI Agent Job Node + REST endpoint.",
    "delete_resource is the ONLY way to delete anything.",
    "Cognigy Connections are PROJECT-SCOPED",
    "NEVER hallucinate or guess API keys, connection URLs, or credentials.",
    "TOOL TYPE SELECTION (create_tool):",
    "DOCUMENTATION LOOKUP:",
  ])("keeps: %s", (phrase) => {
    ok(
      SERVER_INSTRUCTIONS.includes(phrase),
      "instructions::existing_content",
      "Rule: existing instruction content must remain",
      `text containing: ${phrase}`,
      "phrase missing",
      "Add the environments section without removing existing guidance.",
    );
  });

  it("stays under the size bound", () => {
    ok(
      SERVER_INSTRUCTIONS.length <= MAX_LENGTH,
      "instructions::size",
      "Rule: always-on instructions stay terse (current size + 3000 at most)",
      `length <= ${MAX_LENGTH}`,
      `length ${SERVER_INSTRUCTIONS.length}`,
      "Keep the new section concise; let the skill own the detail.",
    );
  });
});
