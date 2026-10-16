/**
 * Module A: createRuntimeFactory turns a Profile into an EnvironmentRuntime
 * (client + handlers) without any network traffic or credential output.
 */
import { afterEach, describe, it, jest } from "@jest/globals";
import http from "http";
import https from "https";
import { createRuntimeFactory } from "../server/runtimeFactory.js";
import { CognigyApiClient } from "../api/client.js";
import type { Profile } from "../profiles/profiles.js";
import { KEY_A, KEY_B, setOf, usable } from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

const DISTINCT_KEY = "fake-key-FACTORY-distinct-77";

const profileOf = (name: string, key: string): Profile =>
  setOf(usable(name.toUpperCase(), key)).profiles[0];

type Calls = unknown[][];
const fakeHandlers = () => ({
  handleToolCall: async () => ({ ok: true }),
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("createRuntimeFactory", () => {
  it("builds the client with exactly the profile's api url, key and the audit flag", () => {
    const order: string[] = [];
    const createClient = jest.fn((cfg: unknown) => {
      order.push("client");
      return { cfg };
    });
    const createHandlers = jest.fn(() => {
      order.push("handlers");
      return fakeHandlers();
    });
    const logProxy = jest.fn();
    const p = profileOf("a", KEY_A);
    const rt = createRuntimeFactory({
      auditAttribution: true,
      createClient,
      createHandlers,
      logProxy,
    })(p);

    eq(
      createClient.mock.calls,
      [[{ baseUrl: p.apiBaseUrl, apiKey: p.apiKey, auditAttribution: true }]],
      "runtimeFactory::client_config",
      "Rule: createClient receives exactly { baseUrl, apiKey, auditAttribution } of the profile, called once",
      "Hand the client the profile's API base url and key plus the configured audit flag, once, and nothing else.",
    );
    eq(
      order,
      ["client", "handlers"],
      "runtimeFactory::order",
      "Rule: the client is created before the handlers that use it",
      "Create the client first, then the handlers.",
    );
    ok(
      (createHandlers.mock.calls as Calls)[0][0] === rt.client,
      "runtimeFactory::handlers_get_client",
      "Rule: createHandlers is given the client that createClient returned",
      "same client object passed to handlers and returned on the runtime",
      "different object",
      "Pass the one created client to the handlers and return it.",
    );
    eq(
      (createHandlers.mock.calls as Calls)[0].slice(1),
      [p.endpointBaseUrl, p.webchatBaseUrl, p.staticFilesBaseUrl],
      "runtimeFactory::handlers_urls",
      "Rule: handlers get endpoint, webchat and static-files base urls in that order",
      "Pass the profile's three derived urls in the documented order.",
    );
    eq(
      logProxy.mock.calls,
      [[p.apiBaseUrl]],
      "runtimeFactory::log_proxy_once",
      "Rule: logProxy is called exactly once with the profile's api base url",
      "Announce the proxy once per runtime, for the API host.",
    );
    ok(
      rt.profile === p,
      "runtimeFactory::runtime_profile",
      "Rule: the runtime carries the very profile it was built from",
      "runtime.profile is the input profile",
      "a different object",
      "Return the input profile on the runtime.",
    );
  });

  it("passes auditAttribution=false through unchanged", () => {
    const createClient = jest.fn((_c: unknown) => ({}));
    createRuntimeFactory({
      auditAttribution: false,
      createClient,
      createHandlers: fakeHandlers,
      logProxy: () => {},
    })(profileOf("a", KEY_A));
    eq(
      (createClient.mock.calls[0][0] as { auditAttribution: boolean })
        .auditAttribution,
      false,
      "runtimeFactory::audit_false",
      "Rule: auditAttribution comes from deps, not a constant",
      "Forward the configured flag value.",
    );
  });

  it("gives two profiles independent clients and handlers", () => {
    const factory = createRuntimeFactory({
      auditAttribution: true,
      createClient: (cfg: unknown) => ({ cfg }),
      createHandlers: fakeHandlers,
      logProxy: () => {},
    });
    const a = factory(profileOf("a", KEY_A));
    const b = factory(profileOf("b", KEY_B));
    ok(
      a.client !== b.client && a.handlers !== b.handlers,
      "runtimeFactory::independent",
      "Rule: two profiles yield different client and handler objects",
      "distinct clients and handlers",
      "shared object between environments",
      "Build a fresh client and handlers per call; never share state across environments.",
    );
    eq(
      [
        (a.client as { cfg: { apiKey: string } }).cfg.apiKey,
        (b.client as { cfg: { apiKey: string } }).cfg.apiKey,
      ],
      [KEY_A, KEY_B],
      "runtimeFactory::no_key_mixup",
      "Rule: each client is configured with its own profile's key",
      "Never carry one environment's key into another's client.",
    );
  });

  it("with all defaults builds a real client and handlers, silently and offline", () => {
    const out = jest.spyOn(process.stdout, "write");
    const err = jest.spyOn(process.stderr, "write");
    const cErr = jest.spyOn(console, "error");
    const cLog = jest.spyOn(console, "log");
    const cWarn = jest.spyOn(console, "warn");
    const httpReq = jest.spyOn(http, "request");
    const httpsReq = jest.spyOn(https, "request");
    const before = [out, err, cErr, cLog, cWarn].map(
      (s) => s.mock.calls.length,
    );

    const rt = createRuntimeFactory({ auditAttribution: true })(
      profileOf("a", DISTINCT_KEY),
    );

    ok(
      typeof rt.handlers.handleToolCall === "function",
      "runtimeFactory::default_handlers",
      "Rule: default createHandlers yields an object with handleToolCall",
      "handlers.handleToolCall is a function",
      typeof rt.handlers?.handleToolCall,
      "Default to the real tool handlers.",
    );
    ok(
      rt.client instanceof CognigyApiClient,
      "runtimeFactory::default_client",
      "Rule: default createClient is the real CognigyApiClient",
      "client instanceof CognigyApiClient",
      `client constructor: ${(rt.client as object)?.constructor?.name}`,
      "Default to the real API client.",
    );
    const after = [out, err, cErr, cLog, cWarn].map((s) => s.mock.calls.length);
    eq(
      after,
      before,
      "runtimeFactory::default_silent",
      "Rule: building a runtime writes nothing to stdout/stderr/console",
      "Do not log (at info level) or print while building a runtime.",
    );
    eq(
      [httpReq.mock.calls.length, httpsReq.mock.calls.length],
      [0, 0],
      "runtimeFactory::no_network",
      "Rule: building a runtime issues no network request",
      "Construct lazily; never contact the platform at build time.",
    );
  });

  it("never writes the API key to any output channel", () => {
    const spies = [
      jest.spyOn(process.stdout, "write"),
      jest.spyOn(process.stderr, "write"),
      jest.spyOn(console, "error"),
      jest.spyOn(console, "log"),
      jest.spyOn(console, "warn"),
      jest.spyOn(console, "info"),
      jest.spyOn(console, "debug"),
    ];
    createRuntimeFactory({ auditAttribution: true })(
      profileOf("a", DISTINCT_KEY),
    );
    const written = JSON.stringify(spies.map((s) => s.mock.calls));
    ok(
      !written.includes(DISTINCT_KEY),
      "runtimeFactory::key_not_leaked",
      "Rule: the API key is never written to stdout/stderr",
      "no output containing the key",
      "key text found in output",
      "Keep credentials out of every log line and message.",
    );
  });
});
