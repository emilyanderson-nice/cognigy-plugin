import { jest } from "@jest/globals";
import { CognigyApiClient } from "../../api/client.js";
import { ToolHandlers } from "../../tools/handlers.js";

export interface FlowNodeHarness {
  api: jest.Mocked<CognigyApiClient>;
  h: ToolHandlers;
}

/** A fresh mocked api client and a ToolHandlers built on it. */
export const makeFlowNodeHarness = (): FlowNodeHarness => {
  const api = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    put: jest.fn(),
    uploadFile: jest.fn(),
  } as any as jest.Mocked<CognigyApiClient>;
  const h = new ToolHandlers(
    api,
    "https://endpoint-trial.cognigy.ai",
    "",
    "https://static-trial.cognigy.ai",
  );
  return { api, h };
};
