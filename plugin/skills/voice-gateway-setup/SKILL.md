---
name: voice-gateway-setup
description: "Use when the user wants to set up a voice agent or a Voice Gateway endpoint with WebRTC for browser-based voice interaction, or to look at recent Voice Gateway calls and one call's timing (time to first audio, text-to-speech and speech-to-text latency)."
---

# Voice Gateway Setup Guide

Deploy an AI Agent as a voice-enabled endpoint with WebRTC support. Users can talk to the agent directly in their browser.

## Prerequisites

1. **A Project** — use `list_resources { resourceType: "project" }` to find one, or let `create_ai_agent` create one automatically.
2. **A Flow** — the conversation logic the voice endpoint connects to. Use `list_resources { resourceType: "flow", projectId }` to find existing flows.
3. **An LLM** — the agent needs an LLM to generate responses. Use `setup_llm` if not configured.

## Quick Start

### 1. Create a Voice Gateway endpoint

```json
{
  "projectId": "<24-char hex>",
  "flowId": "<flow referenceId>",
  "name": "My Voice Agent"
}
```

This automatically:

- Creates a `voiceGateway2` endpoint
- Provisions a WebRTC client
- Returns a `webrtcDemoUrl` the user can open in a browser

### 2. Customize the WebRTC widget (optional)

```json
{
  "projectId": "<24-char hex>",
  "flowId": "<flow referenceId>",
  "name": "My Voice Agent",
  "webrtcWidgetConfig": {
    "label": "Support Agent",
    "theme": "AI_PURPLE",
    "transcription": { "enabled": true },
    "tagline": "How can I help you today?",
    "avatarLogoUrl": "https://example.com/avatar.png"
  }
}
```

### 3. Update an existing endpoint

```json
{
  "endpointId": "<24-char hex>",
  "webrtcWidgetConfig": {
    "theme": "CLEAN_WHITE"
  }
}
```

Create vs update:

- Omit `endpointId` → a new `voiceGateway2` endpoint is always created (`projectId` + `flowId` required). The tool never auto-detects an existing endpoint.
- Pass `endpointId` → that endpoint is updated and the settings you pass are merged into its existing configuration; everything else is preserved. Find it first with `list_resources { resourceType: "endpoint", projectId }`.

## WebRTC Widget Themes

| Theme         | Description               |
| ------------- | ------------------------- |
| `DARK_MODE`   | Dark background (default) |
| `CLEAN_WHITE` | Light/white background    |
| `AI_PURPLE`   | Purple accent theme       |

## URLs in the Response

| Field                           | Purpose                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `webrtcDemoUrl`                 | Open in browser to talk to the agent — **always show this to users** |
| `_integration.wsEndpointUrl`    | WebSocket URL for programmatic/embedded use                          |
| `_integration.embeddingSnippet` | HTML code to embed the voice widget on a website                     |

Present `webrtcDemoUrl` as a clickable link after every successful create or update — do not send the user to the Cognigy UI to find it. Mention the `_integration` fields only when the user asks about embedding or deploying to a website.

## Embedding on a Website

Copy the `embeddingSnippet` from the response into your HTML page. It loads the Cognigy WebRTC widget and connects to the voice endpoint automatically.

## Typical Full Workflow

1. `create_ai_agent` → get `flowId` and `projectId`
2. `setup_llm` → configure LLM for the project
3. `manage_voice_gateway { projectId, flowId }` → get `webrtcDemoUrl`
4. Share the URL with the user

## Reading Calls and Their Timing

For "how did that call go" questions (slow first reply, latency, which voice or model ran), read the Voice Gateway itself. It is read-only and separate from the Cognigy.AI key:

1. `list_resources { resourceType: "voice_call", days }` lists recent calls (at most 30 days). Narrow with `direction`, `answered` or `sipCallId` (the SIP Call-ID your own logs carry; a call row names no Cognigy project or session, so that id or the start time is how you match a call). Each row has a `traceId`.
2. `get_resource { resourceType: "voice_call", id: <traceId> }` returns the timing: per spoken reply the text-to-speech time to first byte, duration, vendor, model and voice; per listening turn the speech-to-text vendor and model; the connection times; and `bargeIn`. It never returns the caller's words, numbers or request bodies.

Report what the numbers show. `bargeIn.observed: false` means no barge-in span appeared in this trace, which is not proof it did not happen, so say it that way. Traces are kept for about 14 days.

If the answer is "Voice Gateway is not configured for this environment", the environment's profile has no Voice Gateway URL and account API key. Do not ask for the key in chat. Give the user the command from the hint (`cognigy-setup profile add ... --voice-gateway-url <https URL> --voice-gateway-key-env <VAR>`), where the key comes from an environment variable or a hidden prompt.
