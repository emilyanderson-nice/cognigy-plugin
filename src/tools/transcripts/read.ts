import { scrubText } from "../logScrub.js";
import {
  type ConversationClient,
  type TranscriptResult,
  parseInstant,
  rowsOf,
  scalar,
  upstreamError,
} from "./common.js";

export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 100;
export const DEFAULT_TEXT_CHARS = 500;

const MIN_TEXT_CHARS = 100;
const MAX_TEXT_CHARS = 4000;

export interface ReadConversationOptions {
  id?: string;
  projectId?: string;
  view?: "outline" | "text";
  expertMode?: boolean;
  rawText?: boolean;
  msgChars?: number;
  limit?: number;
  skip?: number;
}

type Item = Record<string, any>;

function firstValue(items: Item[], key: string): unknown {
  for (const item of items) {
    const v = scalar(item?.[key]);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function orderByTimestamp(items: Item[]): Item[] {
  return items
    .map((item, i) => ({ item, i, t: parseInstant(item?.timestamp) }))
    .sort((a, b) => {
      if (a.t === undefined && b.t === undefined) return a.i - b.i;
      if (a.t === undefined) return 1;
      if (b.t === undefined) return -1;
      return a.t !== b.t ? a.t - b.t : a.i - b.i;
    })
    .map((x) => x.item);
}

function countBySource(items: Item[]): Record<string, number> {
  // A Map, not an object: a source such as "toString" must not hit an
  // inherited Object.prototype member.
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = typeof item?.source === "string" ? item.source : "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

function rawCut(input: unknown, maxChars: number): string {
  if (typeof input !== "string") return "";
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars - 1)}…`;
}

// Built field by field; an upstream item is never spread.
function buildMessage(
  item: Item,
  index: number,
  view: "outline" | "text",
  opts: { expertMode: boolean; rawText: boolean; msgChars: number },
): Record<string, unknown> {
  const message: Record<string, unknown> = { index };
  for (const key of ["type", "source", "timestamp"]) {
    const v = scalar(item?.[key]);
    if (v !== undefined) message[key] = v;
  }
  if (view === "outline") {
    message.textChars =
      typeof item?.inputText === "string" ? item.inputText.length : 0;
  } else {
    message.text = opts.rawText
      ? rawCut(item?.inputText, opts.msgChars)
      : scrubText(
          item?.inputText,
          opts.msgChars,
          Math.max(2000, opts.msgChars + 1000),
        );
  }
  const intent = scalar(item?.intent);
  if (opts.expertMode && intent !== undefined && intent !== null) {
    message.intent = scalar(String(intent));
    const score = scalar(item?.intentScore);
    if (typeof score === "number") message.intentScore = score;
  }
  return message;
}

const PII_ACTION =
  "The text may hold personal data: report counts and topics rather than quoting lines, and do not copy it into files, commits or prompts.";

export async function readConversation(
  client: ConversationClient,
  opts: ReadConversationOptions,
): Promise<TranscriptResult> {
  if (!opts.id) {
    throw new Error(
      "id (the session id) is required for resourceType 'conversation'.",
    );
  }
  const view = opts.view ?? "outline";
  if (opts.rawText === true && view !== "text") {
    throw new Error("rawText is only supported with view text.");
  }

  const params: Record<string, unknown> = {};
  if (opts.projectId) params.projectId = opts.projectId;
  if (opts.expertMode === true) params.expertMode = true;

  let response: any;
  try {
    response = await client.get(
      `/v2.0/conversations/${encodeURIComponent(opts.id)}`,
      { params },
    );
  } catch (error) {
    throw upstreamError("conversation", error);
  }

  const ordered = orderByTimestamp(rowsOf(response));
  if (ordered.length === 0) {
    return {
      body: { sessionId: opts.id, messageCount: 0, messages: [] },
      hint: {
        action:
          "No messages were found for that session id. Check the id, the projectId, and that the endpoint collects conversations.",
      },
    };
  }

  const skip = opts.skip ?? 0;
  const limit = Math.min(
    opts.limit ?? DEFAULT_MESSAGE_LIMIT,
    MAX_MESSAGE_LIMIT,
  );
  const msgChars = Math.min(
    MAX_TEXT_CHARS,
    Math.max(MIN_TEXT_CHARS, opts.msgChars ?? DEFAULT_TEXT_CHARS),
  );
  const rawText = opts.rawText === true;
  const expertMode = opts.expertMode === true;

  const page = ordered.slice(skip, skip + limit);
  const messages = page.map((item, i) =>
    buildMessage(item, skip + i, view, { expertMode, rawText, msgChars }),
  );

  const body: Record<string, unknown> = {
    sessionId: firstValue(ordered, "sessionId") ?? opts.id,
  };
  for (const key of ["channel", "flowName", "endpointName"]) {
    const v = firstValue(ordered, key);
    if (v !== undefined) body[key] = v;
  }
  const stamped = ordered.filter(
    (item) => parseInstant(item?.timestamp) !== undefined,
  );
  if (stamped.length > 0) {
    const first = stamped[0].timestamp;
    const last = stamped[stamped.length - 1].timestamp;
    body.startTime = scalar(first);
    body.endTime = scalar(last);
    body.durationSeconds = Math.floor(
      ((parseInstant(last) as number) - (parseInstant(first) as number)) / 1000,
    );
  }
  Object.assign(body, {
    messageCount: ordered.length,
    bySource: countBySource(ordered),
    skip,
    limit,
    returned: messages.length,
    view,
    messages,
  });

  const actions: string[] = [];
  if (skip + messages.length < ordered.length) {
    actions.push(
      `More messages follow: call again with skip: ${skip + messages.length}.`,
    );
  }
  if (view === "text") actions.push(PII_ACTION);
  else actions.push('To read the words, call again with view: "text".');

  const hint: { warning?: string; action?: string } = {
    action: actions.join(" "),
  };
  if (rawText) {
    hint.warning =
      "rawText is on: the text is unmasked and may contain personal data, emails, tokens and numbers as written.";
  }
  return { body, hint };
}
