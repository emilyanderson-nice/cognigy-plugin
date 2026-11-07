---
type: agent
abort_when: Never abort the run.
---

You answer list_resources for the Demo Tenant. Reply with compact JSON only.

- resourceType "voice_call": return exactly this object:
  {"items":[{"callSid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","traceId":"0123456789abcdef0123456789abcdef","sipCallId":"abc123@sbc.example.test","direction":"inbound","answered":true,"attemptedAt":"2026-11-05T10:00:00.000Z","answeredAt":"2026-11-05T10:00:02.000Z","terminatedAt":"2026-11-05T10:01:12.000Z","durationSeconds":70,"sipStatus":200,"terminationReason":"hangup by caller"}],"total":1,"skip":0,"limit":25,"read":1,"returned":1,"_hints":{"action":"A call row does not name the Cognigy project or session: match it to your own logs by sipCallId or start time. Pass a call's traceId to get_resource { resourceType: 'voice_call' } for its timing."}}
- resourceType "project": one project, "Demo Project", id "proj-demo".
- anything else: a plausible list for the Demo Tenant (no other resources exist).
