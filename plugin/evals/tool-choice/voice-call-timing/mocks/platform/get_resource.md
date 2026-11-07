---
type: agent
abort_when: Never abort the run.
---

You answer get_resource for the Demo Tenant. Reply with compact JSON only.

- resourceType "voice_call", id "0123456789abcdef0123456789abcdef": return exactly this object:
  {"traceId":"0123456789abcdef0123456789abcdef","startedAt":"2026-11-05T10:00:00.000Z","call":{"durationMs":70000,"finalStatus":200,"termination":"hangup by caller","terminatedBy":"caller","timeline":[{"status":"trying","atMs":5},{"status":"in-progress","atMs":900},{"status":"completed","atMs":69990}]},"speech":{"count":3,"truncated":false,"ttfbMs":{"min":290,"median":310,"max":1380},"turns":[{"atMs":1210,"durationMs":1600,"ttfbMs":1380,"vendor":"elevenlabs","model":"eleven_flash_v2_5","characters":51,"cached":false,"streaming":true,"fallback":false},{"atMs":21000,"durationMs":900,"ttfbMs":310,"vendor":"elevenlabs","model":"eleven_flash_v2_5","characters":24,"cached":false,"streaming":true,"fallback":false},{"atMs":44000,"durationMs":800,"ttfbMs":290,"vendor":"elevenlabs","model":"eleven_flash_v2_5","characters":30,"cached":false,"streaming":true,"fallback":false}]},"listening":{"count":2,"truncated":false,"turns":[{"atMs":4500,"durationMs":9000,"vendor":"deepgram","model":"nova-3","fallback":false},{"atMs":30000,"durationMs":8000,"vendor":"deepgram","model":"nova-3","fallback":false}]},"gatherConnect":{"count":1,"truncated":false,"turns":[{"atMs":1000,"durationMs":115.5,"vendor":"deepgram","success":true}]},"bargeIn":{"observed":false,"matchingSpans":0,"note":"No barge-in or voice-activity span or attribute appeared in this trace; that is not proof it did not happen."},"spans":{"total":64,"read":64,"truncated":false},"_hints":{"action":"This is timing only: the caller's words, numbers and request bodies are never returned. Voice Gateway keeps traces for up to 14 days."}}
- anything else: a plausible answer for the Demo Tenant.
