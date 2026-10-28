---
name: intents
description: "Use when building, reading, importing, building (training) or benchmarking NLU intents in a Cognigy flow with manage_intents — intent hierarchies up to three levels, inherit-from-child settings, bulk example sentences, the build status and its reasons, intents below the five-sentence minimum, and comparing a flow's intents with a CSV."
---

# NLU intents with `manage_intents`

`manage_intents { operation, flowId, ... }` works on the intents of one Flow. Every call takes `environment` like the other tools.

## Operations

| Operation                                                  | Kind  | What it does                                                                                                                                                          |
| ---------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                                                     | read  | Every intent with `id`, `name`, `parentId`, `childIds`, `depth`, `childFeatures` (parents only), `priority` and the **count** of example sentences. Never the text.   |
| `get`                                                      | read  | One intent, found by id, name or `Parent/Child` path. `includeSentences: true` returns its sentences, because you asked for them.                                      |
| `export_tree`                                              | read  | The tree as one JSON object (names, parents, counts) for test evidence.                                                                                              |
| `below_minimum`                                            | read  | Intents with fewer than `min` sentences (default 5). A parent with `childFeatures: true` is checked on its `effectiveSentenceCount` (own plus its children's), and the entry also shows `ownSentenceCount`.                                                                                                                  |
| `compare`                                                  | read  | Flow intents against a CSV file: missing, extra, duplicate and wrong-count intents.                                                                                  |
| `model_state`                                              | read  | Whether the flow's model is up to date, and the intent total.                                                                                                         |
| `create`, `update`, `move`, `delete`, `import_sentences`, `build` | write | These **change the flow's NLU** and are ALL held by the backup gate (including `create`) until a backup is offered or declined. Each needs `projectId`, which must be the flow's own project (`project_mismatch` otherwise). |

Write operations need `projectId`. An intent name must be unique across the whole flow, at every level and not only among siblings (case-sensitive; the same name in another flow is fine). `create` and `update` (rename) refuse a name already used anywhere in the flow (`name_exists`, with the existing id); `move` never changes a name. A write you send first is answered with `error: "backup_not_offered"` and changes nothing: follow the `snapshot-backups` skill, then repeat the call. A snapshot covers the whole project, but whether it restores an intent's example sentences has not been verified here, so say so when you offer one.

## Limits the platform enforces

- A hierarchy is at most **3 levels** (family, group, tag). `create` and `move` refuse a fourth level, and `move` counts the deepest descendant of the moved intent.
- At most **200 example sentences per intent**. An import that would pass 200 is refused before anything is sent.
- The platform wants **at least 5 sentences** per intent (documented), counting those an intent inherits from its children when `childFeatures` is true. `list` and `export_tree` give `effectiveSentenceCount` on such parents. Fewer still works, but its quality drops and the build flags it.
- The list pages at 100. The tool reads every page itself (up to 2,000 intents) and says `truncated: true` if it could not.

## Views of `list`

`list` takes `view`: `full` (default, one object per intent), `compact` (a table: `columns` and `rows`, one shared `priority`, and grouped `reasons` with `includeStatus`) or `summary` (counts only: `byDepth`, `sentenceCounts`, `inheriting`, `states`, `reasons`, and up to 50 `attention` intents that are `low_data` or `unknown`). On a large flow (hundreds of intents) call `summary` first, then `compact` or `full` only if you need the rows. The warnings for truncated or incomplete reads apply to every view.

## Hierarchy settings

- `childFeatures: true` on a parent makes it inherit the example sentences of its children ("Inherit example sentences from child intents").
- `priority` is `"parents"` or `"children"`. It is the API field `biasTowardsParentOrChildIntents`. That it is the same setting as the UI's "Intent Mapping Priority" has not been verified.
- Name an intent by its id, its exact name, or `Parent/Child/Grandchild`. Names are matched exactly (case-sensitive). If two intents share a name the call stops with `ambiguous` and the candidate ids. Use the id or the path.
- `delete` refuses an intent that still has children (`has_children`). Delete the children first.

## Importing sentences

`import_sentences { entries: [{ intent, sentences: [...] }], mode: "add" | "replace" }`

- `add` creates the sentences that are not there yet. `replace` makes the intent's sentences exactly the list, deleting only the ones that are no longer wanted. Running the same call again changes nothing.
- Repeated sentences in the input are dropped and counted (`duplicatesDropped`).
- Everything is checked first: unknown or ambiguous intent names, the 200 cap, and `replace` with an empty list (`empty_replace`, which would wipe the intent) stop the whole call before any change. An intent that already holds more than 200 is only refused when the call would add to it.
- Sentences go in batches of 50 operations per request, one intent after another, with a time limit. `deadlineSeconds` (1-600, default 60) sets that limit. A result with `status: "partial"` lists each intent as `ok`, `failed`, `incomplete` (some batches sent, then stopped) or `not_attempted` (nothing sent); repeat the call to finish, which is safe.
- The result holds counts and ids, never sentence text.

## Importing from files (`import_csv`, `import_tree`)

For large catalogues use files in the project folder (or `COGNIGY_FILE_ROOT`, 2 MiB each) so the sentences never pass through the conversation. Both are writes (project check, backup gate) and need `projectId`.

- `import_csv { file, mode, createMissing = true, deadlineSeconds }`: the CSV has no header, three columns (intent name, `exampleSentence`, sentence). Intents missing from the flow are created as roots; an intent name that exists under several parents refuses the call (`ambiguous_intents`).
- `import_tree { specFile, sentencesFile?, mode = "add", deadlineSeconds }`: `specFile` is JSON, `{ "families": [ { "name", "intent"?, "groups": [ { "name", "intent"?, "tags": ["tag intent name", ...] } ] } ] }` (family, group, tag; `intent` overrides `name` as the Cognigy intent name; no "/" in names, at most 200 characters, at most 2000 intents). Families and groups are created with `childFeatures: true`. Every name must be unique across the whole spec, at every level (a group name may not repeat under another family, nor reappear as a tag): a repeat is `spec_invalid` (`duplicate_sibling` under one parent, `duplicate_name` elsewhere), and a name that already exists elsewhere in the flow refuses the call with `name_in_use` before anything is created. A failed create reports its HTTP status in `intents.createFailedByStatus` (a 409 means the name is taken). `sentencesFile` rows are matched to tags by name; other rows are skipped and counted. Existing parents with `childFeatures: false` are reported in `parentsNeedingChildFeatures`, not changed.
- A bad spec (`spec_invalid`) or a bad CSV row (`csv_errors`, with line numbers) refuses the whole call before anything changes.
- An intent over 200 distinct sentences is skipped and reported (`overCap`); everything else imports.
- The result holds counts and at most 20 names per list, never sentences. `status: "partial"` is repeat-safe: run the same call again and it continues where it stopped.

## Building the model

- `build { mode: "full" | "quick", waitSeconds }` starts the training task and waits up to `waitSeconds` (default 60). `status: "done"` means finished. `status: "pending"` means it was accepted and is still running: check with `model_state` later. Do not report a pending build as finished.
- `model_state` reports `upToDate` from the flow's `isTrainingOutOfDate`: `true` means edits since the last build, `false` means none. `null` was observed right after a successful build, so it most likely means no pending edits, but that is not documented; `upToDate` is then `null` too. The platform exposes **no last-trained time**, so none is reported.

## Why an intent is not scored

`list { includeStatus: true }` adds `status` to each intent from the platform's feedback report:

- `low_data`: the intent itself is named in a `lowDataIntents` finding, which fits it having too few sentences.
- `not_scored`: the intent is named only as affected; the reason lists the intents the finding names. This matches the UI tooltip "could not be scored because of Intent '...'".
- `ok`: a report with no finding.
- `unknown`: the platform returned no feedback report for the intent, so it was not evaluated.

That reading of the finding is inferred from one tenant, not documented. Treat the `reasons` as the platform's own words and check an unexpected one in the UI.

## Comparing with a CSV

`compare { flowId, file }` reads a CSV inside the project directory (or `COGNIGY_FILE_ROOT`). Format: no header row, comma separated, UTF-8, three columns per row: intent name, the literal word `exampleSentence`, the sentence. One row per sentence. Fields with commas or quotes are quoted.

The report lists intents `missing` from the flow, `extra` in the flow, `duplicateIntentNames` (a name used twice in the flow), `duplicateSentences` (the same sentence twice in one CSV intent, shown as a 40-character preview), and `wrongCount` (the CSV and the flow disagree). If some sentence counts could not be read, `uncountedIntents` names them, `countsIncomplete` is true, and they are not reported as `missing`. `below_minimum` also lists `uncountedIntents`. Bad CSV rows are counted in `parseErrors` with their line numbers.

## Rules

- Test on a scratch flow, not an existing one. The plugin cannot delete a flow (`delete_resource` only renames it with a `DELETE_` prefix), so tell the user to delete the scratch flow in the UI.
- Sentences are customer data. They are never logged or echoed in errors; show the user previews or counts, and keep exports out of commits.
- After a change to a flow's intents, run `build`, then `list` or `model_state` to check the result.
