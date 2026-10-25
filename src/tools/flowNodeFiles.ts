/**
 * File-backed variants of manage_flow_nodes get / update / compare: pick
 * fields from a node, save them to files, push file contents into a config,
 * and compare a field with a file. All file I/O goes through utils/fileAccess,
 * and no file or field content is ever returned.
 */
import {
  FileAccessError,
  readTextFile,
  resolveInRoot,
  sha256Hex,
  writeTextFile,
} from "../utils/fileAccess.js";

const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

type Obj = Record<string, any>;

const segmentsOf = (dotted: string): string[] | null => {
  const parts = dotted.split(".");
  return parts.some((p) => p === "" || UNSAFE_SEGMENTS.has(p)) ? null : parts;
};

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

/** Look up a dotted path on own properties only. */
export function getPath(
  source: Obj,
  dotted: string,
): { found: boolean; value?: unknown } {
  const parts = segmentsOf(dotted);
  if (!parts) return { found: false };
  let cur: unknown = source;
  for (const part of parts) {
    if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return { found: false };
    }
    cur = cur[part];
  }
  return { found: true, value: cur };
}

function setPath(target: Obj, dotted: string, value: unknown): void {
  const parts = segmentsOf(dotted);
  if (!parts) return;
  let cur: Obj = target;
  for (const part of parts.slice(0, -1)) {
    if (!isObj(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Every file failure becomes a fixed text; unknown errors never leak detail. */
const fileError = (err: unknown): string =>
  err instanceof FileAccessError
    ? err.message
    : "The file could not be accessed.";

/** Per-call cap on the total bytes saved by one get. */
const MAX_TOTAL_SAVED_BYTES = 10 * 1024 * 1024;

interface GetFileArgs {
  fields?: string[];
  saveTo?: Record<string, string>;
  overwrite?: boolean;
}

/** Argument check that must run before any API call; returns an error body or null. */
export function validateGetFileArgs(data: GetFileArgs): Obj | null {
  for (const key of Object.keys(data.saveTo ?? {})) {
    if (!(data.fields ?? []).includes(key)) {
      return {
        error: `saveTo key "${key}" must also be listed in fields.`,
        field: key,
      };
    }
  }
  return null;
}

/** Apply `fields` and `saveTo` to a node detail (already unwrapped). */
export async function shapeGetResult(
  detail: Obj,
  data: GetFileArgs,
): Promise<Obj> {
  if (!data.fields) return detail;

  const picked: Obj = {};
  if (detail.id !== undefined) picked.id = detail.id;
  const missing: string[] = [];
  for (const field of data.fields) {
    const hit = getPath(detail, field);
    if (hit.found) setPath(picked, field, hit.value);
    else missing.push(field);
  }

  const saveErrors: { field: string; error: string; code?: string }[] = [];
  const withheld = (
    field: string,
    error: string,
    code?: string,
    keepValue = false,
  ) => {
    // A failed save never falls back to returning the content.
    saveErrors.push({ field, error, ...(code ? { code } : {}) });
    if (!keepValue && getPath(picked, field).found) {
      setPath(picked, field, { notSaved: true });
    }
  };
  const targets = new Set<string>();
  let totalSaved = 0;
  for (const [field, file] of Object.entries(data.saveTo ?? {})) {
    const hit = getPath(picked, field);
    if (!hit.found) {
      withheld(field, "Field not found on the node.", "not_found");
      continue;
    }
    if (typeof hit.value !== "string") {
      // A number/boolean/null carries no file content; objects are withheld.
      withheld(
        field,
        "Field is not a string, so it cannot be saved to a file.",
        "not_a_string",
        !isObj(hit.value),
      );
      continue;
    }
    try {
      const target = resolveInRoot(file).toLowerCase();
      if (targets.has(target)) {
        withheld(
          field,
          "Another field is already saved to this file.",
          "duplicate_target",
        );
        continue;
      }
      const size = Buffer.byteLength(hit.value, "utf8");
      if (totalSaved + size > MAX_TOTAL_SAVED_BYTES) {
        withheld(
          field,
          "The total size saved in one call is limited to 10 MiB.",
          "total_cap",
        );
        continue;
      }
      targets.add(target);
      const saved = await writeTextFile(file, hit.value, undefined, {
        overwrite: data.overwrite === true,
      });
      totalSaved += saved.bytes;
      setPath(picked, field, {
        savedTo: saved.path,
        bytes: saved.bytes,
        sha256: saved.sha256,
      });
    } catch (err) {
      withheld(
        field,
        fileError(err),
        err instanceof FileAccessError ? err.code : "write_failed",
      );
    }
  }

  return {
    ...picked,
    ...(missing.length > 0 ? { missingFields: missing } : {}),
    ...(saveErrors.length > 0 ? { saveErrors } : {}),
  };
}

export interface ConfigFiles {
  config: Obj;
  entries: { field: string; bytes: number; sha256: string }[];
}

/** Read every configFromFiles file; returns the merged config or an error body. */
export async function readConfigFiles(
  config: Obj | undefined,
  configFromFiles: Record<string, string>,
): Promise<ConfigFiles | { error: string; field: string }> {
  for (const key of Object.keys(configFromFiles)) {
    if (config && Object.prototype.hasOwnProperty.call(config, key)) {
      return {
        error: `"${key}" is given in both config and configFromFiles.`,
        field: key,
      };
    }
  }
  const merged: Obj = { ...(config ?? {}) };
  const entries: ConfigFiles["entries"] = [];
  for (const [key, file] of Object.entries(configFromFiles)) {
    try {
      const text = await readTextFile(file);
      const buf = Buffer.from(text, "utf8");
      merged[key] = text;
      entries.push({ field: key, bytes: buf.length, sha256: sha256Hex(buf) });
    } catch (err) {
      return { error: fileError(err), field: key };
    }
  }
  return { config: merged, entries };
}

/** Compare the string at `field` of a node detail with the text of `file`. */
export async function compareFieldWithFile(
  detail: Obj,
  field: string,
  file: string,
): Promise<Obj> {
  const hit = getPath(detail, field);
  if (!hit.found) return { error: "Field not found on the node.", field };
  if (typeof hit.value !== "string") {
    return { error: "Field is not a string, so it cannot be compared.", field };
  }
  let fileText: string;
  try {
    fileText = await readTextFile(file);
  } catch (err) {
    return { error: fileError(err), field: "file" };
  }
  const live = Buffer.from(hit.value, "utf8");
  const disk = Buffer.from(fileText, "utf8");
  const equal = live.equals(disk);
  let firstDiffByte: number | null = null;
  if (!equal) {
    const shorter = Math.min(live.length, disk.length);
    firstDiffByte = shorter;
    for (let i = 0; i < shorter; i++) {
      if (live[i] !== disk[i]) {
        firstDiffByte = i;
        break;
      }
    }
  }
  return {
    equal,
    field,
    liveBytes: live.length,
    fileBytes: disk.length,
    liveSha256: sha256Hex(live),
    fileSha256: sha256Hex(disk),
    firstDiffByte,
  };
}
