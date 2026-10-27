/**
 * Environments guidance. The full rule set lives in the environments skill
 * (plugin/skills/environments/SKILL.md); SERVER_INSTRUCTIONS keeps a compact
 * ENVIRONMENTS block for clients that do not load skills. toolSurfaceBudget
 * caps the instructions at 2000 characters, so the long form cannot stay there.
 *
 * Assumption: the compact block is introduced by a line starting with
 * "ENVIRONMENTS" and runs to the next all-caps heading or the end of the text.
 */
import { describe, it } from "@jest/globals";
import { SERVER_INSTRUCTIONS } from "../instructions.js";
import { tools } from "../tools/definitions.js";
import { readRepo } from "./helpers/docText.js";
import { ok, show } from "./helpers/specAssert.js";

const ENV_SKILL = "plugin/skills/environments/SKILL.md";
const envSkill = readRepo(ENV_SKILL);

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

function expectSentence(
  source: string,
  where: string,
  what: string,
  rule: string,
  ...parts: RegExp[]
) {
  const hit = sentences(source).find((s) => parts.every((p) => p.test(s)));
  ok(
    hit !== undefined,
    `instructions::${where}::${what}`,
    `Rule: ${rule}`,
    `one sentence of ${where} matching ${parts.map(String).join(" AND ")}`,
    source === "" ? `no text for ${where}` : show(source.slice(0, 600)),
    `State this rule explicitly, in a single sentence, in ${where}.`,
  );
}

const inSkill = (what: string, rule: string, ...parts: RegExp[]) =>
  expectSentence(envSkill, ENV_SKILL, what, rule, ...parts);
const inInstructions = (what: string, rule: string, ...parts: RegExp[]) =>
  expectSentence(
    environmentsSection(),
    "the ENVIRONMENTS block of SERVER_INSTRUCTIONS",
    what,
    rule,
    ...parts,
  );

describe("environments skill carries the full guidance", () => {
  it("names the environment argument and the list_environments tool", () => {
    inSkill(
      "argument",
      "mentions the `environment` argument",
      /`environment`|environment (argument|parameter)/i,
    );
    inSkill(
      "list_tool",
      "mentions the list_environments tool",
      /list_environments/,
    );
  });

  it("requires environment on every call when more than one exists, kept constant per task", () => {
    inSkill(
      "every_call",
      "with more than one environment, `environment` must be passed on every call except list_environments",
      /more than one environment/i,
      /every (tool )?call/i,
      /except[^.]*list_environments|list_environments[^.]*except/i,
    );
    inSkill(
      "constant",
      "the environment stays constant within one task",
      /(constant|same environment|consistent|switch)/i,
      /task/i,
    );
  });

  it("requires confirming the target before destructive operations", () => {
    inSkill(
      "confirm_destructive",
      "confirm the target environment with the user before destructive operations when more than one exists",
      /confirm/i,
      /destructive/i,
      /user/i,
      /more than one|several|multiple/i,
    );
  });

  it("says ids, endpoint urls and package/snapshot references are environment-scoped", () => {
    inSkill(
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
    inSkill(
      "ask_user",
      "ask the user when it is unclear which environment is meant",
      /ask the user/i,
      /unclear|ambiguous|not sure|unsure/i,
    );
  });

  it("says the default marker is not consent and the model must still ask or confirm", () => {
    const ss = sentences(envSkill);
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
      show(envSkill.slice(0, 800)),
      "Say that a default marker never replaces asking or confirming with the user.",
    );
  });

  it("says to carry the same environment through every step of a multi-step task", () => {
    inSkill(
      "same_env_every_step",
      "carry the same environment through every step of a multi-step build",
      /same environment/i,
      /every (step|call)/i,
    );
  });
});

describe("environments skill: session pin guidance", () => {
  it("says a pinned session needs no environment argument", () => {
    inSkill(
      "pinned_no_arg",
      "when the session is pinned, do not pass `environment` (or pass the pinned name)",
      /pinned/i,
      /`environment`/,
      /(do not|don't|omit|no need)/i,
    );
  });

  it("says to call use_environment once at the start when the user names a tenant or profile", () => {
    inSkill(
      "use_once",
      "call use_environment once at the start when the user names a tenant/profile",
      /use_environment/,
      /once/i,
      /(tenant|profile)/i,
    );
  });

  it("says to switch the pin only when the user asks, and to say so", () => {
    inSkill(
      "switch_on_request",
      "switch only when the user asks and say so",
      /switch/i,
      /user asks/i,
      /say so|tell the user/i,
    );
  });

  it("says destructive operations are still confirmed by name even when pinned", () => {
    inSkill(
      "confirm_when_pinned",
      "confirm the target environment by name before destructive operations even when pinned",
      /confirm/i,
      /destructive/i,
      /pinned/i,
      /by name/i,
    );
  });
});

describe("SERVER_INSTRUCTIONS compact environments block", () => {
  it("has an ENVIRONMENTS block that points at the environments skill", () => {
    ok(
      environmentsSection() !== "" &&
        /environments skill/i.test(environmentsSection()),
      "instructions::section",
      "Rule: the instructions contain an ENVIRONMENTS block naming the skill that owns the rules",
      "a heading line starting with ENVIRONMENTS that mentions the environments skill",
      show(environmentsSection().slice(0, 300) || "heading missing"),
      "Add a heading line starting with ENVIRONMENTS that names the environments skill.",
    );
  });

  it("requires environment on every call when more than one exists, unless pinned", () => {
    inInstructions(
      "every_call",
      "with more than one environment, pass environment on every call (list_environments shows them) unless the session is pinned",
      /more than one environment/i,
      /\benvironment\b/i,
      /every call/i,
      /list_environments/,
      /pinned/i,
    );
  });

  it("says the default marker is not consent", () => {
    inInstructions(
      "default_not_consent",
      "the default marker never stands in for choosing the target",
      /default marker/i,
      /not consent/i,
    );
  });

  it("requires confirming the target by name before destructive operations", () => {
    inInstructions(
      "confirm_destructive",
      "confirm the environment by name before delete, restore or overwrite",
      /confirm/i,
      /by name/i,
      /delete/i,
      /restore/i,
      /overwrite/i,
    );
  });

  it("says ids, endpoint urls and package/snapshot references are environment-scoped", () => {
    inInstructions(
      "scoped",
      "ids, endpoint URLs and package/snapshot references belong to one environment",
      /\bids\b/i,
      /endpoint url/i,
      /package/i,
      /snapshot/i,
      /belong to one environment/i,
    );
  });
});

describe("SERVER_INSTRUCTIONS use_environment ordering rule", () => {
  it("says to call use_environment alone, in its own turn, before other tools", () => {
    const hit = sentences(SERVER_INSTRUCTIONS).find(
      (s) => /use_environment/.test(s) && /alone/i.test(s) && /turn/i.test(s),
    );
    ok(
      hit !== undefined,
      "instructions::pin_alone_own_turn",
      "Rule: same-turn tool calls run in undefined order, so a pin issued with another call can lose the race",
      "one sentence containing 'use_environment', 'alone' and 'turn'",
      "no such sentence",
      "Add one terse sentence: call use_environment alone, in its own turn, before any other tool call.",
    );
    // Killing mutation: sentence absent, or its three terms split across sentences.
  });
});

describe("existing guidance keeps a home", () => {
  const descriptionOf = (name: string): string =>
    String((tools.find((t) => t.name === name) as any)?.description);

  it.each([
    "NiCE Cognigy Plugin — builds and iteratively improves LLM-powered AI Agents",
    "NEVER guess or invent API keys, URLs or credentials.",
  ])("SERVER_INSTRUCTIONS keeps: %s", (phrase) => {
    ok(
      SERVER_INSTRUCTIONS.includes(phrase),
      "instructions::existing_content",
      "Rule: the always-on baseline keeps the plugin identity and the credentials rule",
      `text containing: ${phrase}`,
      "phrase missing",
      "Restore the phrase in src/instructions.ts.",
    );
  });

  // Upstream moved these out of the always-on text to stay under the size
  // budget. Each fact must still be stated where the model will meet it.
  it.each([
    [
      "create_ai_agent description",
      () => descriptionOf("create_ai_agent"),
      "auto-provisioned flow, AI Agent Job Node and REST endpoint",
    ],
    [
      "delete_resource description",
      () => descriptionOf("delete_resource"),
      "never hard-deleted",
    ],
    [
      "package-management skill",
      () => readRepo("plugin/skills/package-management/SKILL.md"),
      "project-scoped",
    ],
    [
      "tools-setup skill",
      () => readRepo("plugin/skills/tools-setup/SKILL.md"),
      "the default for any business action",
    ],
    [
      "docs-lookup skill",
      () => readRepo("plugin/skills/docs-lookup/SKILL.md"),
      "query_docs_filesystem_cognigy_documentation",
    ],
  ])("%s still states: %s", (_where, get, phrase) => {
    ok(
      (get() as string).includes(phrase as string),
      "instructions::moved_content",
      `Rule: guidance moved out of SERVER_INSTRUCTIONS must still be stated in ${_where}`,
      `text containing: ${phrase}`,
      "phrase missing",
      `State it in ${_where}; do not move it back into the always-on instructions.`,
    );
  });

  it("states the agent/tool alignment check as one always-on sentence", () => {
    const hit = sentences(SERVER_INSTRUCTIONS).find(
      (s) =>
        /re-read/i.test(s) &&
        /tool description/i.test(s) &&
        /authentication/i.test(s),
    );
    ok(
      hit !== undefined,
      "instructions::alignment_rule",
      "Rule: always-on guidance tells the model to re-read the agent's instructions against its tool descriptions on authentication",
      "one sentence containing 're-read', 'tool description' and 'authentication'",
      "no such sentence",
      "Add one terse sentence covering all three; the skill owns the detail.",
    );
    // Killing mutation: sentence absent, or its three terms split across sentences.
  });
});
