/**
 * Shared fixtures for the esc.4 endpoint-token redaction / endpointId tests.
 * Test-only. `check` produces the 5-point self-documenting failure message
 * (what failed, why, expected, actual, guidance) and never prints the token.
 */
import { jest } from "@jest/globals";

export const TOKEN = "TOKEN_SENTINEL_7781";
export const ENDPOINT_BASE = "https://endpoint-trial.cognigy.ai";
export const PROD_URL = `${ENDPOINT_BASE}/${TOKEN}`;
export const TEST_URL = `${ENDPOINT_BASE}/test/${TOKEN}`;

export const ID = {
  project: "507f1f77bcf86cd799439011",
  agent: "60d5ec49f1a2c8b1a4e0f001",
  flow: "60d5ec49f1a2c8b1a4e0f002",
  endpoint: "60d5ec49f1a2c8b1a4e0f003",
  entry: "60d5ec49f1a2c8b1a4e0f004",
  node: "60d5ec49f1a2c8b1a4e0f005",
  llm: "60d5ec49f1a2c8b1a4e0f006",
  ks: "60d5ec49f1a2c8b1a4e0f007",
  other: "60d5ec49f1a2c8b1a4e0f0aa",
  placeholder: "60d5ec49f1a2c8b1a4e0f00f",
  defaultBranch: "60d5ec49f1a2c8b1a4e0f010",
};

export interface Failure {
  what: string;
  why: string;
  expected: string;
  actual: string;
  guidance: string;
}

/** Throws a 5-point message when `cond` is false. Never include secrets in `actual`. */
export function check(cond: boolean, f: Failure): void {
  if (cond) return;
  throw new Error(
    [
      `1. WHAT FAILED: ${f.what}`,
      `2. WHY (requirement): ${f.why}`,
      `3. EXPECTED: ${f.expected}`,
      `4. ACTUAL: ${f.actual}`,
      `5. GUIDANCE: ${f.guidance}`,
    ].join("\n"),
  );
}

/** The output, serialized, must not contain the token sentinel anywhere. */
export function expectNoToken(output: unknown, label: string): void {
  const json = JSON.stringify(output) ?? "";
  check(!json.includes(TOKEN), {
    what: `${label} leaked the endpoint token`,
    why: "endpoint tokens are credentials and are redacted from every output by default",
    expected: `no occurrence of the token sentinel in JSON.stringify(${label})`,
    actual:
      "the token sentinel IS present in the serialized output (value not printed)",
    guidance:
      "drop URLToken/endpointUrl/the token-bearing URL from this output; expose only hasToken/endpointId",
  });
}

/** The output, serialized, must not mention the given key/word at all. */
export function expectNoWord(output: unknown, word: string, label: string) {
  const json = JSON.stringify(output) ?? "";
  check(!json.includes(word), {
    what: `${label} still contains "${word}"`,
    why: "the contract removed this field/wording from the output",
    expected: `no "${word}" anywhere in JSON.stringify(${label})`,
    actual: `"${word}" found in the serialized output`,
    guidance: `remove "${word}" from this result, error body and hint text; use endpointId instead`,
  });
}

export const mockApi = () =>
  ({
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    put: jest.fn(),
    uploadFile: jest.fn(),
  }) as any;

/** An upstream REST endpoint document that carries the token. */
export const upstreamEndpoint = (over: Record<string, unknown> = {}) => ({
  _id: ID.endpoint,
  name: "EP",
  channel: "rest",
  flowId: ID.flow,
  URLToken: TOKEN,
  createdAt: "2024-01-01",
  secret: "hidden",
  ...over,
});
