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
import {
  ENGINE_NPX_FLAGS,
  FORK_ENGINE_SPEC,
  replaceForkSpec,
} from "./fork-identity.mjs";

// Marketplace identity belongs to this fork, so its hunks keep OUR side.
const KEEP_OURS = new Set([".claude-plugin/marketplace.json"]);

const NPM_ALIAS_RE = /"cognigy-engine@npm:@cognigy\/plugin-engine@[^"]*"/g;
const MARKER_RE = /^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m;

const SPEC_ELEMENT = JSON.stringify(FORK_ENGINE_SPEC);
const FLAG_ELEMENTS = ENGINE_NPX_FLAGS.map((f) => JSON.stringify(f));

/**
 * Find every array in `text`, string-aware (brackets inside JSON strings are
 * ignored). Each result has the array's top-level elements as source spans and
 * whether any element is itself an array.
 */
function scanArrays(text) {
  const arrays = [];
  const frames = [];
  const top = () => frames[frames.length - 1];
  const closeElement = (frame, end) => {
    if (frame.elemStart === null) return;
    const raw = text.slice(frame.elemStart, end);
    const trimmed = raw.trimEnd();
    frame.elements.push({
      text: trimmed,
      start: frame.elemStart,
      end: frame.elemStart + trimmed.length,
    });
    frame.elemStart = null;
  };
  const beginElement = (i) => {
    const frame = top();
    if (frame && frame.isArray && frame.elemStart === null) frame.elemStart = i;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      beginElement(i);
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      i = j;
    } else if (ch === "[" || ch === "{") {
      beginElement(i);
      if (ch === "[" && top()?.isArray) top().nested = true;
      frames.push({
        isArray: ch === "[",
        start: i,
        elements: [],
        elemStart: null,
        nested: false,
      });
    } else if (ch === "]" || ch === "}") {
      const frame = frames.pop();
      if (!frame) continue;
      if (frame.isArray) {
        closeElement(frame, i);
        arrays.push(frame);
      }
    } else if (ch === ",") {
      if (top()?.isArray) closeElement(top(), i);
    } else if (!/\s/.test(ch)) {
      beginElement(i);
    }
  }
  return arrays;
}

/**
 * Upstream's side launches the engine without the npx flags this fork needs.
 * An engine launch is an args array where "-p" is immediately followed by the
 * fork spec. Its flags must come first; they are inserted if absent, reusing
 * the separator after the array's first element so single-line, multi-line and
 * CRLF layouts survive. Any other array holding the spec is left alone.
 */
function ensureEngineFlags(text) {
  const edits = [];
  for (const array of scanArrays(text)) {
    const texts = array.elements.map((e) => e.text);
    const isLaunch = texts.some(
      (t, i) => t === '"-p"' && texts[i + 1] === SPEC_ELEMENT,
    );
    if (!isLaunch) continue;
    if (array.nested) {
      throw new Error(
        "Cannot add --allow-git=root: the engine launch args array contains a nested array; fix the args by hand.",
      );
    }
    const leading = texts.slice(0, FLAG_ELEMENTS.length);
    if (FLAG_ELEMENTS.every((f, i) => leading[i] === f)) continue;
    if (FLAG_ELEMENTS.some((f) => texts.includes(f))) {
      throw new Error(
        `The engine launch args hold ${ENGINE_NPX_FLAGS.join(" ")} but not first; npx needs it as the first argument. Move it by hand.`,
      );
    }
    const [first] = array.elements;
    const sep = /^\s*,\s*/.exec(text.slice(first.end))?.[0];
    if (!sep) {
      throw new Error(
        "Cannot add --allow-git=root: the engine launch args array has a single element; fix the args by hand.",
      );
    }
    edits.push([first.start, FLAG_ELEMENTS.join(sep) + sep]);
  }
  let out = text;
  for (const [at, insert] of edits.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, at) + insert + out.slice(at);
  }
  return out;
}

/**
 * Walk `src` line by line. Returns the text with every COMPLETE hunk replaced
 * by the chosen side (1 = ours, 2 = theirs) and the number of such hunks.
 * Unterminated hunks are left untouched.
 */
function walkHunks(src, side, pick) {
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
    out.push(...(pick ? pick(ours, theirs) : side === 1 ? ours : theirs));
    i = end + 1;
  }
  return { text: out.join(""), hunks };
}

const PREPARE_LINE_RE = /^\s*"prepare"\s*:/;

/**
 * package.json hunk resolver: take THEIRS, except the `"prepare"` script keeps
 * OUR value. Upstream's is `husky`; the fork's is `node scripts/prepare.mjs`,
 * which builds dist/ when the engine is installed straight from GitHub, so
 * taking theirs would break every install. If theirs dropped the entry, ours is
 * appended, fixing trailing commas so the JSON stays valid.
 */
function pickKeepingOurPrepare(ours, theirs) {
  const ourPrepare = ours.find((l) => PREPARE_LINE_RE.test(l));
  if (ourPrepare === undefined) return theirs;
  const eolOf = (l) => /\r?\n$/.exec(l)?.[0] ?? "";
  const bodyOf = (l) => l.replace(/\r?\n$/, "");
  const hasComma = (l) => /,\s*$/.test(bodyOf(l));
  const withComma = (l, comma) =>
    bodyOf(l).replace(/,\s*$/, "") + (comma ? "," : "") + eolOf(l);

  const at = theirs.findIndex((l) => PREPARE_LINE_RE.test(l));
  if (at !== -1) {
    const out = [...theirs];
    // Our value, but theirs' trailing comma and line ending.
    out[at] =
      bodyOf(withComma(ourPrepare, hasComma(theirs[at]))) + eolOf(theirs[at]);
    return out;
  }
  if (theirs.length === 0) return [ourPrepare];
  const eol = eolOf(theirs[theirs.length - 1]) || eolOf(ourPrepare) || "\n";
  const out = [...theirs];
  const last = out.length - 1;
  const ourComma = hasComma(ourPrepare);
  out[last] = withComma(out[last] + (eolOf(out[last]) ? "" : eol), true);
  out.push(bodyOf(withComma(ourPrepare, ourComma)) + eol);
  return out;
}

/** Number of complete conflict hunks in `src`. */
export function countHunks(src) {
  return walkHunks(src, 2).hunks;
}

/** Resolve every conflict hunk in `src` for manifest `file` and normalise the engine spec. */
export function resolveManifestText(file, src) {
  const name = String(file).replace(/\\/g, "/");
  const side = KEEP_OURS.has(name) ? 1 : 2;
  const pick =
    name.split("/").pop() === "package.json"
      ? pickKeepingOurPrepare
      : undefined;
  let out = walkHunks(src, side, pick).text;

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

  out = ensureEngineFlags(out);

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
