import { describe, it, expect } from "@jest/globals";

import { MAX_MESSAGE_CHARS, scrubText, toLogEntry } from "../tools/logScrub.js";
import {
  SENTINEL_TEXT,
  SENTINEL_TOKEN as SENTINEL_URL_TOKEN,
  expectExact,
  sortedKeys,
} from "./helpers/logFixtures.js";

describe("toLogEntry: shapes", () => {
  it("maps a v1 entry (top-level type) to exactly the allowlisted fields", () => {
    const raw = {
      _id: "abc",
      timestamp: "2026-10-23T10:00:00.000Z",
      type: "error",
      msg: "boom",
      meta: { flowId: "f1", flowName: "Main Flow", channel: "webchat" },
      traceId: "t1",
    };
    expectExact(
      toLogEntry(raw),
      {
        timestamp: "2026-10-23T10:00:00.000Z",
        level: "error",
        msg: "boom",
        flowId: "f1",
        flowName: "Main Flow",
        channel: "webchat",
        traceId: "t1",
      },
      {
        what: "v1 entry mapping",
        why: "level comes from raw.type; only allowlisted keys are copied",
        fix: "build a new object field by field",
      },
    );
  });

  it("maps a v2 entry (metadata.type) to the level", () => {
    expectExact(
      toLogEntry({
        timestamp: "2026-10-23T10:00:00.000Z",
        msg: "careful",
        metadata: { type: "warn", projectId: "p", organizationId: "o" },
      }),
      { timestamp: "2026-10-23T10:00:00.000Z", level: "warn", msg: "careful" },
      {
        what: "v2 entry mapping",
        why: "level falls back to raw.metadata.type; projectId/organizationId are not copied",
        fix: "read metadata.type when raw.type is not a non-empty string",
      },
    );
  });

  it("prefers raw.type over metadata.type", () => {
    expectExact(
      toLogEntry({ type: "info", metadata: { type: "warn" } }).level,
      "info",
      {
        what: "level precedence",
        why: "raw.type wins when it is a non-empty string",
        fix: "check raw.type first",
      },
    );
  });

  it.each([
    [
      "empty-string type falls back to metadata.type",
      { type: "", metadata: { type: "debug" } },
      "debug",
    ],
    [
      "non-string type falls back to metadata.type",
      { type: 5, metadata: { type: "debug" } },
      "debug",
    ],
    [
      "empty metadata.type falls to unknown",
      { metadata: { type: "" } },
      "unknown",
    ],
    [
      "non-string metadata.type falls to unknown",
      { metadata: { type: 3 } },
      "unknown",
    ],
    ["no type anywhere is unknown", { msg: "x" }, "unknown"],
    ["non-object metadata is unknown", { metadata: "warn" }, "unknown"],
  ])("level: %s", (_label, raw, expected) => {
    expectExact(toLogEntry(raw).level, expected, {
      what: `level resolution: ${_label}`,
      why: "level = non-empty raw.type, else non-empty raw.metadata.type, else 'unknown'",
      fix: "typeof === 'string' && length > 0 checks, in that order",
    });
  });

  it("timestamp is '' when not a string", () => {
    expectExact(toLogEntry({ timestamp: 1730000000 }).timestamp, "", {
      what: "numeric timestamp",
      why: "timestamp is copied only when it is a string",
      fix: "typeof raw.timestamp === 'string' ? raw.timestamp : ''",
    });
  });

  it("scrubs msg with the 500-char cap", () => {
    const out = toLogEntry({ msg: `mail a@b.io ${"x ".repeat(400)}` });
    expectExact(out.msg.length, 500, {
      what: "msg cap",
      why: "msg is scrubText(raw.msg, 500)",
      fix: "use MAX_MESSAGE_CHARS",
    });
    expectExact(out.msg.slice(0, 12), "mail <email>", {
      what: "msg email scrub",
      why: "msg goes through scrubText",
      fix: "call scrubText on raw.msg",
    });
    expectExact(out.msg.endsWith("…"), true, {
      what: "msg ellipsis",
      why: "truncated messages end with …",
      fix: "ellipsis rule",
    });
  });
});

describe("toLogEntry: robustness (never throws)", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "garbage"],
    ["number", 42],
    ["array", []],
    ["boolean", false],
    ["empty object", {}],
  ])("returns the minimal entry for %s", (_label, raw) => {
    expect(() => toLogEntry(raw)).not.toThrow();
    const out = toLogEntry(raw);
    expectExact(
      out,
      { timestamp: "", level: "unknown", msg: "" },
      {
        what: `toLogEntry(${_label})`,
        why: "garbage input yields only timestamp '', level 'unknown', msg ''",
        fix: "default every field, omit the optional ones",
      },
    );
    expectExact(sortedKeys(out), ["level", "msg", "timestamp"], {
      what: "keys present for garbage input",
      why: "omitted keys are not present (not even as undefined)",
      fix: "only assign optional keys when they have a value",
    });
  });

  it.each([
    ["string meta", "flowId=x"],
    ["null meta", null],
    ["number meta", 5],
    ["array meta", ["f1"]],
    [
      "array meta with a flowId property",
      Object.assign(["f1"], { flowId: "evil" }),
    ],
  ])("ignores non-plain-object meta: %s", (_label, meta) => {
    const out = toLogEntry({ type: "info", msg: "m", meta });
    expectExact(sortedKeys(out), ["level", "msg", "timestamp"], {
      what: `meta = ${_label}`,
      why: "meta is read only when it is a plain object (not null, not an array)",
      fix: "check typeof === 'object' && !Array.isArray && !== null",
    });
  });
});

describe("toLogEntry: allowlist and caps", () => {
  it("copies only allowlisted keys and omits absent ones", () => {
    const out = toLogEntry({
      type: "info",
      msg: "m",
      userId: "u-1",
      secret: "s",
      meta: {
        flowId: "f1",
        userId: "u-2",
        sessionId: "s-1",
        extra: { deep: 1 },
      },
    });
    expectExact(
      out,
      { timestamp: "", level: "info", msg: "m", flowId: "f1" },
      {
        what: "allowlist",
        why: "only timestamp, level, msg, flowId, flowName, channel, traceId may appear",
        fix: "never spread raw or raw.meta",
      },
    );
    expectExact(sortedKeys(out), ["flowId", "level", "msg", "timestamp"], {
      what: "key set",
      why: "no extra keys, no undefined-valued keys",
      fix: "assign optional fields conditionally",
    });
  });

  it.each([
    ["flowId", 64, "meta"],
    ["flowName", 100, "meta"],
    ["channel", 40, "meta"],
    ["traceId", 64, "raw"],
  ])("caps %s at %i characters", (field, cap, where) => {
    const long = "k".repeat(cap + 36);
    const raw =
      where === "meta"
        ? { type: "info", meta: { [field]: long } }
        : { type: "info", [field]: long };
    const out = toLogEntry(raw) as unknown as Record<string, string>;
    expectExact(out[field], "k".repeat(cap), {
      what: `${field} over its cap`,
      why: `${field} is at most ${cap} chars (plain cut)`,
      fix: `slice(0, ${cap})`,
    });
  });

  it("slices timestamp to 40 characters (amendment A7)", () => {
    const out = toLogEntry({ timestamp: "2".repeat(100), type: "info" });
    expectExact(out.timestamp, "2".repeat(40), {
      what: "100-char timestamp",
      why: "A7: timestamp is sliced (plain cut) to 40 characters",
      fix: "slice(0, 40) when copying raw.timestamp",
    });
  });

  it("keeps a timestamp of exactly 40 characters whole (amendment A7)", () => {
    expectExact(
      toLogEntry({ timestamp: "2".repeat(40) }).timestamp,
      "2".repeat(40),
      {
        what: "40-char timestamp",
        why: "A7 cap is 'at most 40'",
        fix: "do not cut at the cap",
      },
    );
  });

  it("slices level to 20 characters from raw.type and from metadata.type (amendment A7)", () => {
    expectExact(
      [
        toLogEntry({ type: "L".repeat(50) }).level,
        toLogEntry({ metadata: { type: "M".repeat(50) } }).level,
        toLogEntry({ type: "L".repeat(20) }).level,
      ],
      ["L".repeat(20), "M".repeat(20), "L".repeat(20)],
      {
        what: "over-long level strings",
        why: "A7: level is sliced to 20 characters, whichever field supplied it",
        fix: "slice(0, 20) on the resolved level",
      },
    );
  });

  it("keeps values exactly at the cap", () => {
    const out = toLogEntry({
      meta: {
        flowId: "f".repeat(64),
        flowName: "n".repeat(100),
        channel: "c".repeat(40),
      },
      traceId: "t".repeat(64),
    });
    expectExact(
      [
        out.flowId?.length,
        out.flowName?.length,
        out.channel?.length,
        out.traceId?.length,
      ],
      [64, 100, 40, 64],
      {
        what: "values at the cap",
        why: "caps are 'at most'",
        fix: "do not cut or drop values at the cap",
      },
    );
  });

  it("collapses whitespace inside flowName", () => {
    expectExact(
      toLogEntry({ meta: { flowName: "Main \n  Flow" } }).flowName,
      "Main Flow",
      {
        what: "flowName whitespace",
        why: "flowName has whitespace collapsed",
        fix: "replace /\\s+/g with ' '",
      },
    );
  });

  it("omits non-string flowId/flowName/channel/traceId", () => {
    const out = toLogEntry({
      type: "info",
      traceId: 99,
      meta: { flowId: 123, flowName: { a: 1 }, channel: ["x"] },
    });
    expectExact(sortedKeys(out), ["level", "msg", "timestamp"], {
      what: "non-string optional fields",
      why: "fields are copied only when they are strings",
      fix: "typeof checks",
    });
  });
});

describe("toLogEntry: sentinel security", () => {
  const rawEntry = {
    _id: "1",
    timestamp: "2026-10-23T10:00:00.000Z",
    type: "error",
    msg: "boom",
    traceId: "trace-1",
    meta: {
      flowId: "f1",
      channel: "webchat",
      text: SENTINEL_TEXT,
      URLToken: SENTINEL_URL_TOKEN,
      nested: {
        URLToken: SENTINEL_URL_TOKEN,
        text: SENTINEL_TEXT,
        a: { b: { URLToken: SENTINEL_URL_TOKEN } },
      },
      list: [{ URLToken: SENTINEL_URL_TOKEN }, SENTINEL_TEXT],
    },
  };

  it("never outputs meta.text or meta.URLToken", () => {
    const json = JSON.stringify(toLogEntry(rawEntry));
    expectExact(
      [json.includes(SENTINEL_TEXT), json.includes(SENTINEL_URL_TOKEN)],
      [false, false],
      {
        what: "sentinel leak in toLogEntry output",
        why: "end-user text and endpoint URLToken must never be output",
        fix: "copy only allowlisted fields",
      },
    );
  });

  it("drops URLToken/text at any depth even when an allowlisted field holds an object", () => {
    const out = toLogEntry({
      type: "info",
      traceId: { URLToken: SENTINEL_URL_TOKEN },
      meta: {
        flowId: { URLToken: SENTINEL_URL_TOKEN, text: SENTINEL_TEXT },
        flowName: { a: { URLToken: SENTINEL_URL_TOKEN } },
        channel: [SENTINEL_TEXT],
      },
      metadata: {
        type: "warn",
        URLToken: SENTINEL_URL_TOKEN,
        text: SENTINEL_TEXT,
      },
    });
    const json = JSON.stringify(out);
    expectExact(
      [
        json.includes(SENTINEL_TEXT),
        json.includes(SENTINEL_URL_TOKEN),
        sortedKeys(out),
      ],
      [false, false, ["level", "msg", "timestamp"]],
      {
        what: "object-valued allowlisted fields",
        why: "non-string values are omitted, never copied by reference",
        fix: "typeof === 'string' before copying",
      },
    );
  });

  it("does not leak sentinels placed in extra top-level raw keys or v2 metadata", () => {
    const json = JSON.stringify(
      toLogEntry({
        type: "info",
        text: SENTINEL_TEXT,
        URLToken: SENTINEL_URL_TOKEN,
        metadata: {
          type: "warn",
          text: SENTINEL_TEXT,
          URLToken: SENTINEL_URL_TOKEN,
        },
      }),
    );
    expectExact(
      [json.includes(SENTINEL_TEXT), json.includes(SENTINEL_URL_TOKEN)],
      [false, false],
      {
        what: "top-level extra keys",
        why: "no key outside the allowlist is copied",
        fix: "no spreads",
      },
    );
  });
});
