import { withHints } from "./filters.js";
import { IntentApi, statusField } from "./intents/types.js";

const PAGE_SIZE = 100;
/** A guard against an API that ignores `skip` and repeats a full page. */
const MAX_PAGES = 100;

/** The endpoint fields read here; others (such as the token) pass through. */
export interface RestEndpoint {
  _id?: string;
  id?: string;
  channel?: string;
  flowId?: string;
  URLToken?: string;
  [key: string]: unknown;
}

interface FlowInfo {
  name?: string;
  referenceId?: string;
  projectReference?: string;
}

/** The endpoint's id, whichever field the API used. */
export const endpointIdOf = (endpoint: RestEndpoint): string | undefined =>
  endpoint._id || endpoint.id;

/** Default name of a flow's or agent's REST endpoint. */
export const restEndpointName = (name?: string): string =>
  name ? `${name} REST Endpoint` : "REST Endpoint";

/**
 * First REST endpoint serving the flow, or null. Matches `flowId` against the
 * flow's `_id` and its `referenceId`; pages until a short page.
 */
export async function findRestEndpoint(
  api: IntentApi,
  ids: { projectId: string; flowId: string; flowReferenceId: string | null },
): Promise<RestEndpoint | null> {
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const eps: unknown = await api.get("/v2.0/endpoints", {
      params: {
        projectId: ids.projectId,
        limit: PAGE_SIZE,
        skip: page * PAGE_SIZE,
      },
    });
    const items = (eps as { items?: unknown } | null)?.items ?? eps;
    if (!Array.isArray(items) || items.length === 0) return null;

    const found = (items as RestEndpoint[]).find(
      (ep) =>
        ep.channel === "rest" &&
        (ep.flowId === ids.flowId || ep.flowId === ids.flowReferenceId),
    );
    if (found) return found;
    if (items.length < PAGE_SIZE) return null;
  }
  return null;
}

/** Create a REST endpoint for the flow; `flowRef` is the flow's referenceId. */
export async function createRestEndpoint(
  api: IntentApi,
  body: { projectId: string; flowRef: string; name: string },
): Promise<RestEndpoint> {
  return (await api.post("/v2.0/endpoints", {
    projectId: body.projectId,
    channel: "rest",
    flowId: body.flowRef,
    name: body.name,
  })) as RestEndpoint;
}

/**
 * manage_flows create_endpoint: reuse the REST endpoint already serving the
 * flow or create one. Never returns the endpoint URL or token, and never
 * echoes upstream error text.
 */
export async function createFlowEndpoint(
  api: IntentApi,
  flowId: string,
  name: string | undefined,
): Promise<Record<string, unknown>> {
  const operation = "create_endpoint";
  let flow: FlowInfo | null;
  try {
    flow = (await api.get(`/v2.0/flows/${flowId}`)) as FlowInfo | null;
  } catch (err) {
    return { operation, error: "flow_not_readable", ...statusField(err) };
  }
  const projectId = flow?.projectReference;
  if (!flow?.referenceId || !projectId) {
    return { operation, error: "flow_unusable" };
  }

  let endpoint: RestEndpoint | null;
  let reused = true;
  try {
    endpoint = await findRestEndpoint(api, {
      projectId,
      flowId,
      flowReferenceId: flow.referenceId,
    });
    if (!endpoint) {
      reused = false;
      endpoint = await createRestEndpoint(api, {
        projectId,
        flowRef: flow.referenceId,
        name: name ?? restEndpointName(flow.name),
      });
    }
  } catch (err) {
    return { operation, error: "request_failed", ...statusField(err) };
  }

  const endpointId = endpointIdOf(endpoint);
  if (!endpointId) return { operation, error: "request_failed" };

  return withHints(
    {
      operation,
      flowId,
      endpointId,
      reused,
    },
    {
      ...(reused
        ? {
            warning:
              "An existing REST endpoint already served this flow and was reused; its own settings (such as transformers) apply.",
          }
        : {}),
      action:
        "Chat with it using talk_to_agent { endpointId }. Remove it with delete_resource { resourceType: 'endpoint', id: endpointId }. The endpoint belongs to this environment only; ids do not carry over to another one.",
    },
  );
}
