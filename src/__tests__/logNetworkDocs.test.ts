/**
 * Doc wording for the network error code feature (C2): the CLAUDE.md log
 * paragraph and the troubleshooting skill's log section.
 */
import { describe, it, expect } from "@jest/globals";

import {
  readRepo,
  section,
  norm,
  overclaims,
  LOG_HEADING,
} from "./helpers/docText.js";
import { expectExact } from "./helpers/logFixtures.js";

const SENTENCE =
  "Upstream error text is never echoed; only enumerated network error codes are named.";
const BANNED = [
  "retained about",
  "kept about",
  "only returned when asked",
  "lags a few seconds",
];

describe("network error code docs", () => {
  const claude = section(readRepo(".claude/CLAUDE.md"), LOG_HEADING);
  const skill = section(
    readRepo("plugin/skills/troubleshooting/SKILL.md"),
    /^## Read the project logs/,
  );

  it("CLAUDE.md Project logs paragraph has the sentence as its own sentence", () => {
    const flat = claude.replace(/\s+/g, " ");
    expectExact(claude.length > 0 && flat.includes(SENTENCE), true, {
      what: "CLAUDE.md project logs section contains the exact new sentence",
      why: "C2 docs: record that error text is never echoed but enumerated codes are named",
      fix: `add the sentence "${SENTENCE}" to the Project logs paragraph`,
    });
    // Own sentence: preceded by the start or a sentence end, and not part of
    // the long sentence that names meta.text and meta.URLToken.
    const idx = flat.indexOf(SENTENCE);
    const before = flat.slice(0, idx).trimEnd();
    expect(
      before === "" || /[.!?]$/.test(before) || /[.!?]\)?$/.test(before),
    ).toBe(true);
    const ownSentence = norm(flat)
      .split(/(?<=[.!?])\s+/)
      .find((s) => s.includes("enumerated network error codes"));
    expect(ownSentence).toBe(norm(SENTENCE));
  });

  it("the new sentence is not an over-claim and the paragraph still passes the checker", () => {
    expect(overclaims(SENTENCE)).toEqual([]);
    expectExact(overclaims(claude), [], {
      what: "CLAUDE.md log section has no over-claim sentences",
      why: "docs must not say user text is never returned",
      fix: "keep the new sentence separate from the meta.text/meta.URLToken sentence",
    });
  });

  it("the troubleshooting log section mentions NODE_EXTRA_CA_CERTS and restarting the MCP client", () => {
    expect(skill.length).toBeGreaterThan(0);
    const flat = norm(skill);
    expect(flat).toContain("node_extra_ca_certs");
    expect(flat).toContain("restart the mcp client");
  });

  it("the troubleshooting log section says not to disable verification and names the proxy or VPN cause", () => {
    const flat = norm(skill);
    expect(flat).toMatch(/do not disable|never disable/);
    expect(flat).toMatch(/proxy|vpn/);
  });

  it.each(BANNED)(
    "the troubleshooting log section does not contain %p",
    (phrase) => {
      expect(norm(skill)).not.toContain(phrase);
    },
  );

  it("the troubleshooting log section passes the over-claim checker", () => {
    expectExact(overclaims(skill), [], {
      what: "troubleshooting log section has no over-claim sentences",
      why: "docs must not say user text is never returned",
      fix: "reword the certificate sentence without claims about user text",
    });
  });
});
