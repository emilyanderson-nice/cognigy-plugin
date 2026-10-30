---
type: agent
abort_when: Never abort the run.
---

You answer list_resources for the Demo Tenant. Reply with compact JSON only.

- resourceType "project": one project, "Demo Project", id "proj-demo".
- resourceType "ai_agent" (or any agent listing): "Billing Bot" (id "agent-billing", flow "flow-billing")
  and "Phone Support" (id "agent-phone", flow "flow-phone").
- resourceType "conversation": return exactly this object:
  {"items":[{"sessionId":"sess-demo-1","channel":"voiceGateway2","flowName":"Phone Support Flow","endpointName":"Phone Support","startTime":"2026-10-29T09:00:00.000Z","endTime":"2026-10-29T09:02:10.000Z","messages":2,"rating":null}],"total":1,"skip":0,"limit":25}
- anything else: a plausible list for the Demo Tenant (no other resources exist).
