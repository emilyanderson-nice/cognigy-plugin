/**
 * Module E: every plugin skill has well-formed frontmatter (name equals its
 * directory, non-empty description), and the new `environments` skill teaches
 * the multi-environment rules.
 *
 * Derived rule (all 17 existing skills already satisfy it): the file starts
 * with a `---` line, the frontmatter block holds top-level `name:` and
 * `description:` scalars (optionally double-quoted), and the block closes with
 * a second `---` line.
 */
import { describe, it } from "@jest/globals";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { eq, ok, show } from "./helpers/specAssert.js";

const SKILLS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugin",
  "skills",
);

interface Skill {
  dir: string;
  front: Record<string, string> | undefined;
  body: string;
}

function unquote(v: string): string {
  const t = v.trim();
  return /^"(.*)"$/s.test(t) || /^'(.*)'$/s.test(t) ? t.slice(1, -1) : t;
}

function readSkill(dir: string): Skill {
  const raw = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { dir, front: undefined, body: raw };
  const front: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]] = unquote(kv[2]);
  }
  return { dir, front, body: m[2] };
}

const dirs = readdirSync(SKILLS_DIR).filter(
  (d) =>
    statSync(join(SKILLS_DIR, d)).isDirectory() &&
    existsSync(join(SKILLS_DIR, d, "SKILL.md")),
);

const DEFAULT_NOT_CONSENT =
  /default[\s\S]{0,200}(consent|permission|not a reason)|(consent|permission|not a reason)[\s\S]{0,200}default/i;
const SAME_ENV_EVERY_STEP =
  /same environment[\s\S]{0,200}every (step|call)|every (step|call)[\s\S]{0,200}same environment/i;

describe("plugin skills: frontmatter", () => {
  it("the environments skill exists among the skill directories", () => {
    ok(
      dirs.includes("environments"),
      "pluginSkills::environments_exists",
      "Rule: plugin/skills/environments/SKILL.md exists",
      "environments in the skill list",
      show(dirs),
      "Add the environments skill.",
    );
  });

  it.each(dirs)(
    "%s has name == directory and a non-empty description",
    (dir) => {
      const s = readSkill(dir);
      ok(
        s.front !== undefined,
        `pluginSkills::frontmatter[${dir}]`,
        "Rule: SKILL.md starts with a closed YAML frontmatter block",
        "--- block at the top",
        "no frontmatter",
        "Open and close the frontmatter with --- lines.",
      );
      eq(
        s.front?.name,
        dir,
        `pluginSkills::name[${dir}]`,
        "Rule: frontmatter name equals the directory name",
        "Name the skill exactly like its folder.",
      );
      ok(
        (s.front?.description ?? "").trim().length > 0,
        `pluginSkills::description[${dir}]`,
        "Rule: description is non-empty",
        "non-empty description",
        show(s.front?.description),
        "Describe when the skill should be used.",
      );
    },
  );
});

describe("plugin skill: environments", () => {
  const skill = dirs.includes("environments")
    ? readSkill("environments")
    : undefined;
  const desc = skill?.front?.description ?? "";
  const body = skill?.body ?? "";

  const need = (what: string, rule: string, text: string, re: RegExp) =>
    ok(
      re.test(text),
      `pluginSkills::${what}`,
      `Rule: ${rule}`,
      `text matching ${re}`,
      skill ? show(text.slice(0, 300)) : "environments skill missing",
      "Cover this topic in the environments skill.",
    );

  it("description says when to use it", () => {
    need(
      "desc_when",
      "description starts with a use-when trigger",
      desc,
      /^use when/i,
    );
    need(
      "desc_multi",
      "description mentions more than one Cognigy environment",
      desc,
      /more than one|multiple/i,
    );
    need(
      "desc_versions",
      "description mentions classic / v4 / staging",
      desc,
      /classic/i,
    );
    need("desc_v4", "description mentions v4", desc, /v4/i);
    need("desc_staging", "description mentions staging", desc, /staging/i);
  });

  it("body covers list_environments, the environment argument, confirmation, scoping and asking", () => {
    need(
      "body_list",
      "body mentions list_environments",
      body,
      /list_environments/,
    );
    need(
      "body_arg",
      "body mentions the environment argument",
      body,
      /`environment`|environment (argument|parameter)/i,
    );
    need(
      "body_confirm",
      "body says to confirm the target before destructive operations",
      body,
      /confirm[\s\S]{0,200}destructive|destructive[\s\S]{0,200}confirm/i,
    );
    need(
      "body_scoped",
      "body says ids are environment-scoped",
      body,
      /\bids?\b[\s\S]{0,200}(environment-scoped|belong[s]? to (one|a single)|only valid|scoped to|specific to)/i,
    );
    need(
      "body_ask",
      "body says to ask the user when the environment is ambiguous",
      body,
      /ask the user[\s\S]{0,200}(ambiguous|unclear|not sure)|(ambiguous|unclear|not sure)[\s\S]{0,200}ask the user/i,
    );
  });

  it("body covers pinning a session with use_environment", () => {
    need(
      "body_use_environment",
      "body mentions the use_environment tool",
      body,
      /use_environment/,
    );
    need(
      "body_launch_pin",
      "body mentions the COGNIGY_ENVIRONMENT launch pin",
      body,
      /COGNIGY_ENVIRONMENT/,
    );
    need(
      "body_pinned_no_arg",
      "body says a pinned session does not pass environment",
      body,
      /pinned[\s\S]{0,200}(do not|don't) pass `environment`/i,
    );
    need(
      "body_confirm_when_pinned",
      "body says destructive operations are confirmed by name even when pinned",
      body,
      /destructive[\s\S]{0,300}even when (the session is )?pinned|even when (the session is )?pinned[\s\S]{0,300}destructive/i,
    );
  });

  it("body says the default marker is not consent and to carry the same environment through every step (G6)", () => {
    need(
      "body_default_not_consent",
      "body says the default marker is not consent to use that environment",
      body,
      DEFAULT_NOT_CONSENT,
    );
    need(
      "body_same_env",
      "body says to carry the same environment through every step",
      body,
      SAME_ENV_EVERY_STEP,
    );
  });
});

describe("G6 regexes are meaningful (positive and negative samples)", () => {
  it.each([
    [
      "default-not-consent",
      DEFAULT_NOT_CONSENT,
      "The default marker in list_environments is not permission to use that environment.",
      "List the environments and ask which one the user means.",
    ],
    [
      "same-env-every-step",
      SAME_ENV_EVERY_STEP,
      "Carry the same environment through every step of a multi-step build.",
      "Pick an environment when it seems convenient.",
    ],
  ])(
    "%s matches its positive sample and rejects its negative one",
    (_n, re, yes, no) => {
      ok(
        re.test(yes) && !re.test(no),
        `pluginSkills::regex_sanity[${_n}]`,
        "Rule: the checking regex matches a natural sentence and rejects text lacking the idea",
        "match(positive) and not match(negative)",
        `positive=${re.test(yes)}, negative=${re.test(no)}`,
        "Fix the regex so it can neither always pass nor never pass.",
      );
    },
  );
});
