import { intentsPath, statusField, type IntentApi } from "./types.js";

export const BUILD_POLL_INTERVAL_MS = 3000;
export const DEFAULT_BUILD_DEADLINE_MS = 120000;

export interface BuildOptions {
  projectId?: string;
  localeId?: string;
  mode?: "full" | "quick";
  deadlineMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type BuildResult =
  | {
      ok: true;
      status: "done" | "pending";
      taskId: string;
      currentStep?: number;
      totalStep?: number;
      elapsedMs: number;
    }
  | { ok: false; error: "locale_not_found" }
  | { ok: false; error: "flow_unreadable"; httpStatus?: number }
  | {
      ok: false;
      error: "status_unavailable";
      taskId: string;
      elapsedMs: number;
      httpStatus?: number;
    }
  | { ok: false; error: "build_not_started"; httpStatus?: number }
  | {
      ok: false;
      error: "build_failed" | "build_cancelled";
      taskId: string;
      elapsedMs: number;
    };

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const numberOrUndefined = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;

export async function startBuild(
  api: IntentApi,
  flowId: string,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const deadlineMs = options.deadlineMs ?? DEFAULT_BUILD_DEADLINE_MS;
  const pollMs = options.pollIntervalMs ?? BUILD_POLL_INTERVAL_MS;
  const start = now();

  let localeId = options.localeId;
  if (!localeId) {
    let flow: any;
    try {
      flow = await api.get(`/v2.0/flows/${flowId}`);
    } catch (err) {
      return { ok: false, error: "flow_unreadable", ...statusField(err) };
    }
    const ref = flow?.localeReference;
    if (typeof ref !== "string" || ref === "") {
      return { ok: false, error: "locale_not_found" };
    }
    localeId = ref;
  }

  let task: any;
  try {
    task = await api.post(`${intentsPath(flowId)}/train`, {
      localeId,
      mode: options.mode ?? "full",
    });
  } catch (err) {
    return { ok: false, error: "build_not_started", ...statusField(err) };
  }
  if (typeof task?._id !== "string" || task._id === "") {
    return { ok: false, error: "build_not_started" };
  }

  const taskId: string = task._id;
  const taskPath = `/new/v2.0/tasks/${taskId}`;
  const config = options.projectId
    ? { params: { projectId: options.projectId } }
    : undefined;

  for (;;) {
    let current: any;
    try {
      current = config
        ? await api.get(taskPath, config)
        : await api.get(taskPath);
    } catch (err) {
      return {
        ok: false,
        error: "status_unavailable",
        taskId,
        elapsedMs: now() - start,
        ...statusField(err),
      };
    }
    const status = current?.status;
    const progress = {
      currentStep: numberOrUndefined(current?.currentStep),
      totalStep: numberOrUndefined(current?.totalStep),
    };
    if (status === "done") {
      return {
        ok: true,
        status: "done",
        taskId,
        ...progress,
        elapsedMs: now() - start,
      };
    }
    if (status === "queued" || status === "active") {
      if (now() - start >= deadlineMs) {
        return {
          ok: true,
          status: "pending",
          taskId,
          ...progress,
          elapsedMs: now() - start,
        };
      }
      await sleep(pollMs);
      continue;
    }
    return {
      ok: false,
      error:
        status === "cancelling" || status === "cancelled"
          ? "build_cancelled"
          : "build_failed",
      taskId,
      elapsedMs: now() - start,
    };
  }
}

export interface ModelState {
  flowId: string;
  upToDate: boolean | null;
  intentTotal: number | null;
  lastTrainedAt: null;
  note: string;
}

export async function modelState(
  api: IntentApi,
  flowId: string,
): Promise<ModelState> {
  const flow = await api.get(`/v2.0/flows/${flowId}`);
  const list = await api.get(intentsPath(flowId), {
    params: { limit: 1, includeChildren: true },
  });
  const outOfDate = flow?.isTrainingOutOfDate;
  return {
    flowId,
    upToDate: typeof outOfDate === "boolean" ? !outOfDate : null,
    intentTotal: typeof list?.total === "number" ? list.total : null,
    lastTrainedAt: null,
    note: "The platform exposes no last-trained time. upToDate is true when no edits are pending, false when edits were made since the last build; null was observed right after a successful build, so it most likely means no pending edits, but that is not documented.",
  };
}
