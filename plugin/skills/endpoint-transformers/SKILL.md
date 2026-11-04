---
name: endpoint-transformers
description: "Use when reading or changing the transformer of a Cognigy Endpoint: switching the input, output, final ping, notify or inject transformer on or off, setting abortOnError, or replacing the transformer code."
---

# Endpoint Transformers

Transformers are code on an Endpoint that changes what comes in and what goes out (`handleInput`, `handleOutput`, `handleExecutionFinished` and others). `manage_endpoints` reads and changes them. It does not create or delete endpoints: use `manage_flows` (REST), `manage_webchat`, `manage_voice_gateway` and `delete_resource` for that.

## Workflow

1. Find the endpoint: `list_resources { resourceType: "endpoint", projectId }`.
2. Read it: `manage_endpoints { operation: "get_transformer", endpointId, saveCodeTo: "transformer.js" }`. The result has the switches, code size and hash; the code goes into the file, not the chat.
3. Change what you need in the file, or only switch things:
   - Switches: `manage_endpoints { operation: "update_transformer", endpointId, inputTransformerEnabled: true }` (also `outputTransformerEnabled`, `finalPingTransformerEnabled`, `notifyTransformerEnabled`, `injectTransformerEnabled`, `abortOnError`).
   - Code: `manage_endpoints { operation: "update_transformer", endpointId, codeFromFile: "transformer.js", backupTo: "transformer-backup.json" }`.
4. Read the result: `verified: true` means the endpoint was read back and holds what was sent. `before` and `after` show the switches and the hashes.
5. Test with `talk_to_agent { endpointId }`.

## Rules that matter

- **Endpoints are not in a snapshot.** A code change therefore needs `backupTo`; the tool writes the current transformer block there first and refuses without it. To undo, send the code from that file again with the earlier switches.
- **The platform transpiles on save.** You send the source; the platform stores the executed code itself (checked on the EU trial: comments are dropped). The tool checks locally that the code parses as plain JavaScript and refuses otherwise. Code with type annotations needs `transpiledCode` (the type-free version), which is then checked instead and sent along.
- The code is only syntax-checked (never run), and after the save the platform's own executed code is checked too; a warning says so if it does not parse. A wrong `handleOutput` that returns nothing can swallow every answer, so test after each change.
- A switch that is off keeps its code; it just does not run.
- A different channel can reject fields it does not know. Read with `get_transformer` first.
