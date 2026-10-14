#!/usr/bin/env node
/**
 * Read-only platform probe for v2/v4 discovery.
 *
 *   node scripts/discovery/probe.mjs <profile> <path> [key=value ...]
 *   node scripts/discovery/probe.mjs <profile> --preset baseline
 *
 * Safety properties (all enforced in this file, not by convention):
 *   - GET only: the only HTTP call made is axios.get. There is no code path for another method.
 *   - Credentials come from env.local (COGNIGY_PROFILE_<NAME>_*), parsed here; values are never
 *     printed or written. Any string containing the API key is replaced with <REDACTED>.
 *   - Output is a SHAPE of the response (types, array lengths, key names), not its data. Only values of
 *     a small allowlist of structural keys (type, status, version, ...) are kept. IDs, names, emails,
 *     URLs, and datetimes are replaced with placeholders.
 *   - Shape files go to docs/platform-versions/probes/<profile>/. Raw OpenAPI documents (public API
 *     surface, can be large) go to the scratchpad directory given by PROBE_RAW_DIR, never the repo.
 *
 * Reuses the plugin's own proxy handling (dist/utils/proxy.js) so requests route like the engine's do.
 * Requires `npm run build` first.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_FILE =
  [".env.local", "env.local"].map((n) => join(ROOT, n)).find(existsSync) ||
  join(ROOT, ".env.local");
const OUT_ROOT = join(ROOT, "docs", "platform-versions", "probes");
const RAW_DIR = process.env.PROBE_RAW_DIR || null;

const SAFE_VALUE_KEYS = new Set([
  "type",
  "_type",
  "status",
  "version",
  "apiVersion",
  "kind",
  "mode",
  "state",
  "provider",
  "role",
  "resourceType",
  "nodeType",
  "locale",
  "code",
  "title",
  "next",
  "prev",
]);
const SAFE_HEADERS = [
  /^content-type$/i,
  /^server$/i,
  /^x-powered-by$/i,
  /^www-authenticate$/i,
  /version/i,
  /^x-cognigy/i,
  /^retry-after$/i,
  /^via$/i,
  /^allow$/i,
  /^api-/i,
];

function loadProfile(name) {
  if (!existsSync(ENV_FILE)) fail(`env.local not found at ${ENV_FILE}`);
  const vars = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#"))
      vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const prefix = `COGNIGY_PROFILE_${name.toUpperCase().replace(/-/g, "_")}_`;
  const baseUrl = vars[`${prefix}API_BASE_URL`];
  const apiKey = vars[`${prefix}API_KEY`];
  if (!baseUrl || !apiKey)
    fail(
      `profile "${name}": API_BASE_URL and API_KEY must both be set in env.local`,
    );
  return {
    name,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    declaredVersion: vars[`${prefix}PLATFORM_VERSION`],
  };
}

function fail(msg) {
  console.error(`probe: ${msg}`);
  process.exit(2);
}

// Union of two shapes: objects merge key-wise, differing leaves become "a|b" so no variant is lost.
function mergeShapes(a, b) {
  if (a === b) return a;
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b))
      out[k] = k in a ? mergeShapes(a[k], v) : v;
    return out;
  }
  if (typeof a === "string" && typeof b === "string") {
    const parts = new Set([...a.split("|"), ...b.split("|")]);
    return [...parts].slice(0, 8).join("|");
  }
  return a;
}

function makeRedactor(apiKey) {
  const scrub = (s) => (s.includes(apiKey) ? "<REDACTED>" : s);
  const classify = (s, key) => {
    if (/^[0-9a-f]{24}$/i.test(s)) return "<objectId>";
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    )
      return "<uuid>";
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return "<datetime>";
    if (/@[^\s]+\.[^\s]+/.test(s)) return "<email>";
    if (/^https?:\/\//i.test(s)) return "<url>";
    if (SAFE_VALUE_KEYS.has(key) && s.length <= 60) return s;
    return `<string:${s.length}>`;
  };
  const shape = (v, key = "", depth = 0, isError = false) => {
    if (v === null) return "null";
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "number") return "number";
    if (typeof v === "string")
      return isError && key === "detail" && v.length <= 200
        ? scrub(v)
        : classify(scrub(v), key);
    if (depth >= 8) return "<depth-limit>";
    if (Array.isArray(v))
      return {
        _array: v.length,
        _item: v.length ? shape(v[0], key, depth + 1) : null,
      };
    if (typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).slice(0, 80))
        out[k] = shape(v[k], k, depth + 1, isError);
      if (Object.keys(v).length > 80)
        out._truncatedKeys = Object.keys(v).length - 80;
      return out;
    }
    return typeof v;
  };
  return { shape, scrub };
}

async function probeOnce(profile, path, query, redactor) {
  const proxyMod = await import(
    pathToUrl(join(ROOT, "dist", "utils", "proxy.js"))
  );
  const url = new URL(profile.baseUrl + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const started = Date.now();
  const cfg = {
    headers: { "X-API-Key": profile.apiKey, Accept: "application/json" },
    timeout: 30000,
    validateStatus: () => true,
    proxy: false,
    ...proxyMod.getProxyAxiosOptions(url.toString()),
    beforeRedirect: proxyMod.applyProxyToRedirect,
  };
  let res;
  try {
    res = await axios.get(url.toString(), cfg); // the ONLY request this script ever makes
  } catch (e) {
    return {
      path,
      query,
      error: redactor.scrub(String(e.code || e.message)),
      ms: Date.now() - started,
    };
  }
  const headers = {};
  for (const [k, v] of Object.entries(res.headers)) {
    headers[k] = SAFE_HEADERS.some((re) => re.test(k))
      ? redactor.scrub(String(v))
      : "<present>";
  }
  let body = res.data;
  let bodyKind = "json";
  let links;
  if (typeof body === "string") {
    bodyKind = "text";
    if (process.env.PROBE_LINKS) {
      links = [
        ...new Set(
          [
            ...body.matchAll(
              /(?:src|href|url|spec-url)\s*[=:]\s*["']([^"']+)["']/gi,
            ),
          ]
            .map((m) => m[1])
            .filter((u) => !u.startsWith("data:")),
        ),
      ]
        .slice(0, 40)
        .map((u) => redactor.scrub(u));
    }
    body = redactor
      .scrub(body.replace(/\s+/g, " ").trim())
      .slice(0, Number(process.env.PROBE_TEXT_LIMIT) || 120);
  }
  return {
    path,
    query,
    status: res.status,
    ms: Date.now() - started,
    headers,
    bodyKind,
    raw: res.data,
    links,
    shapeOrText:
      bodyKind === "json"
        ? redactor.shape(res.data, "", 0, res.status >= 400)
        : body,
  };
}

const maskQuery = (q) =>
  Object.fromEntries(
    Object.entries(q).map(([k, v]) => [
      k,
      /^[0-9a-f]{24}$/i.test(v) ? "<objectId>" : v,
    ]),
  );
const pathToUrl = (p) => new URL(`file:///${p.replace(/\\/g, "/")}`).href;
const slug = (path, query) =>
  (
    path +
    (Object.keys(query).length ? "?" + Object.keys(query).sort().join("&") : "")
  )
    .replace(/^\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_");

function record(profile, result) {
  const { raw, ...publicPart } = result;
  const dir = join(OUT_ROOT, profile.name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug(result.path, result.query)}.shape.json`);
  const doc = {
    probedAt: new Date().toISOString(),
    profile: profile.name,
    host: new URL(profile.baseUrl).host,
    declaredVersion: profile.declaredVersion || null,
    method: "GET",
    ...publicPart,
    query: maskQuery(publicPart.query),
  };
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return file;
}

function summarizeOpenApi(raw) {
  if (!raw || typeof raw !== "object" || !raw.paths) return null;
  return {
    title: raw.info?.title,
    version: raw.info?.version,
    openapi: raw.openapi || raw.swagger,
    pathCount: Object.keys(raw.paths).length,
  };
}

function line(r) {
  const q = maskQuery(r.query);
  return `${r.status ?? "ERR"} ${r.path}${Object.keys(q).length ? "?" + decodeURIComponent(new URLSearchParams(q).toString()) : ""} (${r.ms}ms) ${r.error ? r.error : ""}`;
}

async function runPreset(profile, redactor) {
  const results = [];
  const run = async (p, q = {}) => {
    const r = await probeOnce(profile, p, q, redactor);
    results.push(r);
    record(profile, r);
    console.log(line(r));
    return r;
  };
  const spec = await run("/v2.0/openapi");
  const sum = spec.status === 200 ? summarizeOpenApi(spec.raw) : null;
  if (sum) {
    console.log("  openapi:", JSON.stringify(sum));
    if (RAW_DIR) {
      mkdirSync(RAW_DIR, { recursive: true });
      writeFileSync(
        join(RAW_DIR, `${profile.name}.openapi.json`),
        JSON.stringify(spec.raw),
      );
      console.log(
        `  raw spec saved outside repo: ${join(RAW_DIR, profile.name + ".openapi.json")}`,
      );
    }
  }
  const projects = await run("/v2.0/projects", {
    limit: process.env.PROBE_LIMIT || "1",
  });
  const projectId =
    projects.status === 200 ? projects.raw?.items?.[0]?._id : undefined;
  await run("/v2.0/locales", { limit: "1" });
  if (projectId) {
    for (const p of [
      "aiagents",
      "flows",
      "endpoints",
      "largelanguagemodels",
      "knowledgestores",
      "connections",
    ]) {
      await run(`/v2.0/${p}`, {
        projectId,
        limit: process.env.PROBE_LIMIT || "1",
      });
    }
  } else {
    console.log("  (no projectId obtained: project-scoped probes skipped)");
  }
  await run("/v2.0/auditevents", { limit: "1" });
  return results;
}

const [profileName, ...rest] = process.argv.slice(2);
if (!profileName)
  fail(
    "usage: probe.mjs <profile> <path> [k=v ...] | <profile> --preset baseline",
  );
const profile = loadProfile(profileName);
const redactor = makeRedactor(profile.apiKey);
console.log(
  `profile=${profile.name} host=${new URL(profile.baseUrl).host} declaredVersion=${profile.declaredVersion || "-"}`,
);

if (rest[0] === "--preset") {
  if (rest[1] !== "baseline") fail(`unknown preset "${rest[1]}"`);
  await runPreset(profile, redactor);
} else {
  const [path, ...kv] = rest;
  if (!path || !path.startsWith("/")) fail("path must start with /");
  const query = Object.fromEntries(
    kv.map((s) => s.split(/=(.*)/s).slice(0, 2)),
  );
  const r = await probeOnce(profile, path, query, redactor);
  const file = process.env.PROBE_SAVE_RAW
    ? "(not recorded: raw document mode)"
    : record(profile, r);
  console.log(line(r));
  if (
    process.env.PROBE_SAVE_RAW &&
    RAW_DIR &&
    r.status === 200 &&
    r.raw &&
    typeof r.raw === "object"
  ) {
    mkdirSync(RAW_DIR, { recursive: true });
    const f = join(RAW_DIR, process.env.PROBE_SAVE_RAW);
    writeFileSync(f, JSON.stringify(r.raw));
    console.log(
      "raw saved outside repo:",
      f,
      "| openapi summary:",
      JSON.stringify(summarizeOpenApi(r.raw)),
    );
  }
  if (r.links) console.log("links:", JSON.stringify(r.links, null, 1));
  else console.log(JSON.stringify(r.shapeOrText, null, 2).slice(0, 4000));
  console.log(`saved: ${file}`);
}
