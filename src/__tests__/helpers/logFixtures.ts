/**
 * Shared fixtures for the log tool tests (logReader*, logScrub*, logSummary*,
 * logToolWiring). Test-only: nothing here touches a real Cognigy environment.
 */
import { expect, jest } from "@jest/globals";
import type { LogEntry } from "../../tools/logScrub.js";

export const NOW = Date.parse("2026-10-23T12:00:00.000Z");
export const DEFAULT_END = new Date(NOW + 60_000).toISOString();
export const DEFAULT_START = new Date(NOW - 3_600_000).toISOString();
export const PROJECT = "507f1f77bcf86cd799439011";
export const LOGS_URL = `/v2.1/projects/${PROJECT}/logs`;
export const TAIL_URL = `/v2.1/projects/${PROJECT}/logs/tail`;
export const V2_HEADERS = { "x-cognigy-log-model-version": "v2" };

export const SENTINEL_TEXT = "SENTINEL_USER_TEXT_8841";
export const SENTINEL_TOKEN = "SENTINEL_URL_TOKEN_5520";
export const SENTINEL_ERR = "SENTINEL_ERROR_DETAIL_3307";
export const SENTINEL_KEY = "SENTINEL_API_KEY_9912";
export const SENTINEL_META = "SENTINEL_OTHER_META_6604";
export const ALL_SENTINELS = [
  SENTINEL_TEXT,
  SENTINEL_TOKEN,
  SENTINEL_ERR,
  SENTINEL_KEY,
  SENTINEL_META,
];

export type Mock = jest.Mock<(url: string, config?: any) => Promise<any>>;

export const item = (i: number, overrides: Record<string, unknown> = {}) => ({
  _id: `id${i}`,
  timestamp: new Date(NOW - i * 1000).toISOString(),
  msg: `message ${i % 3} happened`,
  meta: { flowId: `flow${i % 2}`, channel: "webchat" },
  type: "error",
  traceId: `trace${i}`,
  ...overrides,
});

export const items = (n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => item(start + i));

export const page = (n: number, total: number | undefined, start = 0) => ({
  items: items(n, start),
  ...(total === undefined ? {} : { total }),
  _links: { next: "SHOULD_NOT_APPEAR_IN_OUTPUT" },
});

export const hostileItem = (i: number, shape: "v1" | "v2" = "v1") => ({
  _id: `id${i}`,
  timestamp: new Date(NOW - i * 1000).toISOString(),
  msg: "boom",
  meta: {
    flowId: "flowA",
    channel: "webchat",
    text: SENTINEL_TEXT,
    URLToken: SENTINEL_TOKEN,
    other: SENTINEL_META,
    nested: { URLToken: SENTINEL_TOKEN, text: SENTINEL_TEXT },
  },
  ...(shape === "v1"
    ? { type: "error" }
    : {
        metadata: {
          type: "error",
          projectId: PROJECT,
          URLToken: SENTINEL_TOKEN,
        },
      }),
  traceId: `t${i}`,
});

export const upstreamError = (
  status: number | null,
  message = SENTINEL_ERR,
) => {
  const err: any = new Error(message);
  err.config = {
    url: LOGS_URL,
    headers: {
      Authorization: `Bearer ${SENTINEL_KEY}`,
      "X-API-Key": SENTINEL_KEY,
    },
  };
  if (status !== null) {
    err.response = {
      status,
      data: {
        message,
        detail: SENTINEL_ERR,
        title: SENTINEL_ERR,
        error: SENTINEL_ERR,
      },
    };
  }
  return err;
};

export const SENTINEL_CODE = "SENTINEL_ERROR_CODE_4412";
export const SENTINEL_TRACE = "SENTINEL_TRACE_ID_7781";
export const SENTINEL_DETAILS = "SENTINEL_DETAILS_2290";
export const ERROR_LEAK_SENTINELS = [
  SENTINEL_ERR,
  SENTINEL_CODE,
  SENTINEL_TRACE,
  SENTINEL_DETAILS,
  SENTINEL_KEY,
];

/**
 * The error the REAL client rejects with for any response that has a body
 * (src/api/client.ts formatError): a plain Error carrying .status, .code,
 * .traceId and .details, and NO .response. `status` is typed unknown so tests
 * can pass junk (99, 600, "403", 403.5, NaN) to pin the status:null path.
 */
export const clientError = (status: unknown, message = SENTINEL_ERR) => {
  const err: any = new Error(message);
  err.status = status;
  err.code = SENTINEL_CODE;
  err.traceId = SENTINEL_TRACE;
  err.details = [{ message: SENTINEL_DETAILS, key: SENTINEL_KEY }];
  return err;
};

/** Queue responses; an Error instance rejects, anything else resolves. */
export const queue = (
  client: Mock,
  responses: unknown[],
  onCall?: () => void,
) => {
  let i = 0;
  client.mockImplementation(async () => {
    const r = responses[i++];
    onCall?.();
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error("unexpected extra client call");
    return r;
  });
};

export interface Spec {
  what: string;
  why: string;
  fix: string;
}

/** Exact comparison that fails with a 5-point self-documenting message. */
export function expectExact(
  actual: unknown,
  expected: unknown,
  spec: Spec,
): void {
  try {
    expect(actual).toStrictEqual(expected);
  } catch {
    throw new Error(
      [
        `WHAT FAILED: ${spec.what}`,
        `WHY (requirement): ${spec.why}`,
        `EXPECTED: ${JSON.stringify(expected)}`,
        `ACTUAL: ${JSON.stringify(actual)}`,
        `GUIDANCE: ${spec.fix}`,
      ].join("\n"),
    );
  }
}

export const paramsOf = (client: Mock, call: number) =>
  (client.mock.calls[call][1] as any).params as Record<string, unknown>;
export function sortedKeys(o: unknown): string[] {
  return Object.keys(o as object).sort();
}
export const opts = { now: () => NOW, deadlineMs: 20_000 };

export function e(p: Partial<LogEntry> = {}): LogEntry {
  return { timestamp: "", level: "info", msg: "", ...p };
}

export const T1 = "2026-10-23T10:00:01.000Z";
export const T2 = "2026-10-23T10:00:02.000Z";
export const T3 = "2026-10-23T10:00:03.000Z";
export const T4 = "2026-10-23T10:00:04.000Z";
