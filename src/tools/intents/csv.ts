export const MIN_SENTENCES = 5;
export const PREVIEW_CHARS = 40;

export interface CsvRow {
  intent: string;
  sentence: string;
  line: number;
}

export type CsvError = {
  line: number;
  error:
    | "wrong_column_count"
    | "unexpected_column_2"
    | "empty_field"
    | "unterminated_quote";
};

const EXAMPLE_COLUMN = "exampleSentence";
const COLUMNS = 3;

interface RawRecord {
  fields: string[];
  /** True when the record is a single unquoted whitespace-only field. */
  blank: boolean;
  startLine: number;
}

/**
 * Splits text into records. Returns the records parsed so far and, when a
 * quoted field never closes, the line it started on.
 */
function splitRecords(text: string): {
  records: RawRecord[];
  unterminatedAt?: number;
} {
  const records: RawRecord[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;

  while (i < n) {
    const startLine = line;
    const fields: string[] = [];
    let anyQuoted = false;
    let endOfRecord = false;

    while (!endOfRecord) {
      // Skip spaces before a possible opening quote.
      let j = i;
      while (j < n && (text[j] === " " || text[j] === "\t")) j++;
      let value = "";

      if (text[j] === '"') {
        anyQuoted = true;
        i = j + 1;
        let closed = false;
        while (i < n) {
          const ch = text[i];
          if (ch === '"') {
            if (text[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            closed = true;
            i += 1;
            break;
          }
          if (ch === "\n") line += 1;
          value += ch;
          i += 1;
        }
        if (!closed) return { records, unterminatedAt: startLine };
      }

      // Unquoted content (or trailing content after a closing quote).
      while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
        value += text[i];
        i += 1;
      }
      fields.push(value);

      if (i >= n) {
        endOfRecord = true;
      } else if (text[i] === ",") {
        i += 1;
      } else {
        if (text[i] === "\r" && text[i + 1] === "\n") i += 1;
        i += 1;
        line += 1;
        endOfRecord = true;
      }
    }

    records.push({
      fields,
      blank: !anyQuoted && fields.length === 1 && fields[0].trim() === "",
      startLine,
    });
  }
  return { records };
}

export function parseIntentCsv(text: string): {
  rows: CsvRow[];
  errors: CsvError[];
} {
  const rows: CsvRow[] = [];
  const errors: CsvError[] = [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const { records, unterminatedAt } = splitRecords(body);

  for (const record of records) {
    if (record.blank) continue;
    const { fields, startLine: line } = record;
    if (fields.length !== COLUMNS) {
      errors.push({ line, error: "wrong_column_count" });
    } else if (fields[1].trim() !== EXAMPLE_COLUMN) {
      errors.push({ line, error: "unexpected_column_2" });
    } else if (fields[0].trim() === "" || fields[2].trim() === "") {
      errors.push({ line, error: "empty_field" });
    } else {
      rows.push({ intent: fields[0].trim(), sentence: fields[2].trim(), line });
    }
  }
  if (unterminatedAt !== undefined) {
    errors.push({ line: unterminatedAt, error: "unterminated_quote" });
  }
  return { rows, errors };
}

export function preview(sentence: string): string {
  return sentence.length > PREVIEW_CHARS
    ? `${sentence.slice(0, PREVIEW_CHARS)}...`
    : sentence;
}

export interface FlowIntentCount {
  name: string;
  sentenceCount: number;
}

export interface CompareReport {
  missing: string[];
  extra: string[];
  duplicateIntentNames: string[];
  duplicateSentences: Array<{
    intent: string;
    sentence: string;
    count: number;
  }>;
  wrongCount: Array<{ intent: string; csvCount: number; flowCount: number }>;
  summary: {
    flowIntents: number;
    csvIntents: number;
    csvRows: number;
    matching: number;
  };
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const countBy = <T>(
  items: T[],
  key: (item: T) => string,
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
};

export function compareIntents(
  flow: FlowIntentCount[],
  inputRows: CsvRow[],
): CompareReport {
  // Normalise once: rows may be built by hand, not only by parseIntentCsv.
  const rows = inputRows.map((r) => ({
    ...r,
    intent: r.intent.trim(),
    sentence: r.sentence.trim(),
  }));
  const flowNames = countBy(flow, (f) => f.name.trim());
  const flowCountOf = new Map<string, number>();
  for (const f of flow) flowCountOf.set(f.name.trim(), f.sentenceCount);
  const csvCounts = countBy(rows, (r) => r.intent);

  const duplicateNames = [...flowNames]
    .filter(([, c]) => c > 1)
    .map(([name]) => name)
    .sort(byString);
  const duplicated = new Set(duplicateNames);

  const missing = [...csvCounts.keys()]
    .filter((n) => !flowNames.has(n))
    .sort(byString);
  const extra = [...flowNames.keys()]
    .filter((n) => !csvCounts.has(n))
    .sort(byString);

  const wrongCount: CompareReport["wrongCount"] = [];
  let matching = 0;
  for (const [intent, csvCount] of csvCounts) {
    if (!flowNames.has(intent) || duplicated.has(intent)) continue;
    const flowCount = flowCountOf.get(intent) ?? 0;
    if (flowCount === csvCount) matching += 1;
    else wrongCount.push({ intent, csvCount, flowCount });
  }
  wrongCount.sort((a, b) => byString(a.intent, b.intent));

  const sentenceCounts = countBy(rows, (r) => `${r.intent}\u0000${r.sentence}`);
  const duplicateSentences: CompareReport["duplicateSentences"] = [];
  for (const [key, count] of sentenceCounts) {
    if (count < 2) continue;
    const [intent, sentence] = key.split("\u0000");
    duplicateSentences.push({ intent, sentence: preview(sentence), count });
  }
  duplicateSentences.sort(
    (a, b) => byString(a.intent, b.intent) || byString(a.sentence, b.sentence),
  );

  return {
    missing,
    extra,
    duplicateIntentNames: duplicateNames,
    duplicateSentences,
    wrongCount,
    summary: {
      flowIntents: flow.length,
      csvIntents: csvCounts.size,
      csvRows: rows.length,
      matching,
    },
  };
}

export interface BelowMinimumEntry {
  name: string;
  id?: string;
  sentenceCount: number;
  missing: number;
}

export function belowMinimum(
  intents: Array<{ name: string; id?: string; sentenceCount: number }>,
  min: number = MIN_SENTENCES,
): { threshold: number; count: number; intents: BelowMinimumEntry[] } {
  const listed = intents
    .filter((i) => i.sentenceCount < min)
    .map((i) => ({ ...i, missing: min - i.sentenceCount }))
    .sort(
      (a, b) => a.sentenceCount - b.sentenceCount || byString(a.name, b.name),
    );
  return { threshold: min, count: listed.length, intents: listed };
}
