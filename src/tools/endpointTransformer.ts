/**
 * manage_endpoint_settings, transformer operations: read and change the
 * transformer of an Endpoint (code, the on/off switches per transformer,
 * abortOnError).
 *
 * Endpoints are NOT part of a snapshot, so a change to the code needs a backup
 * file first (`backupTo`); the tool refuses to change code without one. The
 * backup is two files: the JSON block and the plain code next to it, so the
 * code can be sent back with `codeFromFile`. The platform compiles the code
 * itself on save (TypeScript with type check). A refused compile (400) is
 * stored anyway with empty executed code (observed, see
 * docs/platform-versions), so the previous block is put back. Only the changed
 * fields are sent, which leaves everything else on the endpoint untouched.
 */
import vm from "node:vm";
import { withHints } from "./filters.js";
import {
  FileAccessError,
  readTextFile,
  sha256Hex,
  writeTextFile,
} from "../utils/fileAccess.js";

type Api = {
  get: (path: string, config?: any) => Promise<any>;
  patch: (path: string, body?: any) => Promise<any>;
};

/** Switch and flag fields of the transformer object, in the order they are reported. */
export const TRANSFORMER_FLAGS = [
  "abortOnError",
  "inputTransformerEnabled",
  "outputTransformerEnabled",
  "finalPingTransformerEnabled",
  "notifyTransformerEnabled",
  "injectTransformerEnabled",
] as const;

type Flag = (typeof TRANSFORMER_FLAGS)[number];

const fileMessage = (err: unknown): string =>
  err instanceof FileAccessError || err instanceof Error
    ? err.message
    : "The file could not be accessed.";

/** The transformer block of an endpoint as the model should see it: no code, only its size and hash. */
function summarize(transformer: any): Record<string, unknown> {
  const code: string =
    typeof transformer?.transformer === "string" ? transformer.transformer : "";
  const transpiled: string =
    typeof transformer?.transpiledTransformer === "string"
      ? transformer.transpiledTransformer
      : "";
  const flags: Record<string, unknown> = {};
  for (const flag of TRANSFORMER_FLAGS) flags[flag] = transformer?.[flag];
  return {
    ...flags,
    codeBytes: Buffer.byteLength(code, "utf8"),
    codeSha256: sha256Hex(code),
    transpiledBytes: Buffer.byteLength(transpiled, "utf8"),
    transpiledSha256: sha256Hex(transpiled),
  };
}

/** Syntax check only (nothing is executed). Returns an error text or null. */
export function syntaxError(code: string): string | null {
  try {
    // Parses as a script; the code is never run.
    new vm.Script(code, { filename: "transformer.js" });
    return null;
  } catch (err: any) {
    return String(err?.message ?? err);
  }
}

/** `x.json` -> `x.code.js`; any other name gets `.code.js` appended. */
export const backupCodePath = (backupTo: string): string =>
  backupTo.replace(/\.json$/i, "") + ".code.js";

async function readEndpoint(api: Api, endpointId: string): Promise<any> {
  return api.get(`/v2.0/endpoints/${endpointId}`);
}

export async function manageEndpointTransformer(
  api: Api,
  data: any,
): Promise<any> {
  const before: any = await readEndpoint(api, data.endpointId);
  const transformer = before?.transformer;
  if (!transformer || typeof transformer !== "object") {
    return withHints(
      {
        error: `The endpoint has no transformer settings (channel ${before?.channel ?? "unknown"}).`,
        endpointId: data.endpointId,
      },
      {
        action:
          "Check the id with list_resources { resourceType: 'endpoint', projectId }. Some channels carry no transformer.",
      },
    );
  }

  if (data.operation === "get") {
    const result: Record<string, unknown> = {
      endpointId: data.endpointId,
      name: before.name,
      channel: before.channel,
      ...summarize(transformer),
    };
    if (data.saveCodeTo) {
      try {
        const saved = await writeTextFile(
          data.saveCodeTo,
          String(transformer.transformer ?? ""),
          undefined,
          { overwrite: data.overwrite === true },
        );
        result.codeSavedTo = {
          path: saved.path,
          bytes: saved.bytes,
          sha256: saved.sha256,
        };
      } catch (err) {
        result.saveError = fileMessage(err);
      }
    }
    return withHints(result, {
      action:
        "The code itself is not returned. Pass saveCodeTo to write it to a file, edit it there and push it back with update and codeFromFile.",
    });
  }

  // ---- update ----
  const flagChanges: Partial<Record<Flag, boolean>> = {};
  for (const flag of TRANSFORMER_FLAGS) {
    if (typeof data[flag] === "boolean") flagChanges[flag] = data[flag];
  }

  if (data.code !== undefined && data.codeFromFile) {
    return {
      error: "Give code or codeFromFile, not both.",
      field: "codeFromFile",
    };
  }
  let newCode: string | undefined = data.code;
  if (data.codeFromFile) {
    try {
      newCode = await readTextFile(data.codeFromFile);
    } catch (err) {
      return { error: fileMessage(err), field: "codeFromFile" };
    }
  }
  const hasCodeChange = newCode !== undefined;
  if (!hasCodeChange && Object.keys(flagChanges).length === 0) {
    return withHints(
      { error: "Nothing to change." },
      {
        action:
          "Pass at least one switch (for example inputTransformerEnabled), abortOnError, code or codeFromFile.",
      },
    );
  }

  // Only what changes is sent; the platform keeps the rest (observed).
  const patchBody: Record<string, unknown> = { ...flagChanges };
  if (hasCodeChange) {
    if (!data.backupTo) {
      return withHints(
        {
          error:
            "Changing the code needs backupTo: endpoints are not part of a snapshot.",
        },
        {
          action:
            "Pass backupTo (a file path inside the working folder). The current transformer block is written there before anything is changed.",
        },
      );
    }
    patchBody.transformer = newCode;
  }

  // Backup first, whenever one is asked for.
  let backup: Record<string, unknown> | undefined;
  if (data.backupTo) {
    try {
      const overwrite = { overwrite: data.overwrite === true };
      const saved = await writeTextFile(
        data.backupTo,
        JSON.stringify({ endpointId: data.endpointId, transformer }, null, 2),
        undefined,
        overwrite,
      );
      const code = await writeTextFile(
        backupCodePath(data.backupTo),
        String(transformer.transformer ?? ""),
        undefined,
        overwrite,
      );
      backup = {
        path: saved.path,
        bytes: saved.bytes,
        sha256: saved.sha256,
        codeFile: code.path,
      };
    } catch (err) {
      return {
        error: `Backup not written, nothing was changed: ${fileMessage(err)}`,
        field: "backupTo",
      };
    }
  }

  try {
    await api.patch(`/v2.0/endpoints/${data.endpointId}`, {
      transformer: patchBody,
    });
  } catch (err: any) {
    // Verified live on the EU trial: a refused compile (400) still stores the
    // refused source and leaves the executed code empty. Put the previous
    // block back so the endpoint is not left broken.
    const refusal = String(err?.message ?? err);
    let rolledBack = false;
    try {
      await api.patch(`/v2.0/endpoints/${data.endpointId}`, {
        transformer,
      });
      const now: any = (await readEndpoint(api, data.endpointId))?.transformer;
      rolledBack =
        now?.transformer === transformer.transformer &&
        now?.transpiledTransformer === transformer.transpiledTransformer;
    } catch {
      rolledBack = false;
    }
    return withHints(
      {
        error: `The platform refused the change: ${refusal}`,
        changed: false,
        rolledBack,
        ...(backup ? { backup } : {}),
      },
      {
        warning: rolledBack
          ? undefined
          : `The platform stores refused code anyway and the automatic rollback failed. Restore now: update_transformer with codeFromFile set to the backup's code file${backup ? ` (${backup.codeFile})` : ""}, and the earlier switches from the backup JSON.`,
        action: rolledBack
          ? "The previous transformer was put back and checked. Fix the code and try again."
          : "Restore the backup now.",
      },
    );
  }

  const after: any = (await readEndpoint(api, data.endpointId))?.transformer;
  const mismatches: string[] = [];
  for (const flag of Object.keys(flagChanges) as Flag[]) {
    if (after?.[flag] !== flagChanges[flag]) mismatches.push(flag);
  }
  if (hasCodeChange) {
    if (after?.transformer !== newCode) mismatches.push("transformer");
  }
  // What the endpoint will run is the platform's own transpiled output.
  const executedProblem = hasCodeChange
    ? syntaxError(String(after?.transpiledTransformer ?? ""))
    : null;

  const result: Record<string, unknown> = {
    updated: true,
    endpointId: data.endpointId,
    verified: mismatches.length === 0 && !executedProblem,
    ...(mismatches.length ? { mismatches } : {}),
    changed: [
      ...Object.keys(flagChanges),
      ...(hasCodeChange ? ["transformer", "transpiledTransformer"] : []),
    ],
    before: summarize(transformer),
    after: summarize(after),
    ...(backup ? { backup } : {}),
  };
  return withHints(result, {
    warning: executedProblem
      ? `The code the platform will run does not parse (${executedProblem}). Restore the backup now (codeFromFile: the backup's code file).`
      : mismatches.length
        ? "The platform returned different values than were sent; compare before and after."
        : undefined,
    action:
      "Test the endpoint with talk_to_agent. To undo, update again with codeFromFile set to the backup's code file and the earlier switches (see the backup JSON).",
  });
}
