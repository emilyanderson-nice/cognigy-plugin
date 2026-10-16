/**
 * Platform release detection. Behaviour should follow the platform release
 * (a calendar version such as 2026.21.0), not a hard-coded label.
 */

export interface ParsedRelease {
  year: number;
  week: number;
  patch: number;
  raw: string;
}

export function parseRelease(version: string): ParsedRelease | undefined {
  if (typeof version !== "string") return undefined;
  const raw = version.trim();
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,4})$/.exec(raw);
  if (!match) return undefined;
  const [year, week, patch] = [match[1], match[2], match[3]].map(Number);
  if (year < 2000 || year > 2999 || week < 1 || week > 53) return undefined;
  return { year, week, patch, raw };
}
export function compareRelease(a: ParsedRelease, b: ParsedRelease): -1 | 0 | 1 {
  for (const key of ["year", "week", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

export interface ReleaseInfo {
  release?: ParsedRelease;
  source: "openapi" | "unknown";
  error?: string;
}

export interface HttpGetter {
  get<T = unknown>(url: string): Promise<T>;
}

const OPENAPI_PATH = "/openapi/openapi-viewer.json";

export interface ReleaseDetectorOptions {
  /** How long a failed detection is remembered before retrying. */
  failureTtlMs?: number;
  now?: () => number;
}

export function createReleaseDetector(
  client: HttpGetter,
  { failureTtlMs = 30000, now = Date.now }: ReleaseDetectorOptions = {},
): {
  detect(): Promise<ReleaseInfo>;
} {
  let inFlight: Promise<ReleaseInfo> | undefined;
  let success: ReleaseInfo | undefined;
  let failure: { info: ReleaseInfo; at: number } | undefined;

  async function run(): Promise<ReleaseInfo> {
    try {
      const doc = await client.get<{ info?: { version?: unknown } }>(
        OPENAPI_PATH,
      );
      const version = doc?.info?.version;
      if (typeof version !== "string") {
        return {
          source: "unknown",
          error: "OpenAPI document has no info.version",
        };
      }
      const release = parseRelease(version);
      if (!release) {
        return {
          source: "unknown",
          error: "OpenAPI info.version is not a calendar release",
        };
      }
      return { release, source: "openapi" };
    } catch (err) {
      // Never echo the raw error: it may carry request headers or bodies.
      const e = err as { status?: unknown; response?: { status?: unknown } };
      const status = e?.response?.status ?? e?.status;
      return {
        source: "unknown",
        error:
          typeof status === "number"
            ? `Release detection failed (HTTP ${status})`
            : "Release detection failed",
      };
    }
  }

  return {
    detect(): Promise<ReleaseInfo> {
      if (success) return Promise.resolve(success);
      if (failure && now() - failure.at < failureTtlMs) {
        return Promise.resolve(failure.info);
      }
      inFlight ??= run().then((info) => {
        inFlight = undefined;
        if (info.source === "openapi") success = info;
        else failure = { info, at: now() };
        return info;
      });
      return inFlight;
    },
  };
}
