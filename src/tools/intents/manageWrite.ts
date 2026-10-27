import { withHints } from "../filters.js";
import { startBuild } from "./build.js";
import {
  failure,
  isRecord,
  readTreeForWrite,
  requestFailed,
  resolveNode,
  type ManageDeps,
  type Op,
  type Result,
} from "./manageCommon.js";
import { importSentences } from "./sentences.js";
import { buildTree, checkCreate, checkMove, type IntentTree } from "./tree.js";
import { intentsPath, statusField, type IntentApi } from "./types.js";

/** Write operations of manage_intents. Every one verifies the project first. */

const DEFAULT_WAIT_SECONDS = 60;
const DEFAULT_IMPORT_DEADLINE_SECONDS = 60;

const EMPTY_TOTALS = {
  created: 0,
  deleted: 0,
  skippedExisting: 0,
  duplicatesDropped: 0,
  batches: 0,
};

/**
 * Reads the flow and requires its projectReference to equal the projectId
 * argument, so a flow cannot be paired with another project's id to get past
 * the backup hold. The flow body is returned for reuse (build needs its localeReference).
 */
async function verifyProject(
  api: IntentApi,
  operation: string,
  flowId: string,
  projectId: string,
): Promise<{ flow: Record<string, unknown> } | { error: Result }> {
  let flow: unknown;
  try {
    flow = await api.get(`/v2.0/flows/${flowId}`);
  } catch (err) {
    return { error: failure(operation, "flow_not_readable", statusField(err)) };
  }
  if (!isRecord(flow) || flow.projectReference !== projectId) {
    return { error: failure(operation, "project_mismatch") };
  }
  return { flow };
}

const hasSibling = (
  tree: IntentTree,
  parentId: string | null,
  name: string,
  exceptId?: string,
): string | undefined =>
  tree.nodes.find(
    (n) =>
      n.parentId === parentId &&
      n.id !== exceptId &&
      n.name.trim() === name.trim(),
  )?.id;

const nameExists = (operation: string, id: string): Result =>
  failure(operation, "name_exists", { id });

export async function create(api: IntentApi, a: Op<"create">): Promise<Result> {
  const verified = await verifyProject(api, a.operation, a.flowId, a.projectId);
  if ("error" in verified) return verified.error;
  const got = await readTreeForWrite(api, a.operation, a.flowId);
  if ("error" in got) return got.error;
  const { tree } = got.read;

  let parentId: string | null = null;
  if (a.parent !== undefined) {
    const parent = resolveNode(tree, a.operation, a.parent, "parent_not_found");
    if ("error" in parent) return parent.error;
    parentId = parent.node.id;
  }
  const check = checkCreate(tree, parentId);
  if (!check.ok) {
    return failure(a.operation, check.error, { message: check.message });
  }
  const existing = hasSibling(tree, parentId, a.name);
  if (existing !== undefined) return nameExists(a.operation, existing);

  // The platform rejects localeReference on intent create; never send it.
  const created: unknown = await api.post(intentsPath(a.flowId), {
    name: a.name,
    ...(parentId !== null ? { parentIntentId: parentId } : {}),
    ...(a.childFeatures !== undefined
      ? { childFeatures: a.childFeatures }
      : {}),
    ...(a.priority !== undefined
      ? { biasTowardsParentOrChildIntents: a.priority }
      : {}),
  });
  const id = isRecord(created) ? created._id : undefined;
  if (typeof id !== "string" || id === "") {
    return requestFailed(
      a.operation,
      undefined,
      "The platform did not return the new intent's id, so it may have been created. Use list to check before retrying.",
    );
  }

  const result: Result = {
    operation: a.operation,
    flowId: a.flowId,
    intent: { id, name: a.name, parentId, depth: check.depth },
  };
  if (a.sentences === undefined) return result;

  let imported: Result;
  try {
    const r = await importSentences(
      api,
      a.flowId,
      buildTree([...tree.nodes, { id, name: a.name, parentId }]),
      [{ intent: id, sentences: a.sentences }],
      { mode: "add" },
    );
    imported = r.ok
      ? { status: r.status, totals: r.totals }
      : { status: "partial", totals: EMPTY_TOTALS };
  } catch {
    imported = { status: "partial", totals: EMPTY_TOTALS };
  }
  const out = { ...result, sentences: imported };
  return imported.status === "complete"
    ? out
    : withHints(out, {
        action:
          "The intent was created but its sentences are incomplete. Finish with import_sentences (mode add); do not repeat create.",
      });
}

export async function update(api: IntentApi, a: Op<"update">): Promise<Result> {
  const verified = await verifyProject(api, a.operation, a.flowId, a.projectId);
  if ("error" in verified) return verified.error;
  const got = await readTreeForWrite(api, a.operation, a.flowId);
  if ("error" in got) return got.error;
  const target = resolveNode(got.read.tree, a.operation, a.intent, "not_found");
  if ("error" in target) return target.error;
  const { node } = target;

  if (a.name !== undefined) {
    const clash = hasSibling(got.read.tree, node.parentId, a.name, node.id);
    if (clash !== undefined) return nameExists(a.operation, clash);
  }

  const changed: string[] = [];
  const body: Record<string, unknown> = {};
  if (a.name !== undefined) {
    body.name = a.name;
    changed.push("name");
  }
  if (a.childFeatures !== undefined) {
    body.childFeatures = a.childFeatures;
    changed.push("childFeatures");
  }
  if (a.priority !== undefined) {
    body.biasTowardsParentOrChildIntents = a.priority;
    changed.push("priority");
  }
  await api.patch(`${intentsPath(a.flowId)}/${node.id}`, body);
  return {
    operation: a.operation,
    flowId: a.flowId,
    intent: { id: node.id, name: a.name ?? node.name },
    changed,
  };
}

export async function move(api: IntentApi, a: Op<"move">): Promise<Result> {
  const verified = await verifyProject(api, a.operation, a.flowId, a.projectId);
  if ("error" in verified) return verified.error;
  const got = await readTreeForWrite(api, a.operation, a.flowId);
  if ("error" in got) return got.error;
  const { tree } = got.read;
  const target = resolveNode(tree, a.operation, a.intent, "not_found");
  if ("error" in target) return target.error;

  let parentId: string | null = null;
  if (a.parent !== null) {
    const parent = resolveNode(tree, a.operation, a.parent, "parent_not_found");
    if ("error" in parent) return parent.error;
    parentId = parent.node.id;
  }
  const check = checkMove(tree, target.node.id, parentId);
  if (!check.ok) {
    return failure(a.operation, check.error, { message: check.message });
  }
  const clash = hasSibling(tree, parentId, target.node.name, target.node.id);
  if (clash !== undefined) return nameExists(a.operation, clash);

  await api.patch(`${intentsPath(a.flowId)}/${target.node.id}`, {
    parentIntentId: parentId,
  });
  return {
    operation: a.operation,
    flowId: a.flowId,
    intent: { id: target.node.id, name: target.node.name },
    parentId,
    newDepth: check.newDepth,
    deepestLevel: check.deepestLevel,
  };
}

export async function remove(api: IntentApi, a: Op<"delete">): Promise<Result> {
  const verified = await verifyProject(api, a.operation, a.flowId, a.projectId);
  if ("error" in verified) return verified.error;
  const got = await readTreeForWrite(api, a.operation, a.flowId);
  if ("error" in got) return got.error;
  const target = resolveNode(got.read.tree, a.operation, a.intent, "not_found");
  if ("error" in target) return target.error;
  const { node } = target;
  if (node.childIds.length > 0) {
    return failure(a.operation, "has_children", {
      childCount: node.childIds.length,
    });
  }
  await api.delete(`${intentsPath(a.flowId)}/${node.id}`);
  return {
    operation: a.operation,
    flowId: a.flowId,
    deleted: { id: node.id, name: node.name },
  };
}

export async function importOp(
  api: IntentApi,
  a: Op<"import_sentences">,
  deps: ManageDeps,
): Promise<Result> {
  const verified = await verifyProject(api, a.operation, a.flowId, a.projectId);
  if ("error" in verified) return verified.error;
  const got = await readTreeForWrite(api, a.operation, a.flowId);
  if ("error" in got) return got.error;
  const result = await importSentences(
    api,
    a.flowId,
    got.read.tree,
    a.entries,
    {
      mode: a.mode,
      deadlineMs: (a.deadlineSeconds ?? DEFAULT_IMPORT_DEADLINE_SECONDS) * 1000,
      now: deps.now,
    },
  );
  const out: Result = { operation: a.operation, flowId: a.flowId, ...result };
  return result.ok && result.status === "partial"
    ? withHints(out, {
        warning:
          "The import is partial: some intents failed, are incomplete or were not attempted. Re-run the same import to finish; sentences already present are skipped.",
      })
    : out;
}

export async function build(
  api: IntentApi,
  a: Op<"build">,
  deps: ManageDeps,
): Promise<Result> {
  const verified = await verifyProject(api, a.operation, a.flowId, a.projectId);
  if ("error" in verified) return verified.error;
  const locale = verified.flow.localeReference;
  if (typeof locale !== "string" || locale === "") {
    return {
      ...failure(a.operation, "locale_not_found"),
      flowId: a.flowId,
      ok: false,
    };
  }
  const result = await startBuild(api, a.flowId, {
    projectId: a.projectId,
    localeId: locale,
    mode: a.mode,
    deadlineMs: (a.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
    sleep: deps.sleep,
    now: deps.now,
  });
  const out: Result = { operation: a.operation, flowId: a.flowId, ...result };
  return result.ok && result.status === "pending"
    ? withHints(out, {
        action:
          "Training was accepted but has not finished. Check with manage_intents model_state later; do not assume it succeeded.",
      })
    : out;
}
