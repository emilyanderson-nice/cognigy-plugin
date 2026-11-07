/**
 * Read-only client for the Voice Gateway REST API (`<base>/v1/Accounts/...`),
 * authenticated with a Voice Gateway account API key (a different credential
 * from the Cognigy.AI key).
 *
 * Safety properties, all enforced here:
 * - GET only: there is no code path for another method.
 * - Redirects are not followed, so the bearer key cannot be sent to another host.
 * - An error carries a status or an enumerated network class, never the
 *   upstream body or message (which can echo the key or caller details).
 * - The response size is capped.
 */
import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { logger } from "../utils/logger.js";
import { getProxyAxiosOptions } from "../utils/proxy.js";

export interface VoiceGatewayClientConfig {
  /** Host of the Voice Gateway API; a trailing `/v1` is accepted and ignored. */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class VoiceGatewayError extends Error {
  override name = "VoiceGatewayError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

const CLASSES: ReadonlyArray<{ codes: readonly string[]; text: string }> = [
  {
    codes: [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_HAS_EXPIRED",
      "CERT_NOT_YET_VALID",
      "CERT_UNTRUSTED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ],
    text: "the TLS certificate could not be verified",
  },
  {
    codes: [
      "ECONNABORTED",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "ECONNRESET",
      "EPIPE",
      "ERR_SOCKET_CONNECTION_TIMEOUT",
    ],
    text: "the connection timed out",
  },
  {
    codes: ["ENOTFOUND", "EAI_AGAIN"],
    text: "the host name could not be resolved",
  },
  {
    codes: [
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ERR_NETWORK",
      "ENETDOWN",
    ],
    text: "the host could not be reached",
  },
];

/** The base URL as a bare origin plus path, without a trailing `/v1` or slash. */
function rootOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** A fixed message for a failure; only enumerated codes are ever named. */
function describeFailure(err: unknown): VoiceGatewayError {
  const e = err as {
    isAxiosError?: unknown;
    response?: { status?: unknown };
    code?: unknown;
  } | null;
  const status = e?.response?.status;
  if (typeof status === "number") {
    return new VoiceGatewayError(
      `Voice Gateway request failed (HTTP ${status}).`,
      status,
    );
  }
  const raw = typeof e?.code === "string" ? e.code : undefined;
  if (raw === "ERR_FR_MAX_BODY_LENGTH_EXCEEDED" || raw === "ERR_BAD_RESPONSE") {
    return new VoiceGatewayError(
      "Voice Gateway request failed: the response was too large.",
    );
  }
  for (const { codes, text } of CLASSES) {
    const code = codes.find((c) => c === raw);
    if (code !== undefined) {
      return new VoiceGatewayError(
        `Voice Gateway request failed: ${text} (${code}).`,
      );
    }
  }
  return new VoiceGatewayError("Voice Gateway request failed.");
}

export class VoiceGatewayClient {
  private readonly http: AxiosInstance;
  private readonly apiKey: string;

  constructor(config: VoiceGatewayClientConfig) {
    this.apiKey = config.apiKey;
    // Upstream text can echo the key; keep it out of every log line.
    logger.registerSecret(config.apiKey);
    this.http = axios.create({
      baseURL: rootOf(config.baseUrl),
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: { Accept: "application/json" },
      maxRedirects: 0,
      maxContentLength: config.maxResponseBytes ?? DEFAULT_MAX_BYTES,
      // Axios' own proxy handling never opens a CONNECT tunnel; the request
      // interceptor attaches real tunnelling agents instead.
      proxy: false,
    });
    this.http.interceptors.request.use((req) => {
      req.headers.Authorization = `Bearer ${this.apiKey}`;
      const target = new URL(
        `${req.baseURL ?? ""}${req.url ?? ""}`,
        req.baseURL,
      ).toString();
      Object.assign(req, getProxyAxiosOptions(target));
      return req;
    });
  }

  /** GET `/v1<path>`; `path` starts with `/Accounts/...`. */
  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number>,
  ): Promise<T> {
    const config: AxiosRequestConfig = { params };
    try {
      const response = await this.http.get<T>(`/v1${path}`, config);
      return response.data;
    } catch (err) {
      throw describeFailure(err);
    }
  }
}
