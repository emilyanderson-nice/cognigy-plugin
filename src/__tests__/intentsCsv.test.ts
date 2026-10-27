import { describe, it, expect } from "@jest/globals";
import {
  MIN_SENTENCES,
  PREVIEW_CHARS,
  parseIntentCsv,
  preview,
  compareIntents,
  belowMinimum,
  type CsvRow,
} from "../tools/intents/csv.js";

const row = (intent: string, sentence: string, line = 1): CsvRow => ({
  intent,
  sentence,
  line,
});

const rowsOf = (intent: string, n: number): CsvRow[] =>
  Array.from({ length: n }, (_, i) =>
    row(intent, `sample ${intent} ${i}`, i + 1),
  );

describe("constants", () => {
  it("MIN_SENTENCES is 5 and PREVIEW_CHARS is 40", () => {
    expect(MIN_SENTENCES).toBe(5);
    expect(PREVIEW_CHARS).toBe(40);
  });
});

describe("parseIntentCsv", () => {
  it("parses LF rows with no header into intent, sentence and 1-based line", () => {
    const text =
      "Billing,exampleSentence,alpha sample one\nSupport,exampleSentence,beta sample two\n";
    expect(parseIntentCsv(text)).toEqual({
      rows: [
        { intent: "Billing", sentence: "alpha sample one", line: 1 },
        { intent: "Support", sentence: "beta sample two", line: 2 },
      ],
      errors: [],
    });
  });

  it("does not treat the first line as a header", () => {
    const r = parseIntentCsv("Billing,exampleSentence,first line\n");
    expect(r.rows).toEqual([
      { intent: "Billing", sentence: "first line", line: 1 },
    ]);
  });

  it("parses CRLF line endings without leaving a carriage return in the sentence", () => {
    const text =
      "Billing,exampleSentence,alpha sample one\r\nSupport,exampleSentence,beta sample two\r\n";
    expect(parseIntentCsv(text)).toEqual({
      rows: [
        { intent: "Billing", sentence: "alpha sample one", line: 1 },
        { intent: "Support", sentence: "beta sample two", line: 2 },
      ],
      errors: [],
    });
  });

  it("strips a leading BOM from the first intent name", () => {
    const r = parseIntentCsv("﻿Billing,exampleSentence,alpha sample one\n");
    expect(r).toEqual({
      rows: [{ intent: "Billing", sentence: "alpha sample one", line: 1 }],
      errors: [],
    });
  });

  it("accepts a last record with no trailing newline", () => {
    const r = parseIntentCsv(
      "Billing,exampleSentence,one\nSupport,exampleSentence,two",
    );
    expect(r.rows).toEqual([
      { intent: "Billing", sentence: "one", line: 1 },
      { intent: "Support", sentence: "two", line: 2 },
    ]);
    expect(r.errors).toEqual([]);
  });

  it("keeps commas inside a quoted sentence", () => {
    const r = parseIntentCsv('Billing,exampleSentence,"alpha, beta, gamma"\n');
    expect(r).toEqual({
      rows: [{ intent: "Billing", sentence: "alpha, beta, gamma", line: 1 }],
      errors: [],
    });
  });

  it("keeps commas inside a quoted intent name", () => {
    const r = parseIntentCsv(
      '"Billing, Cards",exampleSentence,alpha sample one\n',
    );
    expect(r.rows).toEqual([
      { intent: "Billing, Cards", sentence: "alpha sample one", line: 1 },
    ]);
  });

  it("turns a doubled quote inside a quoted field into a single quote", () => {
    const r = parseIntentCsv('Billing,exampleSentence,"say ""alpha"" now"\n');
    expect(r.rows).toEqual([
      { intent: "Billing", sentence: 'say "alpha" now', line: 1 },
    ]);
    expect(r.errors).toEqual([]);
  });

  it("a quoted field of only an escaped quote yields one quote character", () => {
    const r = parseIntentCsv('Billing,exampleSentence,""""\n');
    expect(r.rows).toEqual([{ intent: "Billing", sentence: '"', line: 1 }]);
  });

  it("keeps a newline inside a quoted field and numbers later lines physically", () => {
    const text =
      'Billing,exampleSentence,"alpha line one\nalpha line two"\nSupport,exampleSentence,beta sample two\n';
    expect(parseIntentCsv(text)).toEqual({
      rows: [
        {
          intent: "Billing",
          sentence: "alpha line one\nalpha line two",
          line: 1,
        },
        { intent: "Support", sentence: "beta sample two", line: 3 },
      ],
      errors: [],
    });
  });

  it("reports the start line of a record when a bad record follows a multi-line one", () => {
    const text =
      'Billing,exampleSentence,"one\ntwo\nthree"\nSupport,wrong,beta sample two\n';
    const r = parseIntentCsv(text);
    expect(r.rows).toEqual([
      { intent: "Billing", sentence: "one\ntwo\nthree", line: 1 },
    ]);
    expect(r.errors).toEqual([{ line: 4, error: "unexpected_column_2" }]);
  });

  it("trims whitespace around intent and sentence but not inside the sentence", () => {
    const r = parseIntentCsv(
      "  Billing  ,exampleSentence,  alpha   sample one  \n",
    );
    expect(r.rows).toEqual([
      { intent: "Billing", sentence: "alpha   sample one", line: 1 },
    ]);
  });

  it("trims whitespace around quoted fields", () => {
    const r = parseIntentCsv(
      'Billing,exampleSentence,"  alpha sample one  "\n',
    );
    expect(r.rows).toEqual([
      { intent: "Billing", sentence: "alpha sample one", line: 1 },
    ]);
  });

  it("skips blank and whitespace-only lines without error and keeps physical line numbers", () => {
    const text =
      "Billing,exampleSentence,one\n\n   \t\nSupport,exampleSentence,two\n\n";
    expect(parseIntentCsv(text)).toEqual({
      rows: [
        { intent: "Billing", sentence: "one", line: 1 },
        { intent: "Support", sentence: "two", line: 4 },
      ],
      errors: [],
    });
  });

  it("empty text gives no rows and no errors", () => {
    expect(parseIntentCsv("")).toEqual({ rows: [], errors: [] });
  });

  it("text of only blank lines gives no rows and no errors", () => {
    expect(parseIntentCsv("\n\r\n  \n")).toEqual({ rows: [], errors: [] });
  });

  it("two columns give wrong_column_count and no row", () => {
    expect(parseIntentCsv("Billing,alpha sample one\n")).toEqual({
      rows: [],
      errors: [{ line: 1, error: "wrong_column_count" }],
    });
  });

  it("four columns give wrong_column_count (an unquoted comma in a sentence)", () => {
    expect(parseIntentCsv("Billing,exampleSentence,alpha, beta\n")).toEqual({
      rows: [],
      errors: [{ line: 1, error: "wrong_column_count" }],
    });
  });

  it("a column 2 other than exampleSentence gives unexpected_column_2", () => {
    expect(parseIntentCsv("Billing,sentence,alpha sample one\n")).toEqual({
      rows: [],
      errors: [{ line: 1, error: "unexpected_column_2" }],
    });
  });

  it("column 2 is compared exactly, so a different case is unexpected_column_2", () => {
    expect(
      parseIntentCsv("Billing,examplesentence,alpha sample one\n").errors,
    ).toEqual([{ line: 1, error: "unexpected_column_2" }]);
  });

  it("an empty intent gives empty_field", () => {
    expect(parseIntentCsv(",exampleSentence,alpha sample one\n")).toEqual({
      rows: [],
      errors: [{ line: 1, error: "empty_field" }],
    });
  });

  it("a whitespace-only intent gives empty_field", () => {
    expect(
      parseIntentCsv("   ,exampleSentence,alpha sample one\n").errors,
    ).toEqual([{ line: 1, error: "empty_field" }]);
  });

  it("an empty sentence gives empty_field", () => {
    expect(parseIntentCsv("Billing,exampleSentence,\n")).toEqual({
      rows: [],
      errors: [{ line: 1, error: "empty_field" }],
    });
  });

  it("a quoted empty sentence gives empty_field", () => {
    expect(parseIntentCsv('Billing,exampleSentence,""\n').errors).toEqual([
      { line: 1, error: "empty_field" },
    ]);
  });

  it("a whitespace-only sentence gives empty_field", () => {
    expect(parseIntentCsv("Billing,exampleSentence,   \n").errors).toEqual([
      { line: 1, error: "empty_field" },
    ]);
  });

  it("a bad record adds an error and no row, and parsing continues", () => {
    const text = [
      "Billing,exampleSentence,good one",
      "Billing,oops,bad column two",
      "Billing,exampleSentence,good two",
      "Billing,exampleSentence",
      "Support,exampleSentence,good three",
      ",exampleSentence,missing intent",
    ].join("\n");
    expect(parseIntentCsv(text)).toEqual({
      rows: [
        { intent: "Billing", sentence: "good one", line: 1 },
        { intent: "Billing", sentence: "good two", line: 3 },
        { intent: "Support", sentence: "good three", line: 5 },
      ],
      errors: [
        { line: 2, error: "unexpected_column_2" },
        { line: 4, error: "wrong_column_count" },
        { line: 6, error: "empty_field" },
      ],
    });
  });

  it("an unterminated quote reports the record's start line, stops parsing and keeps earlier rows", () => {
    const text = [
      "Billing,exampleSentence,good one",
      "Support,exampleSentence,good two",
      'Billing,exampleSentence,"never closed',
      "Support,exampleSentence,swallowed by the quote",
    ].join("\n");
    expect(parseIntentCsv(text)).toEqual({
      rows: [
        { intent: "Billing", sentence: "good one", line: 1 },
        { intent: "Support", sentence: "good two", line: 2 },
      ],
      errors: [{ line: 3, error: "unterminated_quote" }],
    });
  });

  it("keeps errors found before an unterminated quote", () => {
    const text = [
      "Billing,wrong,bad one",
      'Support,exampleSentence,"open',
    ].join("\n");
    expect(parseIntentCsv(text)).toEqual({
      rows: [],
      errors: [
        { line: 1, error: "unexpected_column_2" },
        { line: 2, error: "unterminated_quote" },
      ],
    });
  });

  it("an unterminated quote in the first column is reported on its start line", () => {
    expect(parseIntentCsv('"Billing,exampleSentence,alpha\n')).toEqual({
      rows: [],
      errors: [{ line: 1, error: "unterminated_quote" }],
    });
  });
});

describe("preview", () => {
  it("returns a short sentence unchanged", () => {
    expect(preview("alpha sample one")).toBe("alpha sample one");
  });

  it("returns an empty sentence unchanged", () => {
    expect(preview("")).toBe("");
  });

  it("returns a sentence of exactly 40 characters unchanged", () => {
    const s = "a".repeat(40);
    expect(preview(s)).toBe(s);
  });

  it("cuts a sentence of 41 characters to 40 characters plus three dots", () => {
    const s = "a".repeat(40) + "b";
    expect(preview(s)).toBe("a".repeat(40) + "...");
  });

  it("keeps the first 40 characters of a long sentence", () => {
    const s = "0123456789".repeat(5);
    expect(preview(s)).toBe("0123456789012345678901234567890123456789...");
  });
});

describe("compareIntents", () => {
  // flow: Billing 3, Cards 2, Orphan 1, Dup 2, Dup 2
  // csv:  Billing x3 (matches), Cards x3 (wrong), New x1 (missing), Dup x2
  const flow = [
    { name: "Billing", sentenceCount: 3 },
    { name: "Cards", sentenceCount: 2 },
    { name: "Orphan", sentenceCount: 1 },
    { name: "Dup", sentenceCount: 2 },
    { name: "Dup", sentenceCount: 2 },
  ];
  const rows: CsvRow[] = [
    ...rowsOf("Billing", 3),
    ...rowsOf("Cards", 3),
    ...rowsOf("New", 1),
    ...rowsOf("Dup", 2),
  ];

  it("missing lists CSV intents absent from the flow", () => {
    expect(compareIntents(flow, rows).missing).toEqual(["New"]);
  });

  it("extra lists flow intents absent from the CSV", () => {
    expect(compareIntents(flow, rows).extra).toEqual(["Orphan"]);
  });

  it("duplicateIntentNames lists flow names that occur more than once, once each", () => {
    expect(compareIntents(flow, rows).duplicateIntentNames).toEqual(["Dup"]);
  });

  it("a duplicated flow name still counts as present: not missing", () => {
    expect(compareIntents(flow, rows).missing).not.toContain("Dup");
  });

  it("a duplicated flow name absent from the CSV is still extra", () => {
    const r = compareIntents(
      [
        { name: "Dup", sentenceCount: 1 },
        { name: "Dup", sentenceCount: 1 },
      ],
      [],
    );
    expect(r.extra).toEqual(["Dup"]);
    expect(r.duplicateIntentNames).toEqual(["Dup"]);
  });

  it("wrongCount lists intents in both with a different count and excludes duplicated flow names", () => {
    expect(compareIntents(flow, rows).wrongCount).toEqual([
      { intent: "Cards", csvCount: 3, flowCount: 2 },
    ]);
  });

  it("summary counts flow intents, distinct CSV intents, CSV rows and matching intents", () => {
    expect(compareIntents(flow, rows).summary).toEqual({
      flowIntents: 5,
      csvIntents: 4,
      csvRows: 9,
      matching: 1,
    });
  });

  it("returns the full report for the scenario", () => {
    expect(compareIntents(flow, rows)).toEqual({
      missing: ["New"],
      extra: ["Orphan"],
      duplicateIntentNames: ["Dup"],
      duplicateSentences: [],
      wrongCount: [{ intent: "Cards", csvCount: 3, flowCount: 2 }],
      summary: { flowIntents: 5, csvIntents: 4, csvRows: 9, matching: 1 },
    });
  });

  it("empty flow and empty CSV give an empty report", () => {
    expect(compareIntents([], [])).toEqual({
      missing: [],
      extra: [],
      duplicateIntentNames: [],
      duplicateSentences: [],
      wrongCount: [],
      summary: { flowIntents: 0, csvIntents: 0, csvRows: 0, matching: 0 },
    });
  });

  it("an identical flow and CSV report everything as matching", () => {
    const r = compareIntents(
      [
        { name: "Billing", sentenceCount: 2 },
        { name: "Support", sentenceCount: 1 },
      ],
      [...rowsOf("Billing", 2), ...rowsOf("Support", 1)],
    );
    expect(r).toEqual({
      missing: [],
      extra: [],
      duplicateIntentNames: [],
      duplicateSentences: [],
      wrongCount: [],
      summary: { flowIntents: 2, csvIntents: 2, csvRows: 3, matching: 2 },
    });
  });

  it("missing and extra are sorted by plain string comparison and have no repeats", () => {
    const r = compareIntents(
      [
        { name: "b", sentenceCount: 1 },
        { name: "a", sentenceCount: 1 },
        { name: "B", sentenceCount: 1 },
      ],
      [
        row("z", "s1"),
        row("z", "s2"),
        row("y", "s3"),
        row("Y", "s4"),
        row("y", "s5"),
      ],
    );
    expect(r.missing).toEqual(["Y", "y", "z"]);
    expect(r.extra).toEqual(["B", "a", "b"]);
  });

  it("compares names exactly after trimming, and case-sensitively", () => {
    const r = compareIntents(
      [
        { name: " Billing ", sentenceCount: 1 },
        { name: "support", sentenceCount: 1 },
      ],
      [row("Billing", "s1"), row("Support", "s2")],
    );
    expect(r.missing).toEqual(["Support"]);
    expect(r.extra).toEqual(["support"]);
    expect(r.summary.matching).toBe(1);
    expect(r.wrongCount).toEqual([]);
  });

  it("counts repeated CSV rows toward the intent count", () => {
    const r = compareIntents(
      [{ name: "Billing", sentenceCount: 2 }],
      [row("Billing", "same"), row("Billing", "same")],
    );
    expect(r.wrongCount).toEqual([]);
    expect(r.summary.matching).toBe(1);
  });

  it("a CSV count above a flow count of 0 is wrong with flowCount 0", () => {
    const r = compareIntents(
      [{ name: "Billing", sentenceCount: 0 }],
      rowsOf("Billing", 2),
    );
    expect(r.wrongCount).toEqual([
      { intent: "Billing", csvCount: 2, flowCount: 0 },
    ]);
    expect(r.summary.matching).toBe(0);
  });

  it("wrongCount is sorted by intent and reports both counts", () => {
    const r = compareIntents(
      [
        { name: "Zed", sentenceCount: 1 },
        { name: "Alpha", sentenceCount: 5 },
        { name: "Mid", sentenceCount: 2 },
      ],
      [...rowsOf("Zed", 2), ...rowsOf("Alpha", 3), ...rowsOf("Mid", 2)],
    );
    expect(r.wrongCount).toEqual([
      { intent: "Alpha", csvCount: 3, flowCount: 5 },
      { intent: "Zed", csvCount: 2, flowCount: 1 },
    ]);
    expect(r.summary.matching).toBe(1);
  });

  it("duplicateIntentNames is sorted and lists each name once even when it occurs three times", () => {
    const r = compareIntents(
      [
        { name: "Zed", sentenceCount: 1 },
        { name: "Alpha", sentenceCount: 1 },
        { name: "Zed", sentenceCount: 1 },
        { name: "Zed", sentenceCount: 1 },
        { name: "Alpha", sentenceCount: 1 },
      ],
      [],
    );
    expect(r.duplicateIntentNames).toEqual(["Alpha", "Zed"]);
    expect(r.summary.flowIntents).toBe(5);
  });

  describe("duplicateSentences", () => {
    const flowOne = [{ name: "Billing", sentenceCount: 3 }];

    it("reports a sentence repeated within one intent with its row count", () => {
      const r = compareIntents(flowOne, [
        row("Billing", "alpha sample one"),
        row("Billing", "beta sample two"),
        row("Billing", "alpha sample one"),
      ]);
      expect(r.duplicateSentences).toEqual([
        { intent: "Billing", sentence: "alpha sample one", count: 2 },
      ]);
    });

    it("counts three repeats as 3 in one entry", () => {
      const r = compareIntents(flowOne, [
        row("Billing", "alpha"),
        row("Billing", "alpha"),
        row("Billing", "alpha"),
      ]);
      expect(r.duplicateSentences).toEqual([
        { intent: "Billing", sentence: "alpha", count: 3 },
      ]);
    });

    it("compares the sentence exactly after trimming", () => {
      const r = compareIntents(flowOne, [
        row("Billing", "alpha "),
        row("Billing", "alpha"),
      ]);
      expect(r.duplicateSentences).toEqual([
        { intent: "Billing", sentence: "alpha", count: 2 },
      ]);
    });

    it("treats a different case as a different sentence", () => {
      const r = compareIntents(flowOne, [
        row("Billing", "Alpha"),
        row("Billing", "alpha"),
      ]);
      expect(r.duplicateSentences).toEqual([]);
    });

    it("does not report the same sentence used in two different intents", () => {
      const r = compareIntents(
        [
          { name: "Billing", sentenceCount: 1 },
          { name: "Support", sentenceCount: 1 },
        ],
        [row("Billing", "shared text"), row("Support", "shared text")],
      );
      expect(r.duplicateSentences).toEqual([]);
    });

    it("reports a long repeated sentence as its 40-character preview", () => {
      const long = "x".repeat(41);
      const r = compareIntents(flowOne, [
        row("Billing", long),
        row("Billing", long),
      ]);
      expect(r.duplicateSentences).toEqual([
        { intent: "Billing", sentence: "x".repeat(40) + "...", count: 2 },
      ]);
    });

    it("is sorted by intent, then by sentence, one entry per distinct repeated sentence", () => {
      const r = compareIntents(
        [
          { name: "Zed", sentenceCount: 4 },
          { name: "Alpha", sentenceCount: 6 },
        ],
        [
          row("Zed", "one"),
          row("Zed", "one"),
          row("Alpha", "pear"),
          row("Alpha", "apple"),
          row("Alpha", "pear"),
          row("Alpha", "apple"),
          row("Alpha", "apple"),
          row("Alpha", "unique"),
          row("Zed", "one"),
        ],
      );
      expect(r.duplicateSentences).toEqual([
        { intent: "Alpha", sentence: "apple", count: 3 },
        { intent: "Alpha", sentence: "pear", count: 2 },
        { intent: "Zed", sentence: "one", count: 3 },
      ]);
    });
  });
});

describe("parseIntentCsv column 2 padding", () => {
  it("accepts a column 2 padded with spaces", () => {
    expect(
      parseIntentCsv("Billing,  exampleSentence  ,alpha sample one\n"),
    ).toEqual({
      rows: [{ intent: "Billing", sentence: "alpha sample one", line: 1 }],
      errors: [],
    });
  });
});

describe("compareIntents ordering regardless of input order", () => {
  it("missing is ascending for input order b, c, a", () => {
    const r = compareIntents(
      [],
      [row("b", "s1"), row("c", "s2"), row("a", "s3")],
    );
    expect(r.missing).toEqual(["a", "b", "c"]);
  });

  it("extra is ascending for input order b, c, a", () => {
    const r = compareIntents(
      [
        { name: "b", sentenceCount: 1 },
        { name: "c", sentenceCount: 1 },
        { name: "a", sentenceCount: 1 },
      ],
      [],
    );
    expect(r.extra).toEqual(["a", "b", "c"]);
  });

  it("duplicateIntentNames is ascending for input order b, c, a", () => {
    const flowNames = ["b", "c", "a", "b", "c", "a"];
    const r = compareIntents(
      flowNames.map((name) => ({ name, sentenceCount: 1 })),
      [],
    );
    expect(r.duplicateIntentNames).toEqual(["a", "b", "c"]);
  });

  it("wrongCount is ascending by intent for input order b, c, a", () => {
    const r = compareIntents(
      [
        { name: "b", sentenceCount: 1 },
        { name: "c", sentenceCount: 1 },
        { name: "a", sentenceCount: 1 },
      ],
      [...rowsOf("b", 2), ...rowsOf("c", 3), ...rowsOf("a", 4)],
    );
    expect(r.wrongCount).toEqual([
      { intent: "a", csvCount: 4, flowCount: 1 },
      { intent: "b", csvCount: 2, flowCount: 1 },
      { intent: "c", csvCount: 3, flowCount: 1 },
    ]);
  });

  it("duplicateSentences is ascending by intent for input order b, c, a", () => {
    const r = compareIntents(
      [
        { name: "b", sentenceCount: 2 },
        { name: "c", sentenceCount: 2 },
        { name: "a", sentenceCount: 2 },
      ],
      [
        row("b", "dup"),
        row("b", "dup"),
        row("c", "dup"),
        row("c", "dup"),
        row("a", "dup"),
        row("a", "dup"),
      ],
    );
    expect(r.duplicateSentences).toEqual([
      { intent: "a", sentence: "dup", count: 2 },
      { intent: "b", sentence: "dup", count: 2 },
      { intent: "c", sentence: "dup", count: 2 },
    ]);
  });

  it("duplicateSentences is ascending by sentence within one intent for input order b, c, a", () => {
    const r = compareIntents(
      [{ name: "Billing", sentenceCount: 6 }],
      ["b", "b", "c", "c", "a", "a"].map((s) => row("Billing", s)),
    );
    expect(r.duplicateSentences).toEqual([
      { intent: "Billing", sentence: "a", count: 2 },
      { intent: "Billing", sentence: "b", count: 2 },
      { intent: "Billing", sentence: "c", count: 2 },
    ]);
  });
});

describe("compareIntents trims rows built directly", () => {
  it("matches a row intent with trailing space to the flow intent", () => {
    const r = compareIntents(
      [{ name: "Billing", sentenceCount: 1 }],
      [row("Billing ", "alpha")],
    );
    expect(r).toEqual({
      missing: [],
      extra: [],
      duplicateIntentNames: [],
      duplicateSentences: [],
      wrongCount: [],
      summary: { flowIntents: 1, csvIntents: 1, csvRows: 1, matching: 1 },
    });
  });

  it("counts rows with differently padded intent names as one intent", () => {
    const r = compareIntents(
      [{ name: "Billing", sentenceCount: 2 }],
      [row(" Billing", "alpha"), row("Billing ", "beta")],
    );
    expect(r.summary).toEqual({
      flowIntents: 1,
      csvIntents: 1,
      csvRows: 2,
      matching: 1,
    });
    expect(r.wrongCount).toEqual([]);
  });

  it("counts 'alpha' and ' alpha ' as the same duplicate sentence", () => {
    const r = compareIntents(
      [{ name: "Billing", sentenceCount: 2 }],
      [row("Billing", "alpha"), row("Billing", " alpha ")],
    );
    expect(r.duplicateSentences).toEqual([
      { intent: "Billing", sentence: "alpha", count: 2 },
    ]);
  });
});

describe("belowMinimum", () => {
  it("defaults the threshold to 5, lists 4 and not 5, with the missing count", () => {
    const r = belowMinimum([
      { name: "Four", sentenceCount: 4 },
      { name: "Five", sentenceCount: 5 },
      { name: "Six", sentenceCount: 6 },
    ]);
    expect(r).toEqual({
      threshold: 5,
      count: 1,
      intents: [{ name: "Four", sentenceCount: 4, missing: 1 }],
    });
  });

  it("lists an intent with zero sentences as missing 5", () => {
    expect(belowMinimum([{ name: "Empty", sentenceCount: 0 }])).toEqual({
      threshold: 5,
      count: 1,
      intents: [{ name: "Empty", sentenceCount: 0, missing: 5 }],
    });
  });

  it("a custom minimum changes the threshold, the boundary and the missing count", () => {
    const r = belowMinimum(
      [
        { name: "Two", sentenceCount: 2 },
        { name: "Three", sentenceCount: 3 },
        { name: "Four", sentenceCount: 4 },
      ],
      3,
    );
    expect(r).toEqual({
      threshold: 3,
      count: 1,
      intents: [{ name: "Two", sentenceCount: 2, missing: 1 }],
    });
  });

  it("a custom minimum above the default lists intents the default would accept", () => {
    const r = belowMinimum([{ name: "Five", sentenceCount: 5 }], 8);
    expect(r).toEqual({
      threshold: 8,
      count: 1,
      intents: [{ name: "Five", sentenceCount: 5, missing: 3 }],
    });
  });

  it("is sorted by sentence count ascending, then name ascending", () => {
    const r = belowMinimum([
      { name: "Beta", sentenceCount: 3 },
      { name: "Alpha", sentenceCount: 3 },
      { name: "Gamma", sentenceCount: 1 },
      { name: "Delta", sentenceCount: 4 },
      { name: "Aardvark", sentenceCount: 3 },
    ]);
    expect(r.intents.map((i) => i.name)).toEqual([
      "Gamma",
      "Aardvark",
      "Alpha",
      "Beta",
      "Delta",
    ]);
    expect(r.count).toBe(5);
  });

  it("passes the id through when present", () => {
    const r = belowMinimum([
      { name: "Four", id: "aaaaaaaaaaaaaaaaaaaaaa01", sentenceCount: 4 },
    ]);
    expect(r.intents).toEqual([
      {
        name: "Four",
        id: "aaaaaaaaaaaaaaaaaaaaaa01",
        sentenceCount: 4,
        missing: 1,
      },
    ]);
  });

  it("an empty list gives count 0", () => {
    expect(belowMinimum([])).toEqual({ threshold: 5, count: 0, intents: [] });
  });

  it("when every intent is at or above the minimum nothing is listed", () => {
    expect(
      belowMinimum([
        { name: "A", sentenceCount: 5 },
        { name: "B", sentenceCount: 50 },
      ]),
    ).toEqual({ threshold: 5, count: 0, intents: [] });
  });
});
