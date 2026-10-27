/** The slice of the API client the intent modules need (keeps them easy to mock). */
export interface IntentApi {
  get(
    path: string,
    config?: { params?: Record<string, unknown> },
  ): Promise<any>;
  post(
    path: string,
    data?: any,
    config?: { params?: Record<string, unknown> },
  ): Promise<any>;
  patch(
    path: string,
    data?: any,
    config?: { params?: Record<string, unknown> },
  ): Promise<any>;
  delete(
    path: string,
    config?: { params?: Record<string, unknown> },
  ): Promise<any>;
}

const numeric = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * HTTP status of a rejected API call. Reads `err.response.status` first, then
 * `err.status` (the real client rethrows an Error carrying only `.status`).
 * Never reads or returns a message.
 */
export function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { response, status } = err as {
    response?: { status?: unknown } | null;
    status?: unknown;
  };
  return numeric(response?.status) ?? numeric(status);
}

/** `{ httpStatus }` when the error carries one, otherwise `{}`. */
export function statusField(err: unknown): { httpStatus?: number } {
  const httpStatus = httpStatusOf(err);
  return httpStatus !== undefined ? { httpStatus } : {};
}

export const intentsPath = (flowId: string): string =>
  `/v2.0/flows/${flowId}/intents`;
