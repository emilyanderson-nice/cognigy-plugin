#!/usr/bin/env node
/**
 * Read-only Voice Gateway probe: what does the Voice Gateway REST API return to an account API key?
 *
 *   node scripts/discovery/vg-probe.mjs [--cognigy-profile <name>] /v1/Accounts/{sid}/RecentCalls [key=value ...]
 *
 * Credentials (env.local, never printed or written):
 *   COGNIGY_VG_BASE_URL     https://<voice gateway host>
 *   COGNIGY_VG_API_KEY      Voice Gateway account API key (Account settings -> Account API keys)
 *   COGNIGY_VG_ACCOUNT_SID  optional; otherwise read in memory from the Cognigy.AI API
 *                           (GET /v2.0/organisations/voicegateway/account, profile "default")
 *
 * Safety properties, enforced here and not by convention:
 *   - GET only: the one request this script makes is axios.get. Redirects are not followed, so the
 *     bearer token cannot be sent to another host.
 *   - The path must start with /v1/Accounts/{sid}; {sid} is filled in memory. Paths that name a
 *     recording or a PCAP are refused (binary, caller audio, packet contents).
 *   - Output is a SHAPE (types, array lengths, key names); ids, numbers, hosts and times become
 *     placeholders, and any string containing a key or the account id becomes <REDACTED>.
 *   - Shape files go to docs/platform-versions/probes/vg/; the account id and call ids are masked
 *     in the stored path.
 *
 * Requires `npm run build` first (proxy handling and saved profiles come from dist/).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import axios from "axios";
import { makeRedactor } from "./redact.mjs";
import { ROOT, fail, loadProfile, readEnvVars } from "./profiles.mjs";

const OUT_DIR = join(ROOT, "docs", "platform-versions", "probes", "vg");
const SAFE_HEADERS = [
  /^content-type$/i,
  /^server$/i,
  /^www-authenticate$/i,
  /^allow$/i,
  /^retry-after$/i,
];

const argv = process.argv.slice(2);
let cognigyProfile = "default";
const pi = argv.indexOf("--cognigy-profile");
if (pi !== -1) {
  cognigyProfile = argv[pi + 1] ?? fail("--cognigy-profile needs a name");
  argv.splice(pi, 2);
}
const [pathTemplate, ...pairs] = argv;
if (!pathTemplate || !pathTemplate.startsWith("/v1/Accounts/{sid}"))
  fail("path must start with /v1/Accounts/{sid}");
if (/pcap|record/i.test(pathTemplate))
  fail("recording and PCAP paths are refused (binary, caller audio)");
const query = {};
for (const p of pairs) {
  const i = p.indexOf("=");
  if (i < 1) fail(`bad query argument "${p}" (expected key=value)`);
  query[p.slice(0, i)] = p.slice(i + 1);
}

const env = readEnvVars();
// A variable in the shell overrides env.local (used when the API host differs from the portal host).
const baseUrl = (
  process.env.COGNIGY_VG_BASE_URL ??
  env.COGNIGY_VG_BASE_URL ??
  ""
).replace(/\/+$/, "");
const vgKey = env.COGNIGY_VG_API_KEY ?? "";
if (!/^https:\/\//.test(baseUrl) || !vgKey)
  fail(
    "set COGNIGY_VG_BASE_URL (https://...) and COGNIGY_VG_API_KEY in env.local",
  );

const proxyMod = await import(
  pathToFileURL(join(ROOT, "dist", "utils", "proxy.js")).href
);

async function accountSid() {
  if (env.COGNIGY_VG_ACCOUNT_SID) return { sid: env.COGNIGY_VG_ACCOUNT_SID };
  const profile = await loadProfile(cognigyProfile);
  const url = `${profile.baseUrl}/v2.0/organisations/voicegateway/account`;
  const res = await axios.get(url, {
    headers: { "X-API-Key": profile.apiKey, Accept: "application/json" },
    timeout: 30000,
    validateStatus: () => true,
    maxRedirects: 0,
    proxy: false,
    ...proxyMod.getProxyAxiosOptions(url),
  });
  const sid = res.data?.voiceGatewayAccount;
  if (res.status !== 200 || typeof sid !== "string")
    fail(`could not read the Voice Gateway account id (HTTP ${res.status})`);
  return { sid, cognigyKey: profile.apiKey };
}

const { sid, cognigyKey } = await accountSid();

// The only Voice Gateway request this script ever makes: a GET with the bearer key.
const vgGet = (u) =>
  axios.get(u.toString(), {
    headers: { Authorization: `Bearer ${vgKey}`, Accept: "application/json" },
    timeout: 30000,
    validateStatus: () => true,
    maxRedirects: 0,
    proxy: false,
    ...proxyMod.getProxyAxiosOptions(u.toString()),
  });

// {call_sid} and {trace_id} in the path are filled in memory from the first row of the first page of
// recent calls, so a call can be followed without any id passing through the terminal or the chat.
const picked = [];
let resolvedPath = pathTemplate.replace("{sid}", sid);
if (/\{(call_sid|trace_id)\}/.test(resolvedPath)) {
  const list = new URL(`${baseUrl}/v1/Accounts/${sid}/RecentCalls`);
  list.searchParams.set("page", "1");
  list.searchParams.set("count", "25");
  const lr = await vgGet(list);
  const row = Array.isArray(lr.data?.data)
    ? lr.data.data.find((r) => r?.call_sid && r?.trace_id)
    : undefined;
  if (lr.status !== 200 || !row)
    fail(`could not pick a call from recent calls (HTTP ${lr.status})`);
  picked.push(row.call_sid, row.trace_id, row.sip_callid);
  resolvedPath = resolvedPath
    .replace("{call_sid}", row.call_sid)
    .replace("{trace_id}", row.trace_id);
}
const redactor = makeRedactor([vgKey, cognigyKey, sid, ...picked]);

const url = new URL(baseUrl + resolvedPath);
for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

// Names of spans and attributes are code identifiers; anything else is hidden. Attribute VALUES are
// never read into the output (they can hold transcript text, numbers and addresses).
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,60}$/;
function summarizeTrace(doc) {
  const names = new Map();
  const attrs = new Map();
  let spanCount = 0;
  for (const rs of doc.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? [])
      for (const sp of ss.spans ?? []) {
        spanCount++;
        const name = SAFE_NAME.test(sp?.name ?? "") ? sp.name : "<name>";
        const ms =
          (Number(sp?.endTimeUnixNano) - Number(sp?.startTimeUnixNano)) / 1e6;
        const n = names.get(name) ?? { count: 0, minMs: Infinity, maxMs: 0 };
        n.count++;
        if (Number.isFinite(ms)) {
          n.minMs = Math.min(n.minMs, ms);
          n.maxMs = Math.max(n.maxMs, ms);
        }
        names.set(name, n);
        for (const a of sp?.attributes ?? []) {
          const key = SAFE_NAME.test(a?.key ?? "") ? a.key : "<key>";
          const t = Object.keys(a?.value ?? {})[0] ?? "none";
          const set = attrs.get(key) ?? new Set();
          set.add(t);
          attrs.set(key, set);
        }
      }
  const round = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
  return {
    spanCount,
    spanNames: Object.fromEntries(
      [...names].sort().map(([k, v]) => [
        k,
        {
          count: v.count,
          minMs: round(v.minMs),
          maxMs: round(v.maxMs),
        },
      ]),
    ),
    attributeKeys: Object.fromEntries(
      [...attrs].sort().map(([k, v]) => [k, [...v].sort().join("|")]),
    ),
  };
}

const started = Date.now();
let result;
try {
  const res = await vgGet(url);
  const headers = {};
  for (const [k, v] of Object.entries(res.headers))
    headers[k] = SAFE_HEADERS.some((re) => re.test(k))
      ? redactor.scrub(String(v))
      : "<present>";
  const isJson = typeof res.data === "object" && res.data !== null;
  result = {
    status: res.status,
    ms: Date.now() - started,
    headers,
    bodyKind: isJson ? "json" : "text",
    ...(isJson && res.data.resourceSpans
      ? { traceSummary: summarizeTrace(res.data) }
      : {}),
    shapeOrText: isJson
      ? redactor.shape(res.data, "", 0, res.status >= 400)
      : redactor
          .scrub(
            String(res.data ?? "")
              .replace(/\s+/g, " ")
              .trim(),
          )
          .slice(0, 120),
  };
} catch (e) {
  result = {
    error: redactor.scrub(String(e.code || e.message)),
    ms: Date.now() - started,
  };
}

const mask = (s) =>
  [sid, ...picked]
    .filter(Boolean)
    .reduce((acc, v) => acc.replaceAll(v, "{id}"), s)
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/gi,
      "{id}",
    );
const slug = mask(
  pathTemplate +
    (Object.keys(query).length
      ? "?" + Object.keys(query).sort().join("&")
      : ""),
)
  .replace(/^\//, "")
  .replace(/[^A-Za-z0-9._-]+/g, "_");

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `${slug}.shape.json`);
const doc = {
  probedAt: new Date().toISOString(),
  host: url.host,
  method: "GET",
  path: mask(pathTemplate),
  query: Object.fromEntries(Object.keys(query).map((k) => [k, "<value>"])),
  ...result,
};
writeFileSync(file, mask(JSON.stringify(doc, null, 2)) + "\n");

console.log(
  `host=${url.host} ${result.status ?? "ERR"} ${mask(pathTemplate)} (${result.ms}ms)`,
);
console.log(
  JSON.stringify(
    result.traceSummary ?? result.shapeOrText ?? result.error,
    null,
    2,
  ).slice(0, 6000),
);
console.log(`saved: ${file}`);
