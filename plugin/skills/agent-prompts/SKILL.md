---
name: agent-prompts
description: "Use whenever you write or change the text an AI Agent's LLM reads: the persona (description), instructions, jobName, jobDescription, jobInstructions, tool and parameter descriptions, or an LLM Prompt node's systemPrompt — on create_ai_agent, update_ai_agent, create_tool, update_tool. Also use to review or audit an existing agent's prompt. Covers which section goes in which field, and the writing rules (no numbering for rules that aren't steps, headings, XML, tone, tools, escalation, voice)."
---

# Writing AI Agent prompts

Every agent prompt the plugin writes follows the same layout and rules, so a
prompt reads the same whichever agent wrote it.

## Before you write

- **See what the agent actually receives.** Turn on Log System Prompt &
  Completion in the AI Agent node's Advanced settings and run a turn with
  debug on. Read it before restructuring an existing prompt.
- **Safety Settings add their own instructions** to the prompt (Cognigy
  docs). Don't restate harmful-content, copyright or jailbreak rules that a
  setting already covers; write the business guardrails.
- `jobDescription`, `jobInstructions` and tool descriptions are CognigyScript:
  `{{ }}` is evaluated. Use it on purpose (e.g. `{{context.customerTier}}`),
  never as a literal placeholder.

## Which section goes where

| Section | Field | Form |
| --- | --- | --- |
| Role: who the agent is, who it serves, for what | `description` | Prose, 2–5 sentences |
| Personality and tone, as behaviors | `description` | Prose |
| Words to use and avoid | `description` | Prose, one sentence |
| Communication standards (length, format, language) | `instructions` | `## Communication` + bullets |
| Guardrails (scope, privacy, compliance) | `instructions` | `## Guardrails` + bullets |
| Job title | `jobName` | A few words |
| Goal and scope, in and out | `jobDescription` | Prose, 2–4 sentences |
| Conversation flow, tool use, failures, handover, voice output, reference data | `jobInstructions` | `##` sections |
| What a tool does, when to use it, when not, what it needs | the tool's `description` | Prose, 1–3 sentences |
| What a value is and its format | each parameter's `description` | One line |

Each fact lives in one place. Before writing, check the fields against each
other and against the tool descriptions for repeats and contradictions. A rule
stated twice drifts into two different rules. Fill only the fields the agent
needs; an empty section is better than a padded one.

`description` is limited to 1,000 characters, and keep `instructions` near
1,000 too. Put the bulk (flow, tool use, reference data) in `jobInstructions`.

### jobInstructions sections

Use only the ones the agent needs, in this order:

```
## Conversation flow
## Answering questions        (knowledge agents, see below)
## Using tools
## When something goes wrong
## Handing over
## Voice output               (voice agents only)
## Reference                  (glossary, systems, codes, wrapped in XML)
## Examples                   (optional, wrapped in XML)
```

Refer to another section by its name ("see Handing over"), never "rule 7".

## Writing rules

- **Open with who, for whom, and what.** "You are Maya, the billing assistant
  for Acme Energy. You help existing customers check balances, set up payment
  plans and report outages."
- **Number only real sequences.** A numbered list tells the model "do these
  in this order". Rules that apply at any time are bullets. If most items
  start with "if" or "when", they are rules, not steps. Never number a list
  of capabilities, policies or tips.
- **One instruction per bullet.** "Confirm the date and then book it" drops
  the second half more often than two bullets do.
- **Say what to do.** "Answer in two short sentences" beats "Don't be
  verbose". Keep "never" for real prohibitions.
- **Give the reason when it isn't obvious.** "Read the code back character by
  character, because callers often mishear letters" lets the model handle
  cases the rule didn't name.
- **Plain, calm wording.** No ALL CAPS, "CRITICAL" or "MUST" stacks: newer
  models (GPT-4.1+, GPT-5, Claude 4+) over-apply emphasized rules. Allow
  emphasis on at most one or two hard limits.
- **Show personality as behavior.** "Acknowledge frustration in one sentence,
  then move to fixing it" beats "empathetic, friendly, professional".
- **Measurable triggers.** "Transfer after two failed lookups or when the
  caller asks for a person twice" beats "transfer when needed". Script the
  line said during the handoff, or say that the tool speaks it.
- **Sample phrases come in two or three variants, marked as samples.** Models
  repeat a single example word for word. Add "Vary it; never reuse the same
  sentence structure in one conversation."
- **Happy path first.** Write the common case, then add an edge case only
  when a test shows the agent needs it, and only after checking an existing
  rule can't cover it (see Changing an existing agent). Long prompts slow
  responses and bury the rules that matter.
- **The prompt is not a security boundary.** Anything that must never happen
  (refunds over a limit, showing another customer's data) is enforced in the
  tool or the API. The prompt only explains it to the caller.
- **Formatting carries into replies.** A prompt full of bullets nudges a
  voice agent to talk in lists. For voice, keep `description` and
  `jobDescription` in prose and state the spoken-output rules explicitly.

### Headings and XML

- `##` Markdown headings for sections, in one style throughout the prompt.
- XML tags only to wrap data or examples the model reads but doesn't follow
  as instructions: `<reference>`, `<glossary>`, `<examples>`, `<example>`.
  Lowercase, descriptive, at most two levels deep. Never wrap the whole
  prompt or each rule in tags.

### Tools

In `jobInstructions` → `## Using tools`, say when each tool is used and in
what order, by what it does ("look up the order") with its tool ID once.

- Collect the inputs first. Ask for a missing value; never guess or use a
  placeholder.
- One short line while a tool runs ("Let me pull that up."), varied, then call
  it in the same reply.
- Answer only from what the tool returned. Never say something was booked,
  sent or changed before the tool confirmed it.
- On failure: say so once, try again once, then offer the fallback (another
  way, or a person).

The tool's own `description` says what it does, when to use it and when not
to, in 1–3 sentences: "Looks up an order's status and delivery date by order
number. Use when the customer asks where an order is or when it arrives. Not
for returns; use start_return." Every parameter description says what the
value is and its format ("Order number, 8 digits, no spaces").

### Answering questions (knowledge agents)

For agents that search knowledge, use this section as written (it holds up
well in production), with the real tool ID:

```
## Answering questions
- You must *always* use a short filler statement that both acknowledges the topic/question, and buys yourself time before calling '<knowledge tool id>'.
- e.g. "Sure, I'd be happy to help with that. Let me see what I can find on {topic}, hang on tight for me!" or "Oh, yes, {topic}, let me see what I can pull up for you on that, just give me a moment!", etc.
- Never repeat the same sentence structure twice (Just a moment -> Hang on just a sec -> Let me bring that up now); vary your filler statement contextually & conversationally.
- Answer only from what the search returns. If it doesn't cover the question, say so and offer the next step (see Handing over).
```

### Voice output (voice agents only)

```
## Voice output
Your replies are spoken by a text-to-speech voice, so write the way a person talks.
- Plain sentences only: no lists, markdown, emoji, URLs or symbols.
- One to three short sentences per turn, and one question at a time.
- Say numbers the way a person would: "fifteen hundred dollars", "October fifteenth", "three p.m.".
- Read codes and account numbers back character by character, and confirm before using them.
- If you didn't catch something, ask them to say it again once; don't guess.
```

## Checklist before saving

- [ ] `description` opens with who / for whom / what, in prose, ≤ 1,000 characters
- [ ] `##` headings only in `instructions` and `jobInstructions`; `description` and `jobDescription` are prose
- [ ] No numbered list unless the order matters; no "rule N" cross-references
- [ ] Each rule appears once across all fields and tool descriptions
- [ ] No ALL CAPS or "MUST" stacks; emphasis on one or two hard limits at most
- [ ] `jobDescription` names every topic in scope
- [ ] No restated Safety Setting rules
- [ ] Every tool description says what / when / when not; every parameter has a format
- [ ] Sample phrases have two or more variants and a "vary it" line
- [ ] Voice agents have `## Voice output`

## Changing an existing agent

Every change, however small, starts from the whole prompt, not from the
behavior you just saw. A one-line patch per failed test grows the prompt and
dilutes the rules that matter.

1. Fetch the current agent and its tools (`get_resource`) right before the
   change, even if you read them earlier: someone or an earlier round may
   have changed them. Read every field end to end: `description`,
   `instructions`, `jobName`, `jobDescription`, `jobInstructions`, and each
   tool and parameter description.
2. Name the behavior to change in one line, as a general rule rather than
   the test case that showed it ("confirms details before booking", not "the
   caller in sim IT-3 said Tuesday").
3. Find what already governs it. Most fixes belong in an existing rule that
   is unclear, buried, contradicted or in the wrong field.
4. Change the prompt as a whole: reword, merge or move that rule; remove the
   rule it contradicts. Add a new bullet only when nothing covers the
   behavior, and put it in the section where it belongs.
5. Re-read the full result. Each rule appears once, and the prompt is no
   longer than it needs to be: if it grew, say by how much and why.

In your reply, show the before and after of each field you changed, not just
the added line. Make the change in the existing prompt's voice and structure.
Don't rewrite the rest to this layout unasked: list what doesn't meet the
checklist and let the user decide.

## Example: chat agent

```
update_ai_agent {
  aiAgentId: "...",
  name: "Maya",
  description: "You are the order assistant for Acme Outdoor's online store. You help customers track orders, start returns and answer product questions. You're friendly and efficient: acknowledge a problem in one sentence, then fix it. Say order, return and store credit; never ticket or RMA.",
  instructions: "## Communication\n- Keep replies to two or three sentences unless the customer asks for detail.\n- Use short paragraphs; a list only when giving three or more options.\n- Reply in the customer's language.\n\n## Guardrails\n- Help only with Acme Outdoor orders, returns and products. For anything else, say it's outside what you can help with and offer what you can do.\n- Never share another customer's details or confirm whether someone has an account.\n- Don't promise refunds, delivery dates or exceptions the tools didn't return.",
  jobConfig: {
    jobName: "Order assistant",
    jobDescription: "You handle Acme Outdoor order tracking, delivery questions, returns and exchanges within 30 days, and questions about products and sizing. Payment disputes and damaged-item claims go to the support team.",
    jobInstructions: "## Conversation flow\n1. Find out what the customer needs.\n2. For an order question, get the order number (8 digits) and look it up.\n3. Answer from the result, then ask if there's anything else.\n\n## Using tools\n- Use get_order for status and delivery dates, and start_return once the customer confirms the item and reason.\n- Say one short line before a lookup, e.g. \"Let me check that order.\" or \"One moment while I pull it up.\" Vary it.\n- If a tool fails, say so and try once more; if it fails again, offer to connect the support team.\n\n## Handing over\n- Use transfer_to_support when the customer asks for a person twice, for payment disputes and damaged items, or after two failed lookups. Say \"I'm connecting you with our support team now.\""
  }
}
```

The flow is numbered because it is a sequence. The communication and tool
rules are bullets because they apply at any point.

## Example: voice agent jobInstructions

```
## Conversation flow
1. Ask how you can help.
2. If the caller isn't identified, ask for the account number and read it back digit by digit.
3. Resolve the request with the tools, then ask if there's anything else.

## Using tools
- Use get_balance for any balance or due-date question, and answer only from its result.
- Before a lookup, say one short line such as "Let me pull that up." or "One sec, checking now." Vary it.
- If you're missing an input, ask for it rather than guessing.

## Handing over
- Use transfer_to_agent when the caller asks for a person, after two failed lookups, or for a gas-leak report, because safety calls need a person right away. The tool speaks the transfer line; say nothing else.

## Voice output
Your replies are spoken by a text-to-speech voice, so write the way a person talks.
- Plain sentences only: no lists, markdown, emoji, URLs or symbols.
- One to three short sentences per turn, and one question at a time.
- Say amounts and dates the way a person would: "forty-two dollars, due March third".
```
