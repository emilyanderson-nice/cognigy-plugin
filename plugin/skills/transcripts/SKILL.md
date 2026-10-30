---
name: transcripts
description: "Use when the user wants to read, review or pull Cognigy conversation transcripts, chat or call history, what a customer or tester said, or the message flow of a conversation: one session by id, recent conversations by date, channel or flow, or an overview of a project."
---

# Conversation transcripts

## Step 1: find out which pull the user wants

If the request does not already say, ask ONE question with these choices:

1. **One session**: a session id, or the one just used with `talk_to_agent` (its `sessionId`).
2. **Recent conversations**: a time window, a channel, a flow, a minimum number of messages, or one contact.
3. **Project overview**: the newest conversations, counts only.

Then ask whether they need the **words** or only the **shape** (who spoke, when, how long). Default to the shape. If the user is not around to answer, pick 2 or 3 with the shape and say so.

## One session

`get_resource { resourceType: "conversation", id: "<sessionId>", projectId }` returns an **outline** by default: per message the position, `type`, `source`, time and text length, plus totals, duration and a count per source. No text is returned.

- Words: add `view: "text"`. The text is masked best-effort (emails, tokens, long digit runs, phone numbers, amounts) and cut at 500 characters per message; raise `msgChars` (100 to 4000) when messages are longer.
- Long conversations page 50 messages at a time (`limit` up to 100, `skip` for the next page; the hint names the next `skip`).
- `expertMode: true` adds the detected intent and its score to each message.
- `rawText: true` (with `view: "text"` only) returns the text unmasked. Use it only when the masked text is not enough, and tell the user it is unmasked.
- Do not use `raw: true` for transcripts: it returns the platform record as is, skipping all of the above.

## Many conversations

`list_resources { resourceType: "conversation", projectId, ... }` returns summary rows, newest first, 25 by default (`limit` up to 100, `skip` to page). Filters: `startDate` / `endDate` (ISO 8601, on the start time), `channel`, `flowName` (exact), `minMessages`, `contactIds`.

- The platform returns every conversation of the project in one call and ignores paging and date parameters, so the plugin filters and pages the result itself. On a project with thousands of conversations, narrow with `contactIds` or a short window first. `truncated: true` means only the first 5000 rows were considered.
- A row's `messages` is the platform's number and is not the count the session read returns (one exchange showed 1 against 2 items).
- Take `sessionId` from a row, then read that session as above.
- No rows: the endpoint may not collect conversations (Collect Analytics / Conversations), or the project has none in that window.

## Personal data

Transcripts hold what real people said. However they were masked, treat them as possibly holding personal data.

- Report counts, topics, intents and what went wrong. Do not quote a line that holds a name, phone number, amount or address.
- Do not copy transcript text into files, commits, pull requests, notes or another agent's prompt.
- Never say a transcript is free of personal data.
- Reading transcripts is read-only. The plugin cannot delete a conversation.
