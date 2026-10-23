export const MAX_MESSAGE_CHARS = 500;
export const MAX_TEMPLATE_CHARS = 200;
export const MAX_SCRUB_INPUT_CHARS = 2000;

export interface LogEntry {
  timestamp: string;
  level: string;
  msg: string;
  flowId?: string;
  flowName?: string;
  channel?: string;
  traceId?: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const OPAQUE = /[A-Za-z0-9]{40,}/g;
const UUID_SRC =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const OBJECT_ID_SRC = "(?<![A-Za-z0-9])[0-9a-fA-F]{24}(?![A-Za-z0-9])";
const DIGITS_OR_ID = new RegExp(`${UUID_SRC}|${OBJECT_ID_SRC}|\\d{9,}`, "g");
const ID_ONLY = new RegExp(`${UUID_SRC}|${OBJECT_ID_SRC}`, "g");
const QUOTED = /"([^"]*)"|'([^']*)'/g;
const NUMBER =
  /(\b(?:status|http|code|error|errno)\s*[:=]?\s*)(\d{3})(?!\d)|\d+(?:\.\d+)?/gi;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function scrubText(input: unknown, maxChars: number): string {
  if (typeof input !== "string") return "";
  const cleaned = collapse(input.slice(0, MAX_SCRUB_INPUT_CHARS))
    .replace(EMAIL, "<email>")
    .replace(JWT, "<token>")
    .replace(BEARER, "$1 <token>")
    .replace(OPAQUE, "<token>")
    .replace(DIGITS_OR_ID, (match) =>
      /^\d{9,}$/.test(match) ? "<digits>" : match,
    );
  return truncate(cleaned, maxChars);
}

export function messageTemplate(msg: unknown): string {
  const scrubbed = scrubText(msg, MAX_SCRUB_INPUT_CHARS)
    .replace(ID_ONLY, "<id>")
    .replace(
      QUOTED,
      (match, dq: string | undefined, sq: string | undefined) => {
        const inner = dq ?? sq ?? "";
        return inner.includes(" ") || inner.length > 40 ? "<str>" : match;
      },
    )
    .replace(NUMBER, (match, keep: string | undefined) =>
      keep !== undefined ? match : "N",
    );
  return truncate(collapse(scrubbed), MAX_TEMPLATE_CHARS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function toLogEntry(raw: unknown): LogEntry {
  const source = isPlainObject(raw) ? raw : {};
  const metadata = isPlainObject(source.metadata) ? source.metadata : {};
  const entry: LogEntry = {
    timestamp:
      typeof source.timestamp === "string" ? source.timestamp.slice(0, 40) : "",
    level: (
      nonEmptyString(source.type) ??
      nonEmptyString(metadata.type) ??
      "unknown"
    ).slice(0, 20),
    msg: scrubText(source.msg, MAX_MESSAGE_CHARS),
  };
  if (isPlainObject(source.meta)) {
    const flowId = nonEmptyString(source.meta.flowId);
    if (flowId) entry.flowId = flowId.slice(0, 64);
    const flowName =
      typeof source.meta.flowName === "string"
        ? collapse(source.meta.flowName).slice(0, 100)
        : "";
    if (flowName) entry.flowName = flowName;
    const channel = nonEmptyString(source.meta.channel);
    if (channel) entry.channel = channel.slice(0, 40);
  }
  const traceId = nonEmptyString(source.traceId);
  if (traceId) entry.traceId = traceId.slice(0, 64);
  return entry;
}
