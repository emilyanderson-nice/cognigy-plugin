---
name: flow-nodes
description: "Use when building or editing a Cognigy Flow with manage_flow_nodes or manage_flows — creating a standalone flow with no AI Agent, adding logic inside an agent's tool branch, node types and config schemas, placement rules, and rendering a flow as a diagram."
---

# Flow Node Reference

## First: which kind of flow is this?

Placement rules are opposite in the two cases, so decide before creating anything.

| | **Agent flow** (contains an `aiAgentJob` node) | **Plain flow** (no agent) |
| --- | --- | --- |
| Where nodes go | Inside tool branches, never on the top-level chain | On the top-level chain, Start → … → End |
| How to place them | `parentNodeId` = the tool node id from `create_tool`, `mode: 'appendChild'` | Omit `parentNodeId` and the node is appended to the end of the chain |
| Created by | `create_ai_agent` (provisions its own flow) | `manage_flows { operation: 'create' }` |

`manage_flow_nodes` tells the two apart itself: it looks for an `aiAgentJob` node, and in an agent flow it refuses a create with no `parentNodeId` rather than putting a node somewhere harmful.

### Agent flows: nodes live inside tools

Nodes are helpers for tools — in an agent flow they must ALWAYS be created under a tool, never as standalone pre-agent nodes.

**CRITICAL: NEVER add nodes before the AI Agent Job node.** Pre-agent nodes cause conversation loops and break the agent's ability to orchestrate. ALL logic — including authentication, data collection, greetings, and conditional behavior — must be implemented as agent tools.

### Plain flows: a normal Start → End chain

A flow with no AI Agent is an ordinary sequence — a shared subroutine called with `executeFlow`, an error handler, a classic Node-based dialog. None of the tool-branch rules apply: there is no agent to disrupt and no tool to nest under.

```
1. Create the flow — manage_flows { operation: 'create', projectId, name: 'Order Lookup' } → returns flowId + referenceId
2. Add nodes in order — manage_flow_nodes { operation: 'create', flowId, nodeType: 'say', label: 'Ask', config: { text: 'What is your order number?' } }
   ...no parentNodeId needed. Each call appends after the previous node, so nodes run in the order you wrote them.
3. Call it from elsewhere — an executeFlow node pointed at the flow's referenceId (the UUID, NOT the 24-char flowId)
```

Pass an explicit `parentNodeId` whenever you need to branch or insert rather than append — for example to put a node inside an `ifThenElse` branch.

**Voice exception — Set Session Config:** The one node that _should_ run before the AI Agent node is a `setSessionConfig` (Set Session Config) node, and only in **voice** flows. It applies per-session speech settings (barge-in, ASR, STT/TTS, input timeouts) and must be the **first** node. The `audit_voice_agent` tool checks for this and can create it by `prepend`ing before the AI Agent node. Do not add any other pre-agent nodes.

**LLM Prompt exception:** `llmPrompt` (`llmPromptV2`) is a top-level raw LLM node for flows with no AI Agent node. Create it only when the user asks for an LLM Prompt node by name; otherwise use the AI Agent default. Reading or updating existing llmPromptV2 nodes is fine. See the [LLM Prompt section](#llmprompt--llm-prompt-explicit-request-only).

## Quick Start (tool-first workflow)

```
1. Create a tool — create_tool { aiAgentId, toolType: 'tool', name: 'Process Order', config: { toolId: 'process_order', description: 'Process a customer order' } } → returns toolNodeId
2. Get the flowId — from create_ai_agent response, or list_resources { resourceType: 'flow', projectId }
3. Add a node inside the tool — manage_flow_nodes { operation: 'create', flowId, parentNodeId: '<toolNodeId>', mode: 'appendChild', nodeType: 'code', label: 'Validate Order', config: { code: '...' } }
4. Add more nodes — manage_flow_nodes { operation: 'create', flowId, parentNodeId: '<previousNodeId>', mode: 'append', nodeType: 'say', label: 'Confirm', config: { text: 'Order processed!' } }
5. List all nodes — manage_flow_nodes { operation: 'list', flowId }
6. Update a node — manage_flow_nodes { operation: 'update', flowId, nodeId: '<id>', config: { text: 'Updated!' } }
7. Delete a node — manage_flow_nodes { operation: 'delete', flowId, nodeId: '<id>' }
```

## Naming and comments

**Labels follow `<Prefix>: <what it does>`, and the plugin adds the prefix.** Pass only the descriptive part: `label: "Greeting"` on a say node is saved as `Say: Greeting`. A label that already has the right prefix is kept.

| Node | Prefix | Example |
| --- | --- | --- |
| say | `Say:` | `Say: Greeting` |
| question | `Q:` | `Q: Ask for zip` |
| code | `Code:` | `Code: Verify zip` |
| setSessionContext (Add to Context) | `ATC:` | `ATC: Store caller name` |
| Resolve Tool Action | `RTA:` | `RTA: lookup_application` |
| ifThenElse | `If:` | `If: input.verified` |
| executeFlow | `Execute:` | `Execute: Error Handler` (always the target flow's name) |
| httpRequest | `HTTP:` | `HTTP: Get slots` |
| log | `Log:` | `Log: tool call book_slot` |
| lookup (switch) | `Switch:` | `Switch: context.intent` |
| goTo | `GoTo:` | `GoTo: Handover` |
| sleep | `Wait:` | `Wait: Before retry` |
| llmPrompt | `LLM:` | `LLM: Summarize call` |
| setSessionConfig | `Config:` | `Config: Barge-in on` |
| xApp nodes | `xApp:` | `xApp: Seat picker` |

- **If nodes name what is checked:** the variable or fact the condition tests (`input.verified`, `zip matches`, `context.slots.length`), not a question like "Check VIP". Then / Else keep their default labels.
- **Tool nodes** (`aiAgentJobTool`) keep the tool name, because the LLM sees it. Then, Else and case nodes aren't prefixed.
- Nodes the plugin generates follow the same pattern: `RTA: <tool>`, `Code: <tool> pre-process`, `HTTP: <tool>`, `If: input.hasError (<code node>)`, `Log: tool call <tool>`.
- Existing nodes aren't renamed. The convention applies to what you create or relabel.

**Comments: add one only where it helps.** `comment` sets the node's Comment in the Cognigy editor, on `create` or `update` (`""` clears it). Most nodes need none; the label says enough. Add a 1-2 sentence comment when the flow is complex enough that a reader needs the *why*:
- a branch whose condition isn't obvious from the label
- an ordering dependency ("must run before the lookup — it seeds `context.mockDb`")
- a workaround or a deliberate deviation from the FRD

## Placement

- **Inside a tool (agent flows)**: Set `parentNodeId` to the tool node ID (from `create_tool`) and `mode` to `appendChild`. The handler automatically places the node in the correct execution chain (before the Resolve Tool Action node). Both `appendChild` and `append` work correctly when targeting a tool node.
- **On the main chain (plain flows only)**: Omit `parentNodeId`. The node is appended after the last node before `End`, so repeated calls build the flow in order. The response reports `anchoredAutomatically: true`. This is refused in a flow that has an AI Agent node.
- **After a sibling**: Set `parentNodeId` to an existing node within the branch and `mode` to `append` to place after it.

## Supported Node Types

> **xApp nodes** (`initAppSession`, `showXAppAdaptiveCard`, `showXAppHtml`, `setXAppState`, `getXAppSessionPin`) are also available via `manage_flow_nodes`. They build interactive HTML / Adaptive Card mini-apps. `initAppSession` must precede any other xApp node. See the `xapps` guide for details.

### say — Send Message

Category: message

Send a text message to the user. Supports rich output types.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| text | string | Yes | Message text. Supports CognigyScript: `{{context.name}}` |
| quickReplies | array | No | Quick reply buttons: `[{ title, payload }]` |
| buttons | array | No | Persistent buttons: `[{ title, type, value }]` |
| gallery | object | No | Image gallery/carousel |
| list | object | No | List output |
| audio | object | No | Audio output `{ url }` |
| video | object | No | Video output `{ url }` |
| image | object | No | Image output `{ url }` |
| adaptiveCard | object | No | Microsoft Adaptive Card JSON (the card object itself — the plugin wraps it for the Designer). `text` is still required; pass `""` for a card-only message |
| data | object | No | Custom data payload attached to the message |

**Example:**

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "nodeType": "say",
  "label": "Welcome Message",
  "config": {
    "text": "Welcome! How can I help you today?",
    "quickReplies": [
      { "title": "Check order status", "payload": "check_order" },
      { "title": "Talk to human", "payload": "handover" }
    ]
  }
}
```

---

### wait — Wait for Input

Category: logic

Stops the flow and waits for the next input, with no timeout. On that input the flow continues at the node after `wait`, using the same per-session mechanism as `question`. Unlike `question`, it stores no answer at `input.result`: read the incoming message directly (`input.text`, or `input.data` for a data payload such as a submitted Adaptive Card).

It only resumes if the session's flow state survives until the next input. It does **not** resume, and the next input starts the flow at Start, when:
- the flow is a Tool Flow, which runs once per tool call and keeps no state between turns. Tool branches under an AI Agent node run in the normal session, so they are expected to resume (not yet verified live)
- the flow is reset between turns. For example, a REST endpoint resets when the user's last flow, entrypoint or locale differs, and a new `sessionId` also starts fresh

Intended Copilot pattern: `say` (Adaptive Card with `actions`) → `wait` → nodes that read the submission from `input.data`. Resumption has not been verified end-to-end on the Copilot channel, so test the flow there (or in the Interaction Panel) before relying on it.

**Config:** none.

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "parentNodeId": "<adaptiveCardSayNodeId>",
  "mode": "append",
  "nodeType": "wait",
  "label": "Wait for Input"
}
```

---

### cxOneSendCopilotStatus — Send Status to CXone Copilot

Category: handover (extension `@cognigy/cxone`, beta; only available when the CXone Send Copilot Status feature is enabled for the organisation)

Reports the workflow outcome to CXone Agent Copilot. Without it Copilot never learns that the workflow finished or failed.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| status | string | Yes | `Complete` or `Failed` (case-sensitive) |
| data | object | No | Optional JSON object sent with the status |

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "parentNodeId": "<precedingNodeId>",
  "mode": "append",
  "nodeType": "cxOneSendCopilotStatus",
  "label": "Send Status - Complete",
  "config": { "status": "Complete" }
}
```

---

### question — Ask Question

Category: message

Ask the user a question. The answer is captured and stored.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| text | string | Yes | Question text |
| type | string | Yes | Expected answer type: `text`, `yesNo`, `email`, `number`, `date`, `intent`, `regex`, `data` |
| quickReplies | array | No | Suggested answers |
| validation | object | No | Validation rules |
| resultLocation | string | No | Where to store the answer (default: `input.result`) |

**Example:**

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "nodeType": "question",
  "label": "Ask Email",
  "config": {
    "text": "What is your email address?",
    "type": "email"
  }
}
```

---

### ifThenElse — Conditional Branch

Category: logic

Branch the flow based on a CognigyScript condition. Auto-creates `then` and `else` child nodes.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| condition | string | Yes | CognigyScript expression (without `{{ }}`), e.g. `input.intent === "order_status"` or `context.isVIP === true` |

**Example:**

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "nodeType": "ifThenElse",
  "label": "context.isVIP",
  "config": {
    "condition": "context.isVIP === true"
  }
}
```

**Adding nodes inside branches:** See [Branching nodes](#branching-nodes) below.

---

### lookup — Switch / Multi-Branch

Category: logic

Switch on intent, state, type, or a CognigyScript expression. Auto-creates `case` and `default` child nodes.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Lookup type: `intent`, `state`, `type`, `cognigyScript` |
| condition | string | No | CognigyScript expression (when type is `cognigyScript`) |

**Updating case values:** Use the `cases` convenience array on the parent switch node update — see [Updating case values](#updating-case-values) below.

**Adding nodes inside branches:** See [Branching nodes](#branching-nodes) below.

---

### setSessionContext — Set Context

Category: data

Store a key-value pair in the persistent session context. Each node stores **one** entry. To store multiple values, create multiple `setSessionContext` nodes.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| key | string | Yes | Context key name |
| value | string | Yes | Value to store. Supports CognigyScript: `{{input.result}}` |
| contextEntries | array | No | Convenience alias — `[{ key, value }]`. Only the **first** entry is used; create separate nodes for additional entries. |

**Example — using key/value directly (preferred):**

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "nodeType": "setSessionContext",
  "label": "Save User Name",
  "config": {
    "key": "userName",
    "value": "{{input.result}}"
  }
}
```

**Example — using contextEntries alias:**

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "nodeType": "setSessionContext",
  "label": "Save User Name",
  "config": {
    "contextEntries": [{ "key": "userName", "value": "{{input.result}}" }]
  }
}
```

**Note:** Only one key-value pair is stored per node. If you pass multiple entries in `contextEntries`, only the first is used. Create separate `setSessionContext` nodes for each value you need to store.

---

### code — Execute Code

Category: data

Run custom **TypeScript** (a single source string — not multiple files, not HTML). The Cognigy backend transpiles it to JavaScript at save time.

**Runtime objects available inside the code:**

| Object    | What it is                                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`   | The current input — read/write. `input.text`, `input.data`, etc.                                                                                                                                            |
| `context` | Session-persistent store. Read/write values that survive across turns — `context.x = value` persists for the session, as does `api.addToContext()`.                                                         |
| `profile` | The contact profile.                                                                                                                                                                                        |
| `api`     | The platform API — `api.say()`, `api.output()`, `api.addToContext()`, `api.log()`, `api.setNextNode()`, … ([reference](https://docs.cognigy.com/ai/for-developers/code/api-functions)). `actions.*` is the legacy alias of `api.*`; only `api` is supported. |
| modules   | Preinstalled modules are **globals**, not imports: `moment`, `_` (Lodash), `xmljs`, `getTextCleaner()` ([reference](https://docs.cognigy.com/ai/for-developers/code/modules)).                              |

**Reach for a Code node last.** If a native node or a CognigyScript field does the job, use that. See the `keep-it-simple` skill.

**Start every code node with a 1-3 line comment saying what it does.** It is the first thing someone opening the node in Cognigy reads, so say *why* the node exists, not how the code works:

```ts
// Builds the cart summary the agent reads back to the caller.
// Empty cart → empty string, so the agent can say there is nothing to order.
const items = context.cartItems || [];
```

Code that does not open with a comment is written anyway and flagged in `_hints.warning`.

**Runtime constraints — the Code Node runtime does not have these. `manage_flow_nodes` and `create_tool`/`update_tool` write the code anyway and flag them in `_hints.warning`; don't use them:**

- `api.httpRequest()` — exists only in Cognigy Functions, not Code Nodes. Use an HTTP Request node and read `input.httprequest`.
- `fetch()` / `XMLHttpRequest` — not available in the runtime. Same alternative.
- `require()` / `import` — no module loading; use the globals above.
- `api.setState()` / `api.getState()` / `api.resetState()` — States are deprecated since 2026.7 and removed in 2026.12. Use Intent Conditions.

**Documented footguns (not flagged — just know them):**

- `api.deleteContext("a.b")` — only removes **top-level** keys; a dot-path silently does nothing. Use `delete context.a.b;`.
- More than 100 `api.*` calls per execution — the platform aborts the node ([limits](https://docs.cognigy.com/ai/administer/limitations)).

Anything the platform supports is not gated: beyond the opening comment there is no required code shape, no `api.*` allowlist, and `Date.prototype.toLocaleString()` and friends work (the editor's red underline on `Date` is the browser's type checker, not a runtime error).

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| code | string | Yes | TypeScript source to execute (the backend enforces a large upper size limit) |

Server-computed, read-only (do NOT send these): `transpiled` (compiled JS output) and `hasError` (`true` if the code failed to transpile). `get` omits `transpiled` and surfaces `hasError`.

**Read before you edit.** `list` returns no config. To see a node's current code, use `get`:

```json
{ "operation": "get", "flowId": "<flowId>", "nodeId": "<nodeId>" }
```

Then send the full new `code` string on `update` (config is merged; `code` is replaced wholesale). After a write, a `_hints.warning` with `hasError` means the code did not compile — `get`, fix, and update again.

**Create example:**

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "nodeType": "code",
  "label": "Format Response",
  "config": {
    "code": "// Builds the cart summary the agent reads back to the caller.\nconst items = context.cartItems || [];\ninput.cartSummary = items.map((i: { name: string; price: number }) => `${i.name}: $${i.price}`).join('\\n');"
  }
}
```

#### Automatic error handling

Just write the code. The plugin adds the error handling itself on every
`create` and `update`, and `get` returns only your code, so there is nothing
to write, copy, or preserve.

If the code throws, the error is logged to the project logs, the trace is
written to `input.errorTrace`, `context.lastError` and `context.errors`
(appended), and `input.hasError` is set to `true`.

An **Error Guard** (`If: input.hasError (<code node>)`) is appended automatically after each code node:

```
code node
  └─ if {{input.hasError}}
       ├─ then → (empty — put the user-facing handling here)
       └─ else → (continue)
```

The guard is a **branch point, not a handler**. The error is already logged by
the automatic error handling, so nothing logs it again here — a shared
handler flow would just emit the same payload twice. What the caller should
experience belongs to the flow that failed, so fill the then-branch in that
flow: a `say`, a fallback value, a skip, a handover.

If a project does want a shared side trip (a ticket, a webhook, a
notification), pass `errorHandlerFlowId` and an Execute Flow node is added to
the then-branch. Execute Flow **returns**, so the active flow still owns the
user-facing experience afterwards. Do not use `goTo` for this — it switches
flows permanently and never comes back.

| Parameter            | Default | Effect                                              |
| -------------------- | ------- | --------------------------------------------------- |
| `errorTrace`         | `true`  | Set `false` to add no error handling at all.        |
| `errorGuard`         | `true`  | Set `false` to keep error handling but skip the guard.|
| `errorHandlerFlowId` | —       | Opt in to a shared side-trip flow in the then-branch. |

**http tools get this too, with one difference.** `create_tool { toolType: "http" }`
builds a chain — pre-process → HTTP Request → post-process → Resolve — whose
code nodes get the same error handling and guards. Their guards are NOT empty:
each writes a readable failure into the tool result, because an http tool that
fails silently answers with nothing at all (post-process never sets
`input.result`, Resolve hands the LLM an empty value, and the LLM emits no
text — an empty turn, by a different route than an uncaught throw). The guard
after the HTTP call also fires on a non-2xx status, which the HTTP Request node
reports as a status code rather than by throwing. Pass `errorGuard: false` in
the tool config to skip them.

---

### log — Log Message

Category: data

Write a line to the project logs (**Test > Logs**).

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| message | string | Yes | The line to write. Supports CognigyScript: `{{input.sessionId}}` |
| level | string | No | `info`, `debug`, or `error`. Default `debug` |

Two platform facts that decide how you use this:

- **Logs are kept for 24 hours** (the page shows the last 2 by default). Logging
  is for debugging a live conversation, never for an audit trail — anything that
  has to outlive the day belongs in an external system via an http tool.
- **`debug` entries are hidden** in the Logs list until someone enables the
  Debug filter. Use `info` for anything a person should see without being told
  to go looking; keep `debug` for detail that would be noise the rest of the
  time.

Prefer this node over `api.log()` in a Code node: it is declarative, visible in
the flow chart, editable in the UI, and cannot throw.

---

### debugMessage — Debug Message

Category: data

Writes to the Interaction Panel's debug view **only** — not to the project
logs. Useful while authoring, invisible in production.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| message | string | Yes | The text to show |
| header | string | No | A label to group it under |
| level | string | No | `info` or `error`. Default `info` |

---

## Logging practices

**Every tool call is logged automatically.** `create_tool` puts a Log node at
the **head** of each tool branch:

```
[tool-call] submit_application args=[fullName, email, phone, ssnLast4]
```

- **At the head, not the tail.** A log at the end only fires if the branch
  completes, so the calls that most need explaining — the ones that threw, hung
  or timed out — would leave no trace at all.
- **Parameter names, never values.** Tool arguments routinely carry personal
  data. The names identify the call; the values are what create the liability.
  Add your own node if you genuinely need a value, and own that decision.
- **`info` level**, so it shows up without enabling the Debug filter.
- Reads args from `input.aiAgent.toolArgs` *and* `input.llmPrompt.toolArgs` —
  under an LLM Prompt node the first is null, so a template reading only one
  logs nothing there.

Opt out per tool with `logToolCalls: false` in the tool config.

What else is worth logging, and what is not:

| Log this | Skip this |
| --- | --- |
| Branch decisions a transcript cannot explain ("chose FHA path, DTI 47%") | Anything the transcript already shows |
| An external call's outcome and status, not its payload | Full request or response bodies |
| Identifiers that correlate to another system (ticket, reference) | Credentials, tokens, full account numbers, anything personal |
| Why a guard fired | A running commentary of every node |

Code node errors are already logged by the automatic error handling — do not
add a second Log node for them, or the same failure is recorded twice.

---

### executeFlow — Execute Flow (call and return)

Category: logic

Run another flow like a function call, then **return** and continue the current
flow. Use this — not `goTo` — whenever the other flow is a subroutine (error
handling, logging, a shared verification step). Context changes made by the
target flow are visible after it returns.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| flowId | string | No | Target flow reference ID |
| nodeId | string | No | Target node ID; must be marked as an Entrypoint in the target flow |
| parseIntents | boolean | No | Re-parse intents in the target flow (default on in Cognigy) |
| parseKeyphrases | boolean | No | Re-parse slots/keyphrases in the target flow |
| absorbContext | boolean | No | Apply the target flow's default context on entry |

---

### goTo — Go To Node/Flow

Category: logic

Jump execution to another flow or a specific node. The conversation does NOT come back — for a call-and-return subroutine use `executeFlow` instead.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| flowId | string | No | Target flow reference ID (for cross-flow jumps) |
| nodeId | string | No | Target node ID within the flow |
| executionMode | string | No | `execute` (default) or `goAndDontReturn` |

---

### sleep — Wait

Category: logic

Pause execution for a duration.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| milliseconds | number | Yes | Milliseconds to wait |
| delay | number | No | Alias for `milliseconds` (supported for backward compatibility) |

---

### httpRequest — HTTP Request

Category: service

Call an external API.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| url | string | Yes | Request URL. Supports CognigyScript: `https://api.example.com/{{context.endpoint}}` |
| type | string | No | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` (default: `GET`) |
| headers | object or string | No | Headers as object `{"Authorization": "Bearer xxx"}` or JSON string |
| payloadType | string | No | `json` or `text` |
| payloadJSON | object | No | JSON body (when payloadType is `json`) |
| payloadText | string | No | Text body (when payloadType is `text`) |
| contextStore | string | No | Context key to store the response (auto-sets storage to context) |
| inputStore | string | No | Input key to store the response (auto-sets storage to input) |

**Example:**

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "nodeType": "httpRequest",
  "label": "Fetch Order",
  "config": {
    "url": "https://api.example.com/orders/{{context.orderId}}",
    "type": "GET",
    "headers": { "Authorization": "Bearer {{context.apiToken}}" },
    "contextStore": "orderData"
  }
}
```


#### CognigyScript in a JSON body — `{{ }}` vs `$cs`

There are two syntaxes and they are **not** interchangeable.

**Inline `{{ }}` always produces a string.** Correct for a string field, and
silently wrong for anything else — an API expecting `42` receives `"42"`, one
expecting an object receives `"[object Object]"`. The request usually still
sends; the types are just wrong.

```json
{ "customerName": "{{context.user.name}}" }
```

**`$cs` runs the script and converts the result**, so it is the only correct
form for a number, boolean, array or object field:

```json
{
  "customerName": { "$cs": { "script": "context.user.name" } },
  "orderId": { "$cs": { "script": "context.currentOrder.id", "type": "number" } }
}
```

Rules for the wrapper:

| | |
| --- | --- |
| `script` | Required. A **bare** expression — `context.user.name`, NOT `{{context.user.name}}`. The value inside `$cs` is already evaluated as CognigyScript. |
| `type` | Optional. `string`, `number`, `boolean`, `object`, `array`. Omit it to pass the value through unconverted. |
| Placement | `$cs` must be the ONLY key on its object. `{ "$cs": {...}, "fallback": 1 }` is invalid. |

If the referenced value does not exist, the key is skipped rather than sent as
null.

Interpolating into a sentence is a genuine string and needs no `$cs`:
`"greeting": "Hello {{context.user.name}}, welcome back"`.

The plugin reviews JSON bodies on write and returns a `_hints` warning naming
the exact path when a `$cs` wrapper is malformed, or when a whole value is a
bare `{{ }}` expression that may need a type. The node is still created — the
hint is advisory.

Reference: <https://docs.cognigy.com/ai/platform-features/cognigyscript>

---

### llmPrompt — LLM Prompt

Category: service

A raw LLM call driven by a **freeform system prompt** (`config.prompt`). Supports tools, streaming/storage options, image handling, and custom model options.

**STEERING — read first:**

- Create only when the user explicitly asks for an "LLM Prompt" node; otherwise use the AI Agent default. Do not offer it, fall back to it, or ask the user to choose.
- For a new LLM Prompt agent, use `create_ai_agent { agentNodeType: "llmPrompt", systemPrompt }`; it provisions project, flow, node, and endpoint. Use `manage_flow_nodes create` only for existing flows.
- `llmPrompt` is top-level, placed after `start` via `mode: "append"`, and can drive a flow without an aiAgentJob node.
- `prompt` is the full persona, job, and guardrail definition. Put required constraints in the prompt itself.
- The backend auto-creates a non-deletable `llmPromptDefault` branch and a placeholder tool; the plugin removes the placeholder.
- These flows have no agent resource: update prompts via `manage_flow_nodes update`, and address tools with `flowId`. Only `tool`, `mcp`, and `http` tools are supported.

**Config (key fields — `get` the node for the full set):**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| prompt | string | Yes | Freeform system prompt. Supports CognigyScript and the `@cognigyRecentConversation` / `@cognigyRecentUserInputs` transcript tags (optionally with a turn limit, e.g. `@cognigyRecentConversation:3`) |
| llmProviderReferenceId | string | No | LLM referenceId, or `"default"` for the project's Generative AI default |
| storeLocation | string | No | `stream` (stream to output), `input`, or `context` |
| immediateOutput | boolean | No | Output the result immediately — applies only with `storeLocation: "input"` or `"context"`; with `"stream"` the result already streams, so the flag is meaningless and must not be sent |
| inputKey / contextKey | string | No | Where to store the result for `input`/`context` storage (default `promptResult`) |
| chatTranscriptSteps | number | No | Previous conversation turns included in the request (default 50) |
| usePromptMode | boolean | No | Single-prompt mode — no conversation context; prompt must be non-empty |
| temperature / topP / maxTokens / frequencyPenalty / presencePenalty / seed | number | No | Sampling controls (samplingMethod picks `temperature` vs `topP`) |
| responseFormat | string | No | `default`, `text`, or `json` |
| toolChoice | string | No | `auto`, `required`, or `none` — how tools are selected |
| useStrict | boolean | No | Strict mode for tool argument schemas |
| processImages / transcriptImageHandling | boolean / string | No | Image attachment handling (`minify`, `drop`, `keep`) |
| customModelOptions / customRequestOptions | object | No | Provider-specific overrides (e.g. `{ "model": "..." }`, `{ "stream": true }`) |
| errorHandling / errorMessage / logErrorToSystem | string / string / boolean | No | `continue` (default), `stop`, or go-to error handling |

**Example (only after an explicit user request):**

```json
{
  "operation": "create",
  "flowId": "<flowId>",
  "nodeType": "llmPrompt",
  "label": "Summarize Conversation",
  "parentNodeId": "<startNodeId or preceding top-level node>",
  "mode": "append",
  "config": {
    "prompt": "A user talked to a chatbot:\n@cognigyRecentConversation\n\nSummarize the conversation in two sentences.",
    "storeLocation": "context",
    "contextKey": "summary"
  }
}
```

---

## Branching nodes

`ifThenElse` and `lookup` nodes auto-create child branch nodes when created:

- **ifThenElse** creates `then` and `else` child nodes
- **lookup** creates `case` and `default` child nodes

### Placing nodes inside a branch

To add logic inside a branch (e.g. inside the "then" branch of an if/else):

1. Create the branching node (ifThenElse or lookup)
2. List nodes to find the auto-created child IDs: `manage_flow_nodes { operation: "list", flowId }`
3. Use `mode: "append"` with `parentNodeId` set to the branch child node ID

**CRITICAL:** Do NOT use `mode: "appendChild"` on branch children (then, else, case, default). It creates orphaned nodes with `parentId: null`. Always use `mode: "append"` instead. The handler auto-corrects this when possible, but using `append` directly is the reliable approach.

### Example — add a Say node inside the "then" branch of an ifThenElse

```
Step 1: Create the ifThenElse node
manage_flow_nodes {
  operation: "create", flowId: "<flowId>",
  parentNodeId: "<toolNodeId>", mode: "appendChild",
  nodeType: "ifThenElse", label: "context.isVIP",
  config: { condition: "context.isVIP === true" }
}
→ returns nodeId: "if123..."

Step 2: List nodes to find the auto-created then/else child IDs
manage_flow_nodes { operation: "list", flowId: "<flowId>" }
→ find the "then" child node with parentId matching "if123..."
→ thenNodeId: "then456..."

Step 3: Add a node inside the "then" branch using mode: "append"
manage_flow_nodes {
  operation: "create", flowId: "<flowId>",
  parentNodeId: "then456...", mode: "append",
  nodeType: "say", label: "VIP Greeting",
  config: { text: "Welcome back, VIP!" }
}
```

### Example — add nodes inside a lookup case branch

```
Step 1: Create the lookup node
manage_flow_nodes {
  operation: "create", flowId: "<flowId>",
  parentNodeId: "<toolNodeId>", mode: "appendChild",
  nodeType: "lookup", label: "Route by Type",
  config: { type: "cognigyScript", condition: "input.category" }
}
→ returns nodeId: "switch123..."

Step 2: List nodes to find the auto-created case/default child IDs
manage_flow_nodes { operation: "list", flowId: "<flowId>" }
→ find case children with parentId matching "switch123..."
→ caseNodeId: "case456...", defaultNodeId: "default789..."

Step 3: Update case values
manage_flow_nodes {
  operation: "update", flowId: "<flowId>",
  nodeId: "switch123...",
  config: { cases: [{ id: "case456...", value: "billing" }] }
}

Step 4: Add a node inside the case branch using mode: "append"
manage_flow_nodes {
  operation: "create", flowId: "<flowId>",
  parentNodeId: "case456...", mode: "append",
  nodeType: "say", label: "Billing Help",
  config: { text: "Let me help with your billing question." }
}
```

---

## Updating case values

When you create a `lookup` (switch) node, the case child nodes start with empty values. To set what each case matches:

**Option 1 — Update via parent switch with `cases` array (recommended):**

```json
{
  "operation": "update",
  "flowId": "<flowId>",
  "nodeId": "<switchNodeId>",
  "config": {
    "cases": [
      { "id": "<caseNodeId1>", "value": "billing" },
      { "id": "<caseNodeId2>", "value": "shipping" }
    ]
  }
}
```

**Option 2 — Update individual case nodes directly:**

```json
{
  "operation": "update",
  "flowId": "<flowId>",
  "nodeId": "<caseNodeId>",
  "config": { "value": "billing" }
}
```

The handler sends the correct API format (`{ config: { case: { value: "..." } } }`) automatically.

---

## Visualizing a flow (render)

`manage_flow_nodes { operation: "render", flowId }` deterministically serializes the whole flow into a diagram. It is read-only. The engine builds the picture in code, so you never re-derive the graph (no hallucinated edges, ~0 tokens).

Returned fields:

- `ascii` — a text tree of the flow (`next` chain top-to-bottom, `children` nested). Display it inline in **any** client, including a terminal.
- `mermaid` — a `flowchart TD` string. **Deliver it ONLY as a native Mermaid/diagram artifact** (the "Download and open · MERMAID" card). This is the one form that renders zoomably and works on phones.
  - Do **NOT** wrap it in an HTML page/widget or a generic HTML "visualize" connector — an HTML-embedded diagram is not mobile-friendly.
  - Do **NOT** paste it as an inline ` ```mermaid ` fenced code block — it renders as plain text or a tiny thumbnail.
  - Keep commentary, the legend, and the ascii tree **outside** the artifact.
- `legend` — a key of only the shapes/edges present in this flow (also drawn inside the mermaid as a compact strip and in the HTML panel). Toggle with `legend: false`.

Options:

- `focus: "<nodeId>"` or `focus: ["<id1>", "<id2>"]` — highlight one or more nodes (e.g. ones you just created/edited) so the user sees how the change fits.
- `format: "ascii" | "mermaid" | "both"` (default `both`).
- `writeHtml: true` — also write a self-contained, offline rich HTML graph to a tmp file **on the user's own machine** (this MCP server runs locally) and **open it in the browser automatically**. Returns `htmlUrl` (a `file://` link) and `htmlPath`. The file is already complete on that machine — just hand the user the link; do NOT try to fetch, upload, or regenerate it. Pass `openInBrowser: false` to only get the link back without opening.

After a node create/update/delete, offer a render once, in one short line (do not render unprompted, do not repeat the offer).

---

## Notes

- **Tool parameters**: Inside AI Agent tool branches, the LLM's tool call parameters are available at `input.aiAgent.toolArgs`, **NOT** `input.data`. For example, if the tool defines a `city` parameter, access it as `input.aiAgent.toolArgs.city` in Code nodes or `{{input.aiAgent.toolArgs.city}}` in CognigyScript fields. **Under an LLM Prompt (`llmPromptV2`) node the parameters live at `input.llmPrompt.toolArgs` instead** — `input.aiAgent` is `null` there, so reading `input.aiAgent.toolArgs` returns `undefined` and the tool runs with no arguments (a silent fallback, no error). For a tool that may run under either node type, read defensively: `const args = (input.llmPrompt && input.llmPrompt.toolArgs) || (input.aiAgent && input.aiAgent.toolArgs) || {};`.
- **CognigyScript**: Use `{{expression}}` syntax in text/message fields to reference runtime data (`input`, `context`, `profile`). For condition fields (ifThenElse, lookup), use plain expressions without `{{ }}` — e.g. `context.isVIP === true`.
- **Node IDs**: All node IDs are 24-char hex strings. Get them from `manage_flow_nodes { operation: 'list' }`.
- **Ordering**: Nodes execute top-to-bottom within a branch. Use `parentNodeId` to control placement.
- **Nodes belong inside tools**: ALWAYS create a tool first (`create_tool { toolType: "tool" }`), then add nodes inside the tool branch using `parentNodeId` = toolNodeId and `mode` = `appendChild`. NEVER add standalone nodes before the AI Agent Job node — this is an anti-pattern that breaks conversations.
