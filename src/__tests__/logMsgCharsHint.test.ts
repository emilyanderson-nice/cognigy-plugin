/**
 * M2: the entries-view hint says when messages were cut by the msgChars cap.
 * The client is a mock; nothing here touches a real Cognigy environment.
 */
import { describe, it, beforeEach, jest } from "@jest/globals";

import { readLogs } from "../tools/logReader.js";
import {
  PROJECT,
  Mock,
  item,
  queue,
  expectExact,
  opts,
} from "./helpers/logFixtures.js";

const DEFAULT_SENTENCE =
  "Showing the last hour by default; pass startDate (log retention is typically about 24 hours) to look further back.";
const START = "2026-10-23T10:00:00.000Z";
const cutSentence = (n: number) =>
  `Some messages were cut at ${n} characters; pass msgChars (up to 4000) to read them in full.`;
const words = (n: number) =>
  "abcd ".repeat(Math.ceil(n / 5)).slice(0, n - 1) + "e";
const spec = (what: string, fix = "") => ({
  what,
  why: "M2: in the entries view (window and session path), when at least one returned message was cut and msgChars < 4000, hint.action gets the exact sentence after the existing text and the window sentence; never otherwise",
  fix:
    fix ||
    "append the exact sentence when any entry msg was truncated by the cap and msgChars < 4000",
});

describe("readLogs msgChars hint (M2)", () => {
  let client: Mock;

  beforeEach(() => {
    client = jest.fn() as Mock;
  });

  const run = (args: Record<string, unknown>) =>
    readLogs(
      { get: client } as any,
      { projectId: PROJECT, ...args } as any,
      opts,
    );
  const action = async (args: Record<string, unknown>, msgs: string[]) => {
    client = jest.fn() as Mock;
    queue(client, [
      {
        items: msgs.map((m, i) => item(i + 1, { msg: m })),
        total: args.sessionId ? -1 : msgs.length,
      },
    ]);
    const r = await run(args);
    return String(r.hint?.action);
  };
  const count = (h: string, n: string) => h.split(n).length - 1;

  describe("sentence present when something was cut", () => {
    it.each([
      [undefined, 500, 600],
      [1000, 1000, 1200],
      [100, 100, 150],
      [3999, 3999, 4500],
    ] as Array<[number | undefined, number, number]>)(
      "window path, msgChars %p: sentence for %p ends the hint after the window sentence",
      async (given, shown, len) => {
        const a = await action({ view: "entries", msgChars: given }, [
          "short",
          words(len),
        ]);
        expectExact(
          [
            a.endsWith(cutSentence(shown)),
            count(a, cutSentence(shown)),
            a.indexOf(DEFAULT_SENTENCE) >= 0 &&
              a.indexOf(DEFAULT_SENTENCE) < a.indexOf(cutSentence(shown)),
            count(a, "typically about 24 hours"),
          ],
          [true, 1, true, 1],
          spec(`window path msgChars ${given}`),
        );
      },
    );

    it("session path: the sentence is appended", async () => {
      const a = await action(
        { view: "entries", sessionId: "s1", msgChars: 200 },
        [words(300)],
      );
      expectExact(
        [a.endsWith(cutSentence(200)), count(a, cutSentence(200))],
        [true, 1],
        spec("session path"),
      );
    });

    it("with startDate supplied the sentence is still added (no window sentence)", async () => {
      const a = await action(
        { view: "entries", startDate: START, msgChars: 200 },
        [words(300)],
      );
      expectExact(
        [
          a.endsWith(cutSentence(200)),
          a.includes(DEFAULT_SENTENCE),
          count(a, "typically about 24 hours"),
        ],
        [true, false, 1],
        spec("startDate supplied"),
      );
    });

    it("one cut entry among several is enough", async () => {
      const a = await action({ view: "entries", msgChars: 100 }, [
        "a",
        "b",
        words(101),
      ]);
      expectExact(
        count(a, cutSentence(100)),
        1,
        spec("cut boundary: 101 characters at cap 100"),
      );
    });
  });

  describe("sentence absent", () => {
    it.each([
      ["nothing cut, default cap", {}, [words(500)]],
      ["nothing cut, msgChars 1000", { msgChars: 1000 }, [words(1000)]],
      ["exactly at the cap is not cut", { msgChars: 100 }, [words(100)]],
      ["msgChars 4000 even when cut", { msgChars: 4000 }, [words(4500)]],
    ] as Array<[string, Record<string, unknown>, string[]]>)(
      "window path, %s",
      async (label, extra, msgs) => {
        const a = await action({ view: "entries", ...extra }, msgs);
        expectExact(
          a.includes("pass msgChars"),
          false,
          spec(label, "do not add the sentence in this case"),
        );
      },
    );

    it("session path with msgChars 4000", async () => {
      const a = await action(
        { view: "entries", sessionId: "s1", msgChars: 4000 },
        [words(4500)],
      );
      expectExact(a.includes("pass msgChars"), false, spec("session 4000"));
    });

    it("summary view never carries it, even with long messages and msgChars", async () => {
      const a = await action({ view: "summary", msgChars: 100 }, [words(600)]);
      expectExact(a.includes("pass msgChars"), false, spec("summary view"));
    });
  });

  describe("existing hint behavior is unchanged", () => {
    it("a default entries hint with nothing cut still ends with the window sentence and has the retention phrase once", async () => {
      const a = await action({ view: "entries" }, ["short"]);
      expectExact(
        [a.endsWith(DEFAULT_SENTENCE), count(a, "typically about 24 hours")],
        [true, 1],
        spec("default entries hint"),
      );
    });
  });
});
