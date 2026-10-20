/**
 * Pure conflict-resolution logic for manifest files in a merge.
 *
 * The merge source can be the previous fork or Cognigy itself, so every engine
 * spec form that may come through (the npm alias, the previous fork's spec, this
 * fork's pinned spec) is normalised to this fork's UNPINNED spec. The version
 * pin is applied afterwards by scripts/fork-version.mjs.
 *
 * Hunks may carry a diff3/zdiff3 base section; it is discarded. A result that
 * still holds a conflict marker, or a .json file that no longer parses, is an
 * error: the caller must not write it.
 */
import { FORK_ENGINE_SPEC, replaceForkSpec } from "./fork-identity.mjs";

// Marketplace identity belongs to this fork, so its hunks keep OUR side.
const KEEP_OURS = new Set([".claude-plugin/marketplace.json"]);

const NPM_ALIAS_RE = /"cognigy-engine@npm:@cognigy\/plugin-engine@[^"]*"/g;
const MARKER_RE = /^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m;

/**
 * Walk `src` line by line. Returns the text with every COMPLETE hunk replaced
 * by the chosen side (1 = ours, 2 = theirs) and the number of such hunks.
 * Unterminated hunks are left untouched.
 */
function walkHunks(src, side) {
  const lines = src.split(/(?<=\n)/);
  const out = [];
  let hunks = 0;
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<<")) {
      out.push(lines[i++]);
      continue;
    }
    const ours = [];
    const theirs = [];
    let mode = "ours";
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.startsWith("<<<<<<<")) break;
      if (mode === "ours" && l.startsWith("|||||||")) mode = "base";
      else if (mode !== "theirs" && l.startsWith("=======")) mode = "theirs";
      else if (mode === "theirs" && l.startsWith(">>>>>>>")) {
        end = j;
        break;
      } else if (mode === "ours") ours.push(l);
      else if (mode === "theirs") theirs.push(l);
    }
    if (end === -1) {
      out.push(lines[i++]);
      continue;
    }
    hunks++;
    out.push(...(side === 1 ? ours : theirs));
    i = end + 1;
  }
  return { text: out.join(""), hunks };
}

/** Number of complete conflict hunks in `src`. */
export function countHunks(src) {
  return walkHunks(src, 2).hunks;
}

/** Resolve every conflict hunk in `src` for manifest `file` and normalise the engine spec. */
export function resolveManifestText(file, src) {
  const name = String(file).replace(/\\/g, "/");
  const side = KEEP_OURS.has(name) ? 1 : 2;
  let out = walkHunks(src, side).text;

  if (MARKER_RE.test(out)) {
    throw new Error(
      `${file} still contains a conflict marker after resolving (unterminated hunk or stray marker); resolve it by hand.`,
    );
  }

  out = out.replace(NPM_ALIAS_RE, `"${FORK_ENGINE_SPEC}"`);
  out = replaceForkSpec(out, FORK_ENGINE_SPEC);

  // The alias spec is split across array entries in some manifests; collapse
  // adjacent duplicates left behind by the normalisation.
  out = out.replace(
    new RegExp(`("${FORK_ENGINE_SPEC}",\\s*)+"${FORK_ENGINE_SPEC}"`, "g"),
    `"${FORK_ENGINE_SPEC}"`,
  );

  if (name.endsWith(".json") && /^\s*[{[]/.test(out)) {
    try {
      JSON.parse(out);
    } catch (err) {
      throw new Error(
        `${file} is not valid JSON after resolving: ${err.message}`,
      );
    }
  }
  return out;
}
