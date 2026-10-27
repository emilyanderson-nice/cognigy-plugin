import { describe, expect, it, jest } from "@jest/globals";
import type { IntentApi } from "../tools/intents/types.js";
import {
  BUILD_POLL_INTERVAL_MS,
  DEFAULT_BUILD_DEADLINE_MS,
  modelState,
  startBuild,
} from "../tools/intents/build.js";

const FLOW = "ffffffffffffffffffffff01";
const LOCALE = "bbbbbbbbbbbbbbbbbbbbbb01";
const OTHER_LOCALE = "bbbbbbbbbbbbbbbbbbbbbb02";
const TASK = "cccccccccccccccccccccc01";
const PROJECT = "dddddddddddddddddddddd01";
const SENTINEL_FAIL = "SENTINEL_FAIL_REASON_55";
const SENTINEL_ERR = "SENTINEL_UPSTREAM_MESSAGE_66";

const FLOW_PATH = `/v2.0/flows/${FLOW}`;
const TRAIN_PATH = `/v2.0/flows/${FLOW}/intents/train`;
const TASK_PATH = `/new/v2.0/tasks/${TASK}`;
const INTENTS_PATH = `/v2.0/flows/${FLOW}/intents`;

interface Task {
  _id?: string;
  status: string;
  currentStep?: number;
  totalStep?: number;
  failReason?: string;
}

interface FakeOptions {
  flow?: Record<string, unknown>;
  /** Successive task reads; the last entry repeats forever. */
  tasks?: Task[];
  postError?: Error;
  intentsList?: Record<string, unknown>;
  onPost?: () => void;
  flowError?: Error;
  /** What the train POST resolves with (default: a queued task with _id TASK). */
  postResponse?: unknown;
  /** Make the task status GET reject at this 0-based read (default read 0). */
  taskError?: { error: Error; atRead?: number };
}

function makeFake(options: FakeOptions = {}) {
  let taskReads = 0;
  const tasks = options.tasks ?? [
    { status: "done", currentStep: 3, totalStep: 3 },
  ];

  const get = jest.fn<IntentApi["get"]>(async (path, _config) => {
    if (path === FLOW_PATH) {
      if (options.flowError) throw options.flowError;
      return options.flow ?? { localeReference: LOCALE };
    }
    if (path === TASK_PATH) {
      if (options.taskError && taskReads === (options.taskError.atRead ?? 0)) {
        taskReads++;
        throw options.taskError.error;
      }
      const task = tasks[Math.min(taskReads, tasks.length - 1)];
      taskReads++;
      return { _id: TASK, ...task };
    }
    if (path === INTENTS_PATH) {
      // The platform's default list total counts only root intents (here: 1);
      // the all-levels total is returned only when includeChildren is true.
      if (_config?.params?.includeChildren !== true) {
        return { total: 1, items: [] };
      }
      return options.intentsList ?? { total: 0, items: [] };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = jest.fn<IntentApi["post"]>(async (path, _body) => {
    options.onPost?.();
    if (options.postError) throw options.postError;
    if (path !== TRAIN_PATH) throw new Error(`unexpected POST ${path}`);
    if ("postResponse" in options) return options.postResponse;
    return { _id: TASK, status: "queued", currentStep: 0, totalStep: 3 };
  });
  const patch = jest.fn<IntentApi["patch"]>(async () => ({}));
  const del = jest.fn<IntentApi["delete"]>(async () => ({}));
  const api: IntentApi = { get, post, patch, delete: del };

  const taskGets = () => get.mock.calls.filter((c) => c[0] === TASK_PATH);
  return { api, get, post, patch, del, taskGets };
}

/** A clock that only moves when the injected sleep is called. */
function makeClock() {
  let t = 0;
  const sleep = jest.fn(async (ms: number) => {
    t += ms;
  });
  return { now: () => t, sleep, advance: (ms: number) => (t += ms) };
}

describe("build constants", () => {
  it("polls every 3000 ms and defaults to a 120000 ms deadline", () => {
    expect(BUILD_POLL_INTERVAL_MS).toBe(3000);
    expect(DEFAULT_BUILD_DEADLINE_MS).toBe(120000);
  });
});

describe("startBuild: locale and request", () => {
  it("looks the locale up from the flow's localeReference when localeId is missing", async () => {
    const fake = makeFake({ flow: { localeReference: LOCALE } });
    const clock = makeClock();
    await startBuild(fake.api, FLOW, { sleep: clock.sleep, now: clock.now });
    expect(fake.get.mock.calls[0][0]).toBe(FLOW_PATH);
    expect(fake.post.mock.calls).toEqual([
      [TRAIN_PATH, { localeId: LOCALE, mode: "full" }],
    ]);
  });

  it("does not read the flow at all when localeId is given, and uses the given one", async () => {
    const fake = makeFake({ flow: { localeReference: OTHER_LOCALE } });
    const clock = makeClock();
    await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(fake.get.mock.calls.filter((c) => c[0] === FLOW_PATH)).toEqual([]);
    expect(fake.post.mock.calls).toEqual([
      [TRAIN_PATH, { localeId: LOCALE, mode: "full" }],
    ]);
  });

  it("sends mode quick when asked", async () => {
    const fake = makeFake();
    const clock = makeClock();
    await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      mode: "quick",
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(fake.post.mock.calls).toEqual([
      [TRAIN_PATH, { localeId: LOCALE, mode: "quick" }],
    ]);
  });

  it("returns locale_not_found and makes no POST when the flow has no localeReference", async () => {
    const fake = makeFake({ flow: { name: "synthetic flow" } });
    const result = await startBuild(fake.api, FLOW, {});
    expect(result).toEqual({ ok: false, error: "locale_not_found" });
    expect(fake.post).not.toHaveBeenCalled();
    expect(fake.taskGets()).toEqual([]);
  });

  it("returns build_not_started with the http status and never the upstream message", async () => {
    const err = Object.assign(new Error(SENTINEL_ERR), {
      response: { status: 503, data: { message: SENTINEL_ERR } },
    });
    const fake = makeFake({ postError: err });
    const result = await startBuild(fake.api, FLOW, { localeId: LOCALE });
    expect(result).toEqual({
      ok: false,
      error: "build_not_started",
      httpStatus: 503,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
    expect(fake.taskGets()).toEqual([]);
  });

  it("returns build_not_started without httpStatus when the rejection has no response", async () => {
    const fake = makeFake({ postError: new Error(SENTINEL_ERR) });
    const result = await startBuild(fake.api, FLOW, { localeId: LOCALE });
    expect(result).toEqual({ ok: false, error: "build_not_started" });
    expect(result).not.toHaveProperty("httpStatus");
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
  });
});

describe("startBuild: polling", () => {
  it("polls the task path with params.projectId when projectId is set", async () => {
    const fake = makeFake();
    const clock = makeClock();
    await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      projectId: PROJECT,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(fake.taskGets()).toEqual([
      [TASK_PATH, { params: { projectId: PROJECT } }],
    ]);
  });

  it("omits the request config entirely when projectId is not set", async () => {
    const fake = makeFake();
    const clock = makeClock();
    await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    const calls = fake.taskGets();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(TASK_PATH);
    expect(calls[0][1]).toBeUndefined();
  });

  it("reads once right after the POST and does not sleep when the task is already done", async () => {
    const fake = makeFake({
      tasks: [{ status: "done", currentStep: 3, totalStep: 3 }],
    });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(fake.taskGets()).toHaveLength(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      status: "done",
      taskId: TASK,
      currentStep: 3,
      totalStep: 3,
      elapsedMs: 0,
    });
  });

  it("follows queued -> active -> done with exactly 3 reads and two 3000 ms sleeps", async () => {
    const fake = makeFake({
      tasks: [
        { status: "queued", currentStep: 0, totalStep: 4 },
        { status: "active", currentStep: 2, totalStep: 4 },
        { status: "done", currentStep: 4, totalStep: 4 },
      ],
    });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(fake.taskGets()).toHaveLength(3);
    expect(clock.sleep.mock.calls).toEqual([[3000], [3000]]);
    expect(result).toEqual({
      ok: true,
      status: "done",
      taskId: TASK,
      currentStep: 4,
      totalStep: 4,
      elapsedMs: 6000,
    });
  });

  it("honours a custom pollIntervalMs", async () => {
    const fake = makeFake({
      tasks: [
        { status: "queued" },
        { status: "active" },
        { status: "done", currentStep: 1, totalStep: 1 },
      ],
    });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      pollIntervalMs: 250,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(clock.sleep.mock.calls).toEqual([[250], [250]]);
    expect(result).toEqual({
      ok: true,
      status: "done",
      taskId: TASK,
      currentStep: 1,
      totalStep: 1,
      elapsedMs: 500,
    });
  });

  it("measures elapsedMs from before the POST", async () => {
    const clock = makeClock();
    const fake = makeFake({ onPost: () => clock.advance(40) });
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({
      ok: true,
      status: "done",
      taskId: TASK,
      currentStep: 3,
      totalStep: 3,
      elapsedMs: 40,
    });
  });
});

describe("startBuild: failures never echo upstream text", () => {
  it("returns build_failed with taskId and elapsedMs, without failReason", async () => {
    const fake = makeFake({
      tasks: [{ status: "error", failReason: SENTINEL_FAIL }],
    });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({
      ok: false,
      error: "build_failed",
      taskId: TASK,
      elapsedMs: 0,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_FAIL);
  });

  it("returns build_failed after earlier active reads, with elapsedMs from the clock", async () => {
    const fake = makeFake({
      tasks: [
        { status: "active" },
        { status: "error", failReason: SENTINEL_FAIL },
      ],
    });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({
      ok: false,
      error: "build_failed",
      taskId: TASK,
      elapsedMs: 3000,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_FAIL);
  });

  it.each(["cancelled", "cancelling"])(
    "returns build_cancelled for status %s",
    async (status) => {
      const fake = makeFake({ tasks: [{ status, failReason: SENTINEL_FAIL }] });
      const clock = makeClock();
      const result = await startBuild(fake.api, FLOW, {
        localeId: LOCALE,
        sleep: clock.sleep,
        now: clock.now,
      });
      expect(result).toEqual({
        ok: false,
        error: "build_cancelled",
        taskId: TASK,
        elapsedMs: 0,
      });
      expect(JSON.stringify(result)).not.toContain(SENTINEL_FAIL);
    },
  );
});

describe("startBuild: deadline", () => {
  it("returns pending (ok true, with the taskId and last progress), never done, when the deadline passes", async () => {
    const fake = makeFake({
      tasks: [{ status: "active", currentStep: 2, totalStep: 5 }],
    });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      deadlineMs: 5000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({
      ok: true,
      status: "pending",
      taskId: TASK,
      currentStep: 2,
      totalStep: 5,
      elapsedMs: 6000,
    });
    expect(clock.sleep.mock.calls).toEqual([[3000], [3000]]);
  });

  it("reports done, not pending, when the task finishes on the read that follows the deadline", async () => {
    const fake = makeFake({
      tasks: [
        { status: "active", currentStep: 1, totalStep: 5 },
        { status: "active", currentStep: 3, totalStep: 5 },
        { status: "done", currentStep: 5, totalStep: 5 },
      ],
    });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      deadlineMs: 5000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({
      ok: true,
      status: "done",
      taskId: TASK,
      currentStep: 5,
      totalStep: 5,
      elapsedMs: 6000,
    });
  });

  it("defaults the deadline to 120000 ms", async () => {
    const fake = makeFake({
      tasks: [{ status: "queued", currentStep: 0, totalStep: 9 }],
    });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(clock.sleep).toHaveBeenCalledTimes(40);
    expect(result).toEqual({
      ok: true,
      status: "pending",
      taskId: TASK,
      currentStep: 0,
      totalStep: 9,
      elapsedMs: 120000,
    });
  });
});

describe("startBuild: unreadable flow, missing task id, unreadable status", () => {
  const httpErr = (status: number) =>
    Object.assign(new Error(SENTINEL_ERR), {
      response: { status, data: { message: SENTINEL_ERR } },
    });

  it("returns flow_unreadable with httpStatus and makes no POST when the flow GET rejects", async () => {
    const fake = makeFake({ flowError: httpErr(404) });
    const result = await startBuild(fake.api, FLOW, {});
    expect(result).toEqual({
      ok: false,
      error: "flow_unreadable",
      httpStatus: 404,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
    expect(fake.post).not.toHaveBeenCalled();
    expect(fake.taskGets()).toEqual([]);
  });

  it("returns flow_unreadable without httpStatus when the rejection has no response", async () => {
    const fake = makeFake({ flowError: new Error(SENTINEL_ERR) });
    const result = await startBuild(fake.api, FLOW, {});
    expect(result).toEqual({ ok: false, error: "flow_unreadable" });
    expect(result).not.toHaveProperty("httpStatus");
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
    expect(fake.post).not.toHaveBeenCalled();
  });

  it.each([
    ["no _id", { status: "queued" }],
    ["an empty _id", { _id: "", status: "queued" }],
    ["a numeric _id", { _id: 12, status: "queued" }],
    ["a null response", null],
  ])(
    "returns build_not_started (no httpStatus) and no task GET when the POST response has %s",
    async (_label, postResponse) => {
      const fake = makeFake({ postResponse });
      const result = await startBuild(fake.api, FLOW, { localeId: LOCALE });
      expect(result).toEqual({ ok: false, error: "build_not_started" });
      expect(result).not.toHaveProperty("httpStatus");
      expect(fake.taskGets()).toEqual([]);
    },
  );

  it("returns status_unavailable with taskId, elapsedMs and httpStatus when the first status read rejects", async () => {
    const fake = makeFake({ taskError: { error: httpErr(502) } });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({
      ok: false,
      error: "status_unavailable",
      taskId: TASK,
      elapsedMs: 0,
      httpStatus: 502,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
  });

  it("returns status_unavailable without httpStatus when the rejection has no response, after earlier polls", async () => {
    const fake = makeFake({
      tasks: [{ status: "active" }, { status: "active" }],
      taskError: { error: new Error(SENTINEL_ERR), atRead: 1 },
    });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({
      ok: false,
      error: "status_unavailable",
      taskId: TASK,
      elapsedMs: 3000,
    });
    expect(result).not.toHaveProperty("httpStatus");
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
    expect(fake.taskGets()).toHaveLength(2);
  });
});

describe("startBuild: httpStatus for the plain err.status error shape", () => {
  // The real client throws a plain Error with a numeric .status and no .response.
  const plain = (status: number) =>
    Object.assign(new Error(SENTINEL_ERR), { status });

  it("build_not_started reports httpStatus from err.status", async () => {
    const fake = makeFake({ postError: plain(429) });
    const result = await startBuild(fake.api, FLOW, { localeId: LOCALE });
    expect(result).toEqual({
      ok: false,
      error: "build_not_started",
      httpStatus: 429,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
    expect(fake.taskGets()).toEqual([]);
  });

  it("flow_unreadable reports httpStatus from err.status and makes no POST", async () => {
    const fake = makeFake({ flowError: plain(403) });
    const result = await startBuild(fake.api, FLOW, {});
    expect(result).toEqual({
      ok: false,
      error: "flow_unreadable",
      httpStatus: 403,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
    expect(fake.post).not.toHaveBeenCalled();
  });

  it("status_unavailable reports httpStatus from err.status", async () => {
    const fake = makeFake({ taskError: { error: plain(504) } });
    const clock = makeClock();
    const result = await startBuild(fake.api, FLOW, {
      localeId: LOCALE,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({
      ok: false,
      error: "status_unavailable",
      taskId: TASK,
      elapsedMs: 0,
      httpStatus: 504,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
  });

  it("err.response.status wins over err.status when both are numeric", async () => {
    const both = Object.assign(new Error(SENTINEL_ERR), {
      status: 418,
      response: { status: 503 },
    });
    const fake = makeFake({ postError: both });
    const result = await startBuild(fake.api, FLOW, { localeId: LOCALE });
    expect(result).toEqual({
      ok: false,
      error: "build_not_started",
      httpStatus: 503,
    });
  });

  it("a non-numeric err.status gives no httpStatus", async () => {
    const odd = Object.assign(new Error(SENTINEL_ERR), { status: "503" });
    const fake = makeFake({ postError: odd });
    const result = await startBuild(fake.api, FLOW, { localeId: LOCALE });
    expect(result).toEqual({ ok: false, error: "build_not_started" });
    expect(result).not.toHaveProperty("httpStatus");
  });
});

describe("modelState", () => {
  it.each([
    [false, true],
    [true, false],
    [null, null],
  ])(
    "isTrainingOutOfDate %p gives upToDate %p",
    async (outOfDate, upToDate) => {
      const fake = makeFake({
        flow: { isTrainingOutOfDate: outOfDate },
        intentsList: { total: 7, items: [] },
      });
      const state = await modelState(fake.api, FLOW);
      expect(state).toEqual({
        flowId: FLOW,
        upToDate,
        intentTotal: 7,
        lastTrainedAt: null,
        note: expect.stringContaining("no last-trained time"),
      });
      expect(state.note).toContain("no last-trained time");
      expect(state.note).toContain("null was observed");
    },
  );

  it("gives upToDate null when isTrainingOutOfDate is absent", async () => {
    const fake = makeFake({
      flow: { name: "synthetic flow" },
      intentsList: { total: 2, items: [] },
    });
    const state = await modelState(fake.api, FLOW);
    expect(state.upToDate).toBeNull();
    expect(state.intentTotal).toBe(2);
  });

  it.each([
    ["a string", { total: "7", items: [] }],
    ["undefined", { items: [] }],
    ["null", { total: null, items: [] }],
  ])("gives intentTotal null when total is %s", async (_label, intentsList) => {
    const fake = makeFake({
      flow: { isTrainingOutOfDate: false },
      intentsList,
    });
    const state = await modelState(fake.api, FLOW);
    expect(state.intentTotal).toBeNull();
  });

  it("keeps a total of 0 as 0, not null", async () => {
    const fake = makeFake({
      flow: { isTrainingOutOfDate: false },
      intentsList: { total: 0, items: [] },
    });
    const state = await modelState(fake.api, FLOW);
    expect(state.intentTotal).toBe(0);
  });

  it("reads exactly the flow and a one-item intents page, and makes no write call", async () => {
    const fake = makeFake({
      flow: { isTrainingOutOfDate: true },
      intentsList: { total: 4, items: [] },
    });
    await modelState(fake.api, FLOW);
    expect(fake.get.mock.calls).toHaveLength(2);
    expect(fake.get.mock.calls.map((c) => c[0]).sort()).toEqual(
      [FLOW_PATH, INTENTS_PATH].sort(),
    );
    const intentsCall = fake.get.mock.calls.find((c) => c[0] === INTENTS_PATH);
    expect(intentsCall?.[1]).toEqual({
      params: { limit: 1, includeChildren: true },
    });
    expect(fake.post).not.toHaveBeenCalled();
    expect(fake.patch).not.toHaveBeenCalled();
    expect(fake.del).not.toHaveBeenCalled();
  });
});
