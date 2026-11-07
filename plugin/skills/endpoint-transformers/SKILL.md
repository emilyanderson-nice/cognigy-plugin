---
name: endpoint-transformers
description: "Use when reading or changing the transformer of a Cognigy Endpoint (switching the input, output, final ping, notify or inject transformer on or off, abortOnError, the transformer code) or the voice call events of an endpoint (which flow runs on call completed, call failed, no input, no answer, DTMF)."
---

# Endpoint Transformers

Transformers are code on an Endpoint that changes what comes in and what goes out (`handleInput`, `handleOutput`, `handleExecutionFinished` and others). `manage_endpoint_settings` reads and changes them. It does not create or delete endpoints: use `manage_flows` (REST), `manage_webchat`, `manage_voice_gateway` and `delete_resource` for that.

## Workflow

1. Find the endpoint: `list_resources { resourceType: "endpoint", projectId }`.
2. Read it: `manage_endpoint_settings { operation: "get_transformer", endpointId, saveCodeTo: "transformer.js" }`. The result has the switches, code size and hash; the code goes into the file, not the chat.
3. Change what you need in the file, or only switch things:
   - Switches: `manage_endpoint_settings { operation: "update_transformer", endpointId, inputTransformerEnabled: true }` (also `outputTransformerEnabled`, `finalPingTransformerEnabled`, `notifyTransformerEnabled`, `injectTransformerEnabled`, `abortOnError`).
   - Code: `manage_endpoint_settings { operation: "update_transformer", endpointId, codeFromFile: "transformer.js", backupTo: "transformer-backup.json" }`.
4. Read the result: `verified: true` means the endpoint was read back and holds what was sent. `before` and `after` show the switches and the hashes.
5. Test with `talk_to_agent { endpointId }`.

## Rules that matter

- **Endpoints are not in a snapshot.** A code change therefore needs `backupTo`; the tool writes the current transformer block there first (JSON, with the switches) and the plain code next to it (`x.json` gives `x.code.js`, so `backupTo` must end in `.json`), and refuses without `backupTo`. To undo, send that code file back: `update_transformer { codeFromFile: "<backup>.code.js", ...the earlier switches from the JSON }`. The JSON file itself is not code and is refused if sent as `codeFromFile`.
- **The platform compiles on save.** You send the source (JavaScript or TypeScript). The platform type-checks and transpiles it itself and stores the executed code. A type error or a handler that returns the wrong shape comes back as an error. The platform stores the refused source anyway and leaves the executed code empty (checked on the EU trial), so the tool puts the previous block back and checks it (`rolledBack`); if that fails it warns, and you restore from the backup's code file at once. The tool also checks that the stored executed code parses.
- **Only the fields you change are sent**, so a switch-only change does not touch the code. A code change replaces the source and recompiles it; if someone edits the same endpoint in the UI between your read and your update, the update still overwrites that code, so read again right before a code change.
- A handler that compiles can still behave badly (for example swallow every answer), so test after each change.
- A switch that is off keeps its code; it just does not run.
- Which switch runs which handler (checked end to end on a REST endpoint): `handleExecutionFinished` runs with `finalPingTransformerEnabled`, not with `outputTransformerEnabled`. An edit to a handler whose switch is off has no effect, so read the answer of `talk_to_agent` or a real request after switching.
- Call events exist only on voice endpoints. On REST and Webchat the platform refuses `update_call_events` ("callEvents does not exist for channel ...") and the tool reports that as an error.
- Works on any endpoint whose read result carries a transformer block (checked: REST, Webchat v3, Voice Gateway). Other channels: read with `get_transformer` first, an endpoint without a transformer block is reported as such.

## Call events (voice endpoints)

`get_call_events` returns the configured events; `update_call_events { events: { callCompleted: { enabled: true, flowId: "<flow referenceId UUID>" } } }` changes only the events you name, all other events and settings stay. `callCompleted`, `callFailed` and `userInputTimeout` run a flow, so the tool refuses to switch them on without a `flowId` (its own safety rule; the platform would accept it). `noAnswer` and `recognizedDtmf` are stored with `enabled` only on a configured endpoint and can be switched without a flow. The platform also accepts a flow for them, but what they do with it is not confirmed, so the tool warns. Events: `callCompleted`, `callFailed`, `userInputTimeout`, `noAnswer`, `recognizedDtmf`. Pass `backupTo` to write the current events to a file first; endpoint settings are not in a snapshot. The update is read back (`verified`).
