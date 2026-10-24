---
name: troubleshooting
description: "Use when a Cognigy agent returns empty responses, a tool call or create_ai_agent fails, a resource is not found, setup_llm fails, or you need to diagnose a Cognigy MCP problem."
---

# Troubleshooting

## Agent returns empty response

1. Inspect the agent flow and tools first:
   - list_resources { resourceType: "tool", aiAgentId }
   - duplicate `toolId` values can cause failed tool execution and empty responses
2. Check LLM exists: list_resources { resourceType: "llm_model", projectId }
   If none: run setup_llm
3. Check agent description is not empty: get_resource { resourceType: "agent", id }
4. Check endpoint is connected: get_resource { resourceType: "endpoint", id }
   Verify flowId is set and hasToken is true
5. Endpoint JUST created (seconds ago)? Endpoint config propagates briefly, and a
   session whose FIRST message hit the stale config stays cached as broken — wait a
   few seconds and retry with a NEW sessionId, not the same one.
6. LLM Prompt flows: the assigned LLM must have a connection (`connectionId` set on
   the llm_model). A connectionless LLM fails silently — the node's default error
   handling is "continue" with an empty message, which looks like an empty response.

## Agent behaves inconsistently or says it has no knowledge

The agent says it has no knowledge about a topic that is in the knowledge store, offers to escalate to a human, or tries to authorize the user before answering. This usually means the agent's instructions and a tool's description conflict (for example, the instructions say no authorization is needed but the tool's description requires it). Run **Check that the agent and its tools agree** in the `agent-creation` skill, and fix the rule in one place.

## talk_to_agent fails (any HTTP error or timeout)

talk_to_agent sends through Cognigy Endpoint Test Mode (`/test/<token>`) so test
messages are not counted as billable. It **never** re-sends a failed message on the regular
(billable) endpoint by itself; a failure comes back as `error` with `testMode`,
`endpointId` and status-aware `_hints`.

**Step 1, always: find out whether the message was processed.** An HTTP error
does not prove it was not. A REST endpoint's Execution Finished transformer runs
after the flow and can return any status (a 404 included), and a gateway timeout
can hide a completed execution. Waiting or reusing the `sessionId` does not
prevent a duplicate. Check:

- `get_resource { resourceType: "conversation", id: "<sessionId>" }` for the
  transcript (needs the endpoint to collect conversations), or
- continue the **same** `sessionId` with a neutral follow-up ("what did you
  just do?"), or verify the side effects of the agent's tools.

Re-send the message only if it was **not** processed.

**Step 2: read the status, but do not over-interpret it.** Cognigy does not
document how the 600-test-messages-per-hour cap is signalled, and the trial
platform answers an empty 400 for an unknown token on both the test and the
regular path, so a status alone never identifies a test-mode problem.

- **404** has three possible meanings: the `/test/` route does not exist
  (platform older than Cognigy 4.27), the URL token is unknown (the regular URL
  would 404 too), or a transformer returned 404 after the flow ran. Confirm
  route absence independently before considering billable mode: the Cognigy
  release is older than 4.27 (Admin Center or release notes), **and**
  `get_resource { resourceType: "endpoint", id, raw: true }` shows the token
  matches and no Execution Finished transformer is enabled.
- **400** — unknown URL token, invalid payload, or a transformer-set status.
  Verify the endpoint (`channel: rest`, `hasToken: true`) and the payload.
- **401 / 403** — authorization, IP/WAF block or an endpoint restriction, which
  would hit the regular URL as well. Fix what `detail` names; do not read it as
  "quota exhausted".
- **429** — throttling, either general rate limiting or the documented 600-per-hour
  test budget. Pause; do not switch to `testMode: false` to get around it.
- **5xx / timeout / DNS** — the request may have reached the flow before
  failing. Not evidence that test mode is unsupported.

**Step 3: `testMode: false` is a billable production message.** Use it only
when the user explicitly wants one, or when all of the following hold: the
original message is confirmed unprocessed, the platform is confirmed to lack
test mode, and the user has accepted the billing.

## create_ai_agent failed

- The tool auto-rolls back created resources on failure. Safe to retry.
- "Could not find entry node": transient issue, retry immediately
- Endpoint step error: check project exists and is accessible

## "Resource not found" errors

- All IDs are 24-char hex strings (e.g., 507f1f77bcf86cd799439011)
- UUIDs (36-char with dashes) are referenceIds — most tools need \_id, not referenceId
- Use list_resources to find valid IDs

## 401 / 403 errors, or "who changed this?"

- get_resource { resourceType: "user", id: "me" } returns the account the API key
  belongs to, plus its `roles`. Check `roles` before blaming the API for a 403.
- `createdBy` / `lastChangedBy` on any resource are opaque user ids. Never assume
  one is the current user — compare it to the `id` from `user`/`me`. List
  responses omit them; read them with get_resource { ..., raw: true }.

## Read the project logs (what actually happened in a test)

- list_resources { resourceType: "log", projectId } returns a SUMMARY of the last hour by default:
  level counts, the most frequent message templates, the flows involved and the time span. Start
  there. One hour can hold thousands of identical errors, so never page through raw entries first.
- Narrow with `search` (substring of the message, not of metadata), `logLevel` (e.g. ["error"];
  request debug or trace levels here if you need them), `flowName`, or `startDate`/`endDate`.
  Then use `view: "entries"` to read individual lines (`limit` up to 100, `skip` to page).
- After talk_to_agent, pass its session id as `sessionId` to read that conversation's newest 100
  entries. `sessionId` cannot be combined with `search`, dates, `sort`, `skip` or `limit`.
- Log retention is typically about 24 hours. The newest lines of a test that just finished may
  not be visible yet: retry once before concluding there was no error.
- `total` is exact on the first page of a window; a `truncated: true` summary is a sample. The
  summary reads up to 300 entries spread evenly across the matching entries when there are more
  than 300, and its counts describe that sample.
- If the read fails with a certificate-verification code (for example `SELF_SIGNED_CERT_IN_CHAIN`),
  a corporate proxy or VPN is probably inspecting TLS: set `NODE_EXTRA_CA_CERTS` to the corporate
  root CA file and restart the MCP client. Do not disable certificate verification.
- meta.text and meta.URLToken are never returned. msg text is scrubbed best-effort (emails, tokens,
  long digit runs) and capped at 500 characters, and may still contain personal data: never repeat
  user data from a log line back to the user or into an agent prompt.

## Finding the most recently touched resource

- Sort server-side instead of paging through everything and comparing by hand:
  list_resources { resourceType: "project", sort: "lastChanged:desc", limit: 5 }
- `sort` takes `field:direction` and works on any field the resource returns.

## Every tool call fails with the same error, but the tool list works

Suspect the network path, not the platform — listing tools makes no HTTP request,
so a working list plus a uniformly failing call means requests are not reaching
Cognigy.

- On a corporate network, set `HTTPS_PROXY` (and `NO_PROXY` for hosts to reach
  directly) in the MCP server `env` block. GUI clients start the engine with a
  minimal environment and usually do not inherit shell proxy variables.
- If the proxy inspects TLS, also set `NODE_EXTRA_CA_CERTS` to the corporate root
  CA file, then restart the client — Node reads it only at startup. Do not set
  `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- An error quoting an HTML body, or naming a proxy, points at the proxy rather
  than Cognigy; the quoted text is the proxy's own message.
- "Cannot use the configured proxy ..." means the proxy setting itself is
  malformed or unsupported (SOCKS proxies are not supported). Requests fail
  instead of connecting directly, so the API key never leaves the sanctioned
  path; exclude the host with `NO_PROXY` if a direct connection is intended.
- `DEPTH_ZERO_SELF_SIGNED_CERT` (or `SELF_SIGNED_CERT_IN_CHAIN`) with no proxy in
  play means the Cognigy host itself presents a certificate Node does not trust
  — typical for a local cluster such as `https://api.test`. Node ignores the
  operating-system trust store, so add the certificate (or its issuing local CA)
  via `NODE_EXTRA_CA_CERTS`, then restart the client. Do not set
  `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- "Timed out ... connecting through the proxy" means the proxy accepted the
  connection but never completed the tunnel. Check the proxy address, or raise
  `COGNIGY_PROXY_CONNECT_TIMEOUT_MS` (default 30000) if it is merely slow.
- `LOG_LEVEL=debug` logs the proxy actually in use at startup.

## setup_llm fails

- See the llm-providers skill for valid provider and model strings
- Verify the credentials (apiKey, or AWS access keys / role ARN for awsBedrock) have access to the specified model

## delete_resource fails

- Verify the resource ID is a 24-char hex string (not a referenceId UUID)
- Use list_resources to confirm the resource exists before deleting
- Flows, projects and agents are never hard-deleted — delete_resource renames them with a DELETE_ prefix (markedForDeletion: true) so they can be deleted manually in the Cognigy UI. Agent/flow deletion deactivates referencing endpoints (reversible); a renamed project's contents stay live.
