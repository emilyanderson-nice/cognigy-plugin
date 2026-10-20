import { describe, it, expect } from "@jest/globals";
import * as setupModule from "../setup.js";

// Namespace import so a missing export fails each test individually instead of
// aborting the whole suite at link time.
const upstreamEngineNotice = (
  setupModule as unknown as {
    upstreamEngineNotice: (client: string) => string | undefined;
  }
).upstreamEngineNotice;

/** Fail with five labelled lines so a reader without the test source can act. */
function fail(
  testName: string,
  requirement: string,
  expected: string,
  actual: unknown,
  guidance: string,
): never {
  throw new Error(
    [
      `1. WHAT FAILED: ${testName}`,
      `2. REQUIREMENT VIOLATED: ${requirement}`,
      `3. EXPECTED: ${expected}`,
      `4. ACTUAL: ${JSON.stringify(actual)}`,
      `5. GUIDANCE: ${guidance}`,
    ].join("\n"),
  );
}

function call(client: string): { value?: string; threw?: string } {
  if (typeof upstreamEngineNotice !== "function") {
    return {
      threw: "upstreamEngineNotice is not an exported function of src/setup.ts",
    };
  }
  try {
    return { value: upstreamEngineNotice(client) };
  } catch (e) {
    return { threw: String(e) };
  }
}

const NOTICE_CLIENTS = ["claude-desktop", "antigravity"];
const SILENT_CLIENTS = ["claude-code", "codex", "other-hosts"];

describe("upstreamEngineNotice", () => {
  for (const client of NOTICE_CLIENTS) {
    it(`${client}: warns that Cognigy's published engine runs without this fork's changes`, () => {
      const r = call(client);
      const name = `upstreamEngineNotice("${client}")`;
      const req =
        "Clients that launch the engine from Cognigy's published npm package must be told it lacks the fork's changes";
      if (r.threw !== undefined) {
        fail(
          name,
          req,
          "a non-empty string",
          { threw: r.threw },
          "Export a pure function that returns a notice for this client and never throws.",
        );
      }
      const v = r.value;
      if (typeof v !== "string" || v.trim().length === 0) {
        fail(
          name,
          req,
          "a non-empty string",
          v,
          "Return a human-readable notice string for this client.",
        );
      }
      const s = v as string;
      if (!s.includes("Cognigy's published engine")) {
        fail(
          name,
          req,
          'text containing "Cognigy\'s published engine"',
          s,
          "Name which engine the client runs, using that exact phrase.",
        );
      }
      if (!s.includes("without this fork's changes")) {
        fail(
          name,
          req,
          'text containing "without this fork\'s changes"',
          s,
          "State the consequence for the user, using that exact phrase.",
        );
      }
      if (s.includes("Cognigy/cognigy-plugin")) {
        fail(
          name,
          "The notice must not hard-code the upstream repo slug",
          'text not containing "Cognigy/cognigy-plugin"',
          s,
          "Refer to the engine without embedding the upstream slug.",
        );
      }
      expect(s).toContain("Cognigy's published engine");
      expect(s).toContain("without this fork's changes");
    });
  }

  for (const client of [...SILENT_CLIENTS, "no-such-client", ""]) {
    it(`${JSON.stringify(client)}: returns undefined without throwing`, () => {
      const r = call(client);
      const name = `upstreamEngineNotice(${JSON.stringify(client)})`;
      if (r.threw !== undefined) {
        fail(
          name,
          "Clients that run this fork's engine (and unknown clients) get no notice, and the call never throws",
          "undefined",
          { threw: r.threw },
          "Return undefined for every client that is not Claude Desktop or Antigravity.",
        );
      }
      if (r.value !== undefined) {
        fail(
          name,
          "Clients that run this fork's engine (and unknown clients) get no notice",
          "undefined",
          r.value,
          "Return undefined for every client that is not Claude Desktop or Antigravity.",
        );
      }
      expect(r.value).toBeUndefined();
    });
  }
});
