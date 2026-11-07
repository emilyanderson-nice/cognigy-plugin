import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { CognigyApiClient } from "../api/client.js";
import { ToolHandlers } from "../tools/handlers.js";
import {
  TOOL_CALL_LOG_LEVEL,
  buildToolCallLogMessage,
} from "../tools/toolCallLog.js";

const ID = {
  project: "60d5ec49f1a2c8b1a4e0f000",
  agent: "60d5ec49f1a2c8b1a4e0f001",
  flow: "60d5ec49f1a2c8b1a4e0f002",
  entry: "60d5ec49f1a2c8b1a4e0f004",
  jobNode: "60d5ec49f1a2c8b1a4e0f005",
  tool: "60d5ec49f1a2c8b1a4e0f006",
  log: "60d5ec49f1a2c8b1a4e0f007",
  resolve: "60d5ec49f1a2c8b1a4e0f008",
};

describe("buildToolCallLogMessage", () => {
  const message = buildToolCallLogMessage("submit_application");

  it("logs parameter NAMES, never their values", () => {
    // Tool arguments routinely carry personal data — a mortgage intake tool
    // takes a name, an email, a phone number and the last four of an SSN.
    // Project logs are not the place for it.
    expect(message).toContain("Object.keys(");
    expect(message).toContain(".join(', ')");
    expect(message).not.toContain("JSON.stringify");
  });

  it("reads args from both the AI Agent and LLM Prompt nodes", () => {
    // Under an LLM Prompt node input.aiAgent is null and the args live on
    // input.llmPrompt; reading only one silently logs nothing under the other.
    expect(message).toContain("input.aiAgent && input.aiAgent.toolArgs");
    expect(message).toContain("input.llmPrompt && input.llmPrompt.toolArgs");
  });

  it("falls back to the tool's own id when the runtime has no toolId", () => {
    expect(message).toContain('"submit_application"');
  });

  it("says 'none' rather than nothing for a tool with no parameters", () => {
    expect(message).toContain("|| 'none'");
  });

  it("is a single line, so one call is one log entry", () => {
    expect(message).not.toContain("\n");
  });

  it("ends with the inputId of the turn, so a log line ties to its conversation turn", () => {
    // Every row of one conversation turn carries the same inputId (observed),
    // so a transcript reader can pair a tool-call marker with this line exactly.
    expect(message.endsWith(" inputId={{input.inputId}}")).toBe(true);
  });

  it("does not log the session id: on some channels it can embed contact details", () => {
    expect(message).not.toContain("sessionId");
  });

  it("is exactly this CognigyScript line", () => {
    expect(message).toBe(
      "[tool-call] {{(input.aiAgent && input.aiAgent.toolId) || (input.llmPrompt && input.llmPrompt.toolId) || \"submit_application\"}} args=[{{Object.keys((input.aiAgent && input.aiAgent.toolArgs) || (input.llmPrompt && input.llmPrompt.toolArgs) || {}).join(', ') || 'none'}}] inputId={{input.inputId}}",
    );
  });
});

describe("create_tool writes a tool-call Log node", () => {
  let api: jest.Mocked<CognigyApiClient>;
  let h: ToolHandlers;

  const mockFlowWithJobNode = () => {
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        { _id: ID.entry, isEntryPoint: true },
        { _id: ID.jobNode, type: "aiAgentJob" },
      ],
    });
  };

  const typeAwarePosts = () =>
    api.post.mockImplementation(async (_path: string, body: any) => {
      if (body?.type === "log") return { _id: ID.log } as any;
      if (body?.type === "aiAgentToolAnswer") return { _id: ID.resolve } as any;
      return { _id: ID.tool } as any;
    });

  const createTool = (config: Record<string, unknown> = {}) =>
    h.handleToolCall("create_tool", {
      aiAgentId: ID.agent,
      toolType: "tool",
      name: "Submit Application",
      config: {
        toolId: "submit_application",
        description: "Files an application",
        ...config,
      },
    });

  beforeEach(() => {
    api = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      put: jest.fn(),
      uploadFile: jest.fn(),
    } as any;
    h = new ToolHandlers(api, "https://endpoint.example", "", "");
    (h as any).backupDeclinedForProject.add(ID.project);
    (h as any).backupAnsweredAnywhere = true;
  });

  it("puts the log FIRST in the branch, before anything that can fail", async () => {
    // At the tail it would only fire when the branch completes — so the calls
    // that most need explaining leave no trace at all.
    mockFlowWithJobNode();
    typeAwarePosts();

    const result: any = await createTool();

    const logCall = api.post.mock.calls.find(([, b]: any) => b?.type === "log");
    expect(logCall).toBeDefined();
    expect((logCall as any)[1].target).toBe(ID.tool);
    expect(result.toolCallLogNodeId).toBe(ID.log);

    // and the resolve node hangs off the log, not off the tool, so their
    // order in the chain is unambiguous.
    const resolveCall = api.post.mock.calls.find(
      ([, b]: any) => b?.type === "aiAgentToolAnswer",
    );
    expect((resolveCall as any)[1].target).toBe(ID.log);
  });

  it("logs at info so the entry is visible without enabling Debug", async () => {
    mockFlowWithJobNode();
    typeAwarePosts();
    await createTool();

    const [, body]: any = api.post.mock.calls.find(
      ([, b]: any) => b?.type === "log",
    )!;
    expect(body.config.level).toBe(TOOL_CALL_LOG_LEVEL);
    expect(body.config.level).toBe("info");
    expect(body.label).toBe("Log: tool call submit_application");
  });

  it("omits the log node when logToolCalls is false", async () => {
    mockFlowWithJobNode();
    typeAwarePosts();

    const result: any = await createTool({ logToolCalls: false });

    expect(api.post.mock.calls.some(([, b]: any) => b?.type === "log")).toBe(
      false,
    );
    expect(result.toolCallLogNodeId).toBeUndefined();
    // The resolve node falls back to the tool node as its anchor.
    const resolveCall = api.post.mock.calls.find(
      ([, b]: any) => b?.type === "aiAgentToolAnswer",
    );
    expect((resolveCall as any)[1].target).toBe(ID.tool);
  });

  it("still builds the tool when the log node cannot be created", async () => {
    // A missing log line is not worth losing a tool over.
    mockFlowWithJobNode();
    api.post.mockImplementation(async (_path: string, body: any) => {
      if (body?.type === "log") throw new Error("chart is locked");
      if (body?.type === "aiAgentToolAnswer") return { _id: ID.resolve } as any;
      return { _id: ID.tool } as any;
    });

    const result: any = await createTool();

    expect(result.toolId).toBe(ID.tool);
    expect(result.toolCallLogNodeId).toBeUndefined();
    expect(result.resolveNodeId).toBe(ID.resolve);
  });
});
