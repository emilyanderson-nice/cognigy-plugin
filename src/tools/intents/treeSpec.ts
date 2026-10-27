import type { IntentTree } from "./tree.js";

export const MAX_SPEC_INTENTS = 2000;
const MAX_NAME_CHARS = 200;
const MAX_PROBLEMS_SHOWN = 20;

export interface TreeSpecNode {
  level: 1 | 2 | 3;
  /** Intent names from the family down to this node. */
  path: string[];
}

export interface TreeSpec {
  nodes: TreeSpecNode[];
  counts: { families: number; groups: number; tags: number };
}

export type SpecProblem = {
  path: string;
  reason:
    | "not_json"
    | "shape"
    | "empty_name"
    | "name_too_long"
    | "slash_in_name"
    | "duplicate_sibling"
    | "duplicate_tag"
    | "too_many_intents";
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `intent` when a non-empty string after trimming, otherwise `name` trimmed. */
function intentNameOf(node: Record<string, unknown>): string {
  const intent = typeof node.intent === "string" ? node.intent.trim() : "";
  if (intent !== "") return intent;
  return typeof node.name === "string" ? node.name.trim() : "";
}

/**
 * Parses the JSON spec { families: [{ name, intent?, groups: [{ name, intent?,
 * tags: [tagIntentName] }] }] } into nodes ordered families, groups, tags.
 */
export function parseTreeSpec(
  text: string,
):
  | { ok: true; spec: TreeSpec }
  | { ok: false; count: number; problems: SpecProblem[] } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return {
      ok: false,
      count: 1,
      problems: [{ path: "", reason: "not_json" }],
    };
  }

  const problems: SpecProblem[] = [];
  const add = (path: string, reason: SpecProblem["reason"]): void => {
    problems.push({ path, reason });
  };
  const fail = (): {
    ok: false;
    count: number;
    problems: SpecProblem[];
  } => ({
    ok: false,
    count: problems.length,
    problems: problems.slice(0, MAX_PROBLEMS_SHOWN),
  });

  if (!isPlainObject(root)) {
    add("", "shape");
    return fail();
  }
  const familiesRaw = root.families;
  if (!Array.isArray(familiesRaw) || familiesRaw.length === 0) {
    add("families", "shape");
    return fail();
  }

  /** Reports empty / too long / slash problems; true when the name is usable. */
  const checkName = (name: string, path: string): boolean => {
    if (name === "") add(path, "empty_name");
    else if (name.length > MAX_NAME_CHARS) add(path, "name_too_long");
    else if (name.includes("/")) add(path, "slash_in_name");
    else return true;
    return false;
  };

  const families: TreeSpecNode[] = [];
  const groups: TreeSpecNode[] = [];
  const tags: TreeSpecNode[] = [];
  const tagOwner = new Map<string, string>();
  let total = 0;
  const familyNames = new Set<string>();

  familiesRaw.forEach((family: unknown, fi) => {
    const fPath = `families[${fi}]`;
    if (!isPlainObject(family)) {
      add(fPath, "shape");
      return;
    }
    total += 1;
    const fName = intentNameOf(family);
    checkName(fName, fPath);
    if (familyNames.has(fName) && fName !== "") add(fPath, "duplicate_sibling");
    familyNames.add(fName);
    families.push({ level: 1, path: [fName] });

    const groupsRaw = family.groups;
    if (groupsRaw === undefined) return;
    if (!Array.isArray(groupsRaw)) {
      add(`${fPath}.groups`, "shape");
      return;
    }
    const groupNames = new Set<string>();
    groupsRaw.forEach((group: unknown, gi) => {
      const gPath = `${fPath}.groups[${gi}]`;
      if (!isPlainObject(group)) {
        add(gPath, "shape");
        return;
      }
      total += 1;
      const gName = intentNameOf(group);
      checkName(gName, gPath);
      if (groupNames.has(gName) && gName !== "") {
        add(gPath, "duplicate_sibling");
      }
      groupNames.add(gName);
      groups.push({ level: 2, path: [fName, gName] });

      const tagsRaw = group.tags;
      if (tagsRaw === undefined) return;
      if (!Array.isArray(tagsRaw)) {
        add(`${gPath}.tags`, "shape");
        return;
      }
      const groupKey = `${fi}/${gi}`;
      const siblingTags = new Set<string>();
      tagsRaw.forEach((tag: unknown, ti) => {
        const tPath = `${gPath}.tags[${ti}]`;
        if (typeof tag !== "string") {
          add(tPath, "shape");
          return;
        }
        total += 1;
        const tName = tag.trim();
        checkName(tName, tPath);
        if (tName !== "") {
          if (siblingTags.has(tName)) add(tPath, "duplicate_sibling");
          else if (tagOwner.has(tName) && tagOwner.get(tName) !== groupKey) {
            add(tPath, "duplicate_tag");
          }
          siblingTags.add(tName);
          if (!tagOwner.has(tName)) tagOwner.set(tName, groupKey);
        }
        tags.push({ level: 3, path: [fName, gName, tName] });
      });
    });
  });

  if (total > MAX_SPEC_INTENTS) add("", "too_many_intents");
  if (problems.length > 0) return fail();

  return {
    ok: true,
    spec: {
      nodes: [...families, ...groups, ...tags],
      counts: {
        families: families.length,
        groups: groups.length,
        tags: tags.length,
      },
    },
  };
}

export interface TreePlan {
  existing: Array<{ path: string[]; level: 1 | 2 | 3; id: string }>;
  create: Array<{
    path: string[];
    level: 1 | 2 | 3;
    parentPath: string[] | null;
  }>;
}

export const pathKey = (path: string[]): string => JSON.stringify(path);

/** Which spec nodes already exist in the tree and which must be created. */
export function planTree(spec: TreeSpec, tree: IntentTree): TreePlan {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const idOf = new Map<string, string>();
  const plan: TreePlan = { existing: [], create: [] };

  for (const node of spec.nodes) {
    const name = node.path[node.path.length - 1];
    let candidates: string[];
    let parentPath: string[] | null = null;
    if (node.level === 1) {
      candidates = tree.roots;
    } else {
      parentPath = node.path.slice(0, -1);
      const parentId = idOf.get(pathKey(parentPath));
      candidates =
        parentId === undefined ? [] : (byId.get(parentId)?.childIds ?? []);
    }
    const match = candidates.find((id) => byId.get(id)?.name === name);
    if (match !== undefined) {
      idOf.set(pathKey(node.path), match);
      plan.existing.push({ path: node.path, level: node.level, id: match });
    } else {
      plan.create.push({ path: node.path, level: node.level, parentPath });
    }
  }
  return plan;
}
