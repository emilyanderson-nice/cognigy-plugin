/**
 * Helpers for the log wording / doc-claim tests: read repo docs and the tool
 * definition as whitespace-collapsed lower-case text. Test-only; pure reads.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { tools } from "../../tools/definitions.js";

export const listDef = tools.find((t) => t.name === "list_resources") as any;

export const norm = (s: string): string => s.replace(/\s+/g, " ").toLowerCase();

export const readRepo = (rel: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

/** The markdown section starting at the first heading matching the pattern. */
export const section = (text: string, headingPattern: RegExp): string => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => headingPattern.test(l));
  if (start < 0) return "";
  const level = (lines[start].match(/^#+/) as RegExpMatchArray)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
};

export const LOG_HEADING = /^#+ .*project logs/i;

/** Repo files that document the log feature, with their log-section heading. */
export const LOG_DOC_FILES: Array<[string, RegExp]> = [
  ["plugin/skills/troubleshooting/SKILL.md", LOG_HEADING],
  [".claude/CLAUDE.md", LOG_HEADING],
  ["README.md", LOG_HEADING],
];

/** Every log-relevant text of the list_resources definition, labelled. */
export const definitionLogTexts = (): Array<[string, string]> => [
  ["description", String(listDef.description)],
  ...(["logLevel", "search", "flowName", "sessionId", "view"] as const).map(
    (p): [string, string] => [
      `parameter ${p}`,
      String(listDef.inputSchema.properties[p].description),
    ],
  ),
  ...(["limit", "skip", "sort", "startDate", "endDate"] as const).map(
    (p): [string, string] => [
      `parameter ${p}`,
      String(listDef.inputSchema.properties[p]?.description ?? ""),
    ],
  ),
];

/**
 * Over-claim detector (A14e). Removes the one allowed truthful sentence (it
 * names BOTH meta.text and meta.URLToken), then flags any remaining sentence
 * that says user/customer text or data is never returned/shown/exposed/
 * revealed/included/displayed/output/sent or never leaves.
 */
const NEVER_VERB =
  "(?:returned|shown|exposed|revealed|included|displayed|output|outputted|sent|leaves?|disclosed|surfaced|emitted)";
const USER_NOUN =
  "(?:end[- ]?users?|users?|customers?|callers?)(?:'s)?(?: (?:text|texts|messages?|data|input|utterances?))?";
export const OVERCLAIM_PATTERNS: RegExp[] = [
  new RegExp(`${USER_NOUN}[^.]{0,60}\\bnever\\b[^.]{0,40}\\b${NEVER_VERB}\\b`),
  new RegExp(`\\bnever\\b[^.]{0,40}\\b${NEVER_VERB}\\b[^.]{0,60}${USER_NOUN}`),
  /user text and endpoint credentials/,
  /user text and url tokens never leave/,
];

export function overclaims(text: string): string[] {
  const sentences = norm(text).split(/(?<=[.!?;])\s+/);
  const kept = sentences.filter(
    (s) => !(s.includes("meta.text") && s.includes("meta.urltoken")),
  );
  return kept.filter((s) => OVERCLAIM_PATTERNS.some((re) => re.test(s)));
}
