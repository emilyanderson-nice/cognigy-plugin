import { describe, it, expect } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { tools } from "../tools/definitions.js";
import { check } from "./helpers/endpointFixtures.js";

// K2d / K3 wording: tool descriptions and skill/agent text use endpointId,
// revealToken carries a credential warning, no text tells the assistant to
// pass endpointUrl from list_resources or to read URLToken.
const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8");
const def = (name: string): any => tools.find((t) => t.name === name);
const props = (name: string): any => def(name).inputSchema.properties;
const flat = (s: unknown) => String(s).replace(/\s+/g, " ");

const skillFiles = (): string[] => {
  const dir = path.resolve(root, "plugin/skills");
  return fs
    .readdirSync(dir)
    .map((d) => `plugin/skills/${d}/SKILL.md`)
    .filter((f) => fs.existsSync(path.resolve(root, f)));
};
const agentFiles = (): string[] =>
  fs
    .readdirSync(path.resolve(root, "plugin/agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `plugin/agents/${f}`);
const guidanceFiles = (): string[] => [
  ...skillFiles(),
  ...agentFiles(),
  "src/instructions.ts",
];

/**
 * Lines that tell the assistant to use / read the token or the URL. A line is
 * allowed to name them only when it explains revealToken, is about the A2A
 * URL shape (a2a/v1/<URLToken>), or about the log feature's meta.URLToken.
 */
const allowedLine = (line: string): boolean =>
  /revealToken/.test(line) ||
  /a2a\/v1/.test(line) ||
  /meta\.URLToken/.test(line) ||
  /a2aServer/.test(line);

const offendingLines = (file: string, word: RegExp): string[] =>
  read(file)
    .split(/\r?\n/)
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => word.test(l) && !allowedLine(l))
    .map(({ n }) => `${file}:${n}`);

describe("tool definitions wording (K2d, K3)", () => {
  it("keeps exactly 20 tools", () => {
    expect(tools).toHaveLength(20);
  });

  it("talk_to_agent has an endpointId parameter and its description mentions endpointId", () => {
    expect(props("talk_to_agent").endpointId).toBeDefined();
    expect(props("talk_to_agent").endpointId.type).toBe("string");
    expect(flat(def("talk_to_agent").description)).toContain("endpointId");
  });

  it.each(["list_resources", "get_resource"])(
    "%s has a boolean revealToken parameter with a credential warning",
    (name) => {
      const p = props(name).revealToken;
      expect(p).toBeDefined();
      expect(p.type).toBe("boolean");
      const text = flat(p.description);
      check(/credential/i.test(text) && /send messages/i.test(text), {
        what: `${name}.revealToken description lacks the credential warning`,
        why: "the token is a credential: anyone holding it can send messages to the endpoint",
        expected:
          "description says it is a credential and that anyone holding it can send messages",
        actual: `description is ${text.length} characters and misses 'credential' and/or 'send messages'`,
        guidance:
          "state: credential, anyone holding it can send messages to the endpoint, use only when a URL is really needed",
      });
      expect(text).toMatch(/only when/i);
    },
  );

  it.each(["list_resources", "get_resource"])(
    "%s top-level description tells the caller about revealToken",
    (name) => {
      expect(flat(def(name).description)).toContain("revealToken");
    },
  );

  it("create_ai_agent description names endpointId and no longer endpointUrl", () => {
    const text = flat(def("create_ai_agent").description);
    expect(text).toContain("endpointId");
    expect(text).not.toContain("endpointUrl");
  });

  it("talk_to_agent description no longer instructs reading URLToken from list_resources", () => {
    const text = flat(def("talk_to_agent").description);
    expect(text).not.toMatch(/URLToken/);
  });

  it("manage_settings description mentions get_knowledge_ai", () => {
    expect(flat(def("manage_settings").description)).toContain(
      "get_knowledge_ai",
    );
  });
});

describe("skill, agent and instruction text (K2d)", () => {
  it.each(guidanceFiles())(
    "%s does not tell the assistant to pass endpointUrl",
    (file) => {
      const bad = offendingLines(file, /endpointUrl/);
      check(bad.length === 0, {
        what: `${file} still mentions endpointUrl outside a revealToken explanation`,
        why: "callers now pass endpointId; the URL embeds a credential",
        expected: "no `endpointUrl` mention except next to revealToken",
        actual: `found at ${bad.join(", ")}`,
        guidance:
          "say talk_to_agent { endpointId, message } and that create_ai_agent returns endpointId",
      });
    },
  );

  it.each(guidanceFiles())(
    "%s does not tell the assistant to read URLToken",
    (file) => {
      const bad = offendingLines(file, /URLToken/);
      check(bad.length === 0, {
        what: `${file} still mentions URLToken outside the allowed contexts`,
        why: "tokens are redacted by default; the assistant checks hasToken instead",
        expected:
          "no `URLToken` mention except revealToken text, the a2a URL shape or meta.URLToken",
        actual: `found at ${bad.join(", ")}`,
        guidance: "replace 'URLToken exists/present' with hasToken",
      });
    },
  );

  it("agent-creation skill tells the caller to test with talk_to_agent { endpointId", () => {
    const text = read("plugin/skills/agent-creation/SKILL.md");
    expect(text).toContain("talk_to_agent { endpointId");
    expect(text).toMatch(/Returns:[^\n]*endpointId/);
  });

  it("cognigy-agent-builder agent tests with talk_to_agent { endpointId", () => {
    expect(read("plugin/agents/cognigy-agent-builder.md")).toContain(
      "talk_to_agent { endpointId",
    );
  });

  it("the troubleshooting skill checks hasToken on the endpoint", () => {
    expect(read("plugin/skills/troubleshooting/SKILL.md")).toContain(
      "hasToken",
    );
  });

  it("at least one skill explains revealToken with the credential warning", () => {
    const joined = skillFiles().map(read).join("\n");
    const lines = joined.split(/\r?\n/).filter((l) => /revealToken/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(" ")).toMatch(/credential/i);
  });

  it("the settings skill documents get_knowledge_ai", () => {
    expect(read("plugin/skills/settings/SKILL.md")).toContain(
      "get_knowledge_ai",
    );
  });
});
