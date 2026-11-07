/**
 * Tool-call logging.
 *
 * An AI Agent decides which tool to run and with what arguments, and nothing
 * in the flow records that decision. When a conversation goes wrong the first
 * question is always "which tool did it actually call, and with what?" — and
 * without a log the answer has to be inferred from the agent's prose.
 *
 * A Log node at the HEAD of every tool branch answers it. The head, not the
 * tail: a log at the end only fires if the branch completes, so the calls that
 * most need explaining — the ones that threw, timed out, or hung — are exactly
 * the ones that would leave no trace.
 *
 * **Parameter names are logged; values are not.** Tool arguments routinely
 * carry personal data (a mortgage intake tool takes a name, an email, a phone
 * number and the last four of an SSN), and project logs are not the place for
 * it. The names are what identify the call; the values are what create the
 * liability. Anyone who needs values can add their own node and own that
 * decision explicitly.
 */

/**
 * Where tool-call arguments live depends on which node invoked the tool:
 * `input.aiAgent` under an AI Agent Job node, `input.llmPrompt` under an LLM
 * Prompt node — and the other object is null, so reading only one silently
 * yields nothing under the other.
 */
const TOOL_ARGS_EXPR =
  "(input.aiAgent && input.aiAgent.toolArgs) || (input.llmPrompt && input.llmPrompt.toolArgs) || {}";

const TOOL_ID_EXPR =
  "(input.aiAgent && input.aiAgent.toolId) || (input.llmPrompt && input.llmPrompt.toolId)";

/** Default log level. `debug` is hidden in the Logs list until filtered in. */
export const TOOL_CALL_LOG_LEVEL = "info";

/** Label prefix for generated tool-call log nodes. */
export const TOOL_CALL_LOG_LABEL_PREFIX = "Log: tool call";

/**
 * CognigyScript for a tool-call log line.
 *
 * `toolId` falls back to the tool's own name: the platform populates it on the
 * invoking node, and a literal keeps the line readable if it is ever absent.
 */
export function buildToolCallLogMessage(toolId: string): string {
  const name = `{{${TOOL_ID_EXPR} || ${JSON.stringify(toolId)}}}`;
  const args = `{{Object.keys(${TOOL_ARGS_EXPR}).join(', ') || 'none'}}`;
  // The inputId is shared by every row of one conversation turn, so a
  // transcript reader pairs this line with its tool-call marker exactly. The
  // session id is deliberately not logged: on some channels it can embed
  // contact details.
  return `[tool-call] ${name} args=[${args}] inputId={{input.inputId}}`;
}

/** Config for the generated Log node. */
export function buildToolCallLogConfig(toolId: string): {
  message: string;
  level: string;
} {
  return {
    message: buildToolCallLogMessage(toolId),
    level: TOOL_CALL_LOG_LEVEL,
  };
}

/** Node label, so the generated node is identifiable in a flow. */
export function buildToolCallLogLabel(toolId: string): string {
  return `${TOOL_CALL_LOG_LABEL_PREFIX} ${toolId}`;
}
