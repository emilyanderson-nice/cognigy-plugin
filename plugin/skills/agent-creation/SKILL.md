---
name: agent-creation
description: "Use when the user wants to build, create, or set up a new Cognigy AI Agent from scratch — covers listing projects, ensuring an LLM exists, creating the agent, testing it, and refining persona/job fields."
---

# Building a Cognigy AI Agent

## Prerequisites

- A project (use list_resources { resourceType: "project" } to find one, or let create_ai_agent create one)
- A working LLM resource in the target project before testing the agent

## Steps

1. list_resources { resourceType: "project" } — inspect all projects
2. Choose the target project
   - If it already exists: use its projectId
   - If the user wants a new project: call create_ai_agent without projectId, keep the returned projectId, and if llmStatus is "unknown" continue with the LLM reuse steps below before testing the agent
3. Run list_resources { resourceType: "llm_model", projectId } — check whether the target project already has a reusable LLM with a non-empty connectionId
4. If the target project has no reusable LLM, check the other projects for reusable LLMs
   - Run list_resources { resourceType: "llm_model", projectId } for each other project
   - Choose only candidates whose llm_model has a non-empty connectionId
   - Do not treat an LLM without connectionId as a valid reuse candidate
5. If another project already has a reusable LLM, transfer the required model set together with its connection resource(s):
   - manage_packages { operation: "list_exportable", projectId: "<sourceProjectId>" }
   - If this workflow will use knowledge, identify the source project's exact Knowledge Search model and embedding model before exporting anything
   - manage_packages { operation: "export", projectId: "<sourceProjectId>", resourceIds: ["<llmResourceId1>", "<llmResourceId2>", "<connectionResourceId>"], name: "llm-transfer" }
   - manage_packages { operation: "upload_and_inspect", projectId: "<targetProjectId>", filePath: "<savedTo from export>" }
   - manage_packages { operation: "import", projectId: "<targetProjectId>", packageId: "<packageId from upload_and_inspect>" }
   - list_resources { resourceType: "llm_model", projectId: "<targetProjectId>" } — verify the required models are present before testing or continuing setup
6. Only if no reusable LLM with connectionId exists, or the package transfer failed: setup_llm { projectId, provider: "openAI", modelType: "gpt-4o", apiKey }
   - With isDefault: true (the default), agents auto-use this LLM — no extra step needed.
   - Save the `referenceId` from the response if you need to assign it explicitly later.
     (See the llm-providers skill for valid provider/modelType values)
7. create_ai_agent { projectId, name, description }
   — Returns: agent, flow, endpoint, endpointId, hasToken
   — The default LLM is automatically assigned to the agent's job node. If llmStatus is "configured", no extra step is needed.
8. (Only if llmStatus is "unknown" after create) Do not test yet. First repeat steps 4-6 for the returned projectId, then assign LLM to agent if needed:
   update_ai_agent { aiAgentId, jobConfig: { llmProviderReferenceId: "<referenceId from step 4 or 5>" } }
9. Only after the project has a confirmed working LLM: talk_to_agent { endpointId, message }
10. Refine the agent using update_ai_agent — see "All configuration fields" below
11. Repeat 9-10 until satisfied

## Adding tools (optional)

11. create_tool { aiAgentId, toolType, name, config }
    (See the tools-setup skill for tool types and config)
12. talk_to_agent — test with tool-triggering messages
13. Repeat 8-12 until satisfied

Important: before creating a new tool, inspect the existing agent flow/tools first and make sure you are not reusing an existing `toolId`. Tool IDs must be unique within an agent flow.

## All configuration fields (update_ai_agent)

update_ai_agent updates two layers: the **AI Agent resource** and the **AI Agent Job Node**.

Write every prompt field with the **agent-prompts** skill: it shows which section goes in which field, and the writing rules.

### Agent-level fields (the agent's identity)

| Field        | Purpose                                                                                                   | Example                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| name         | Agent display name                      | "Maya"                                                                                                        |
| description  | **Persona** (max 1000 chars) — who the agent is, who it serves, personality as behaviors. Prose, no lists | "You are the order assistant for Acme Outdoor's online store. You help customers track orders and start..." |
| instructions | **Communication and guardrails** — `## Communication` and `## Guardrails` sections with bullets          | "## Guardrails\n- Help only with Acme Outdoor orders, returns and products..."                               |

### Job-level fields (jobConfig — how the agent performs its job)

| Field                  | Purpose                                                                                                      | Example                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| jobName                | **Job title** — the role the agent is performing                                                             | "Order assistant"                                                                             |
| jobDescription         | **Goal and scope** — prose naming every topic in scope and what goes elsewhere    | "You handle order tracking, returns within 30 days and product questions. Payment disputes..." |
| jobInstructions        | **How to do the job** — `##` sections: conversation flow, using tools, when something goes wrong, handing over | "## Conversation flow\n1. Find out what the customer needs.\n..."                           |
| llmProviderReferenceId | Which LLM the agent uses (from setup_llm or list_resources { resourceType: "llm_model" })                    | "abc-123-def-456"                                                                             |
| temperature            | LLM temperature (0-1). Lower = more deterministic, higher = more creative. Default: 0.7                      | 0.3                                                                                           |
| maxTokens              | Max tokens for LLM response (100-8000). Default: 4000                                                        | 2000                                                                                          |

The agent-prompts skill has a full example for a chat agent and a voice agent.

### How the fields work together

- **description** (persona): "Who am I, who do I serve, how do I come across?"
- **instructions**: "How do I communicate, and what are my limits?"
- **jobName** / **jobDescription**: "What is my job, and what does it cover?"
- **jobInstructions**: "How do I do it?" — the flow (numbered only when it's a real sequence), tool use, failures, handover
- **tool descriptions**: "What does this tool do, and when do I use it?"
- **temperature/maxTokens**: "How do I think?" — LLM generation parameters

Each fact lives in one field. Fill the fields the agent needs; don't repeat a rule across fields or restate what the tool descriptions already say.

### Check that the agent and its tools agree

After you create or change a tool, or edit the agent's `instructions`, `jobDescription` or `jobInstructions`, read the agent's instruction fields and every tool's description side by side. Look for rules that contradict each other, especially:

- whether the user must be authenticated or authorized before a tool is used
- who may see which data
- when to escalate to a human
- which parameters are required
- language or tone

State each rule once, normally in the agent's global `instructions`, and edit the tool descriptions to match. Do not leave two versions of a rule and rely on ordering.

Example: the `instructions` say knowledge lookups need no authorization, but the knowledge tool's description says the user must be authorized first. The agent then dithers: it tries to authorize the user, answers inconsistently, or claims it has no knowledge and offers to escalate. Fix it by deciding the rule once, stating it in `instructions`, and making the tool description say the same.

Then test both paths with `talk_to_agent`: one question before authorization and one after.

## LLM Prompt node — explicit request ONLY

Use the **LLM Prompt** node only when the user asks for it by name, e.g. "create an agent using an LLM Prompt node." Otherwise, build agents with the AI Agent node.

When (and only when) the user explicitly asked for it:

- New agent: `create_ai_agent { name, agentNodeType: "llmPrompt", systemPrompt: "..." }` — provisions project + flow + LLM Prompt node + REST endpoint. There is NO agent resource in this mode.
- `systemPrompt` is the full persona, job, and guardrail definition.
- Iterate with `manage_flow_nodes { operation: "update", flowId, nodeId, config: { prompt } }` — NOT update_ai_agent (there is no agent to update).
- Tools: `create_tool { flowId, ... }` (only tool/mcp/http types). Test with `talk_to_agent { endpointId }`.

## Key facts

- create_ai_agent auto-provisions: flow, AI Agent Job Node, REST endpoint
- If the target project was just auto-created and llmStatus is "unknown", immediately inspect other projects for reusable llm_model entries with connectionId before falling back to setup_llm.
- Cognigy connections are project-scoped. If you want to reuse LLMs from another project, import the required model set and their distinct connection resource(s) via manage_packages before testing the agent.
- For knowledge workflows, do not guess with the agent response model for Knowledge Search. Import the source project's exact Knowledge Search model into the target project before the first Knowledge AI settings attempt.
- create_tool auto-provisions: flow nodes for tools. Do NOT create tool nodes manually.
- Duplicate `toolId` values can cause empty or failed responses. Check the flow/tools before assuming the problem is the LLM or connection.
- **Knowledge**: Always attach knowledge stores as tools (via create_tool { toolType: "knowledge" } or knowledgeStoreReferenceId on create_ai_agent). Knowledge tools give the agent a dedicated search capability. Only attach to the persona (via update_ai_agent) if the user explicitly requests persona-level knowledge.
- **Changing an EXISTING agent**: the first such change in a session is HELD by the server and returns `error: "backup_not_offered"` without changing anything. Ask the user whether they want a backup, then call `manage_snapshots { operation: "create", projectId, label }` or `{ operation: "decline", projectId }`, then retry the held call — see the snapshot-backups skill. This does NOT fire for an agent you created in this same session, so the build flow above is unaffected.
- If LLM setup failed or could not be completed, do not call talk_to_agent at all — testing without a confirmed working LLM fails silently or returns empty responses. Skip the test and tell the user what is missing.
- Use same sessionId across talk_to_agent calls for multi-turn testing
- Endpoints live on a different host (endpoint-\*.cognigy.ai) than the API; talk_to_agent builds the address itself from `endpointId`
- An endpoint's URL token is a credential (anyone holding it can message the endpoint), so `list_resources` and `get_resource` show `hasToken` instead. Pass `revealToken: true` only when a URL is really needed, and never paste it into prompts or files
- talk_to_agent sends in Cognigy Endpoint Test Mode by default, so test messages are not counted as billable; the response reports `testMode` and `endpointId`, never an endpoint URL. It never falls back to a billable send on its own. If a send fails, read `_hints` and check whether the message was processed before re-sending it (see the troubleshooting skill). Cognigy documents a fair-use limit of 600 test messages per hour (scope unspecified).
