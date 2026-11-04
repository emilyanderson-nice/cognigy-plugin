/**
 * manage_endpoints get_call_events / update_call_events: the voice call events
 * of an endpoint (`settings.callEvents`): which flow runs when a call
 * completes, fails, times out and so on.
 *
 * The API merges a partial `settings.callEvents` into what is stored (checked
 * live on the EU trial: other events and the other settings stay), so only the
 * named events are sent. A change is read back and compared.
 */
import { withHints } from "./filters.js";
import { FileAccessError, writeTextFile } from "../utils/fileAccess.js";

type Api = {
  get: (path: string, config?: any) => Promise<any>;
  patch: (path: string, body?: any) => Promise<any>;
};

export const CALL_EVENTS = [
  "callCompleted",
  "callFailed",
  "userInputTimeout",
  "noAnswer",
  "recognizedDtmf",
] as const;

const fileMessage = (err: unknown): string =>
  err instanceof FileAccessError || err instanceof Error
    ? err.message
    : "The file could not be accessed.";

const eventsOf = (endpoint: any): Record<string, any> =>
  endpoint?.settings?.callEvents &&
  typeof endpoint.settings.callEvents === "object"
    ? endpoint.settings.callEvents
    : {};

export async function manageCallEvents(api: Api, data: any): Promise<any> {
  const before: any = await api.get(`/v2.0/endpoints/${data.endpointId}`);
  if (!before || typeof before !== "object") {
    return {
      error: "The endpoint could not be read.",
      endpointId: data.endpointId,
    };
  }
  const current = eventsOf(before);

  if (data.operation === "get") {
    return withHints(
      {
        endpointId: data.endpointId,
        name: before.name,
        channel: before.channel,
        callEvents: current,
      },
      {
        action:
          "flowId is the flow's referenceId (UUID). Events missing here have never been configured.",
      },
    );
  }

  // ---- update ----
  const changes: Record<string, any> = {};
  for (const event of CALL_EVENTS) {
    const given = data.events?.[event];
    if (!given) continue;
    const next: Record<string, unknown> = { ...(current[event] ?? {}) };
    if (given.enabled !== undefined) next.enabled = given.enabled;
    if (given.flowId !== undefined) next.flowId = given.flowId;
    if (
      next.enabled === true &&
      !next.flowId &&
      event !== "noAnswer" &&
      event !== "recognizedDtmf"
    ) {
      return withHints(
        { error: `${event} needs a flowId (referenceId) to be switched on.` },
        { action: "Pass events.<name>.flowId, the flow's referenceId UUID." },
      );
    }
    if (next.flowId !== undefined) next.action = "executeFlow";
    changes[event] = next;
  }
  if (Object.keys(changes).length === 0) {
    return withHints(
      { error: "Nothing to change." },
      {
        action: `Pass events with at least one of: ${CALL_EVENTS.join(", ")}.`,
      },
    );
  }

  let backup: Record<string, unknown> | undefined;
  if (data.backupTo) {
    try {
      const saved = await writeTextFile(
        data.backupTo,
        JSON.stringify(
          { endpointId: data.endpointId, callEvents: current },
          null,
          2,
        ),
        undefined,
        { overwrite: data.overwrite === true },
      );
      backup = { path: saved.path, bytes: saved.bytes, sha256: saved.sha256 };
    } catch (err) {
      return {
        error: `Backup not written, nothing was changed: ${fileMessage(err)}`,
        field: "backupTo",
      };
    }
  }

  try {
    await api.patch(`/v2.0/endpoints/${data.endpointId}`, {
      settings: { callEvents: changes },
    });
  } catch (err: any) {
    return withHints(
      {
        error: `The platform refused the change: ${String(err?.message ?? err)}`,
        ...(backup ? { backup } : {}),
      },
      {
        action: "Check the endpoint with get_call_events before trying again.",
      },
    );
  }

  const after = eventsOf(await api.get(`/v2.0/endpoints/${data.endpointId}`));
  const mismatches = Object.keys(changes).filter((event) =>
    Object.entries(changes[event]).some(
      ([key, value]) => after[event]?.[key] !== value,
    ),
  );
  return withHints(
    {
      updated: true,
      endpointId: data.endpointId,
      verified: mismatches.length === 0,
      ...(mismatches.length ? { mismatches } : {}),
      changed: Object.keys(changes),
      before: Object.fromEntries(
        Object.keys(changes).map((e) => [e, current[e] ?? null]),
      ),
      after: Object.fromEntries(
        Object.keys(changes).map((e) => [e, after[e] ?? null]),
      ),
      ...(backup ? { backup } : {}),
    },
    {
      action:
        "Endpoint settings are not in a snapshot. To undo, update again with the values under before.",
    },
  );
}
