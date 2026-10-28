import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { ToolHandlers } from "../tools/handlers.js";
import { logger } from "../utils/logger.js";

const PROJECT = "a1b2c3d4e5f60718293a4b5c";

function makeApi() {
  return {
    get: jest.fn(async (): Promise<any> => ({})),
    post: jest.fn(async (): Promise<any> => ({})),
    patch: jest.fn(async (): Promise<any> => ({})),
    delete: jest.fn(async (): Promise<any> => ({})),
    put: jest.fn(async (): Promise<any> => ({})),
    uploadFile: jest.fn(async (): Promise<any> => ({})),
  };
}
type FakeApi = ReturnType<typeof makeApi>;
const calls = (api: FakeApi): number =>
  api.get.mock.calls.length +
  api.post.mock.calls.length +
  api.patch.mock.calls.length +
  api.delete.mock.calls.length +
  api.put.mock.calls.length +
  api.uploadFile.mock.calls.length;

describe("manage_settings backup gate", () => {
  let api: FakeApi;
  let h: ToolHandlers;

  beforeEach(() => {
    api = makeApi();
    h = new ToolHandlers(api as any, "https://endpoint-trial.cognigy.ai");
    jest.spyOn(logger, "info").mockImplementation(() => {});
    jest.spyOn(logger, "debug").mockImplementation(() => {});
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does not hold get_knowledge_ai, a read, on a first call", async () => {
    let result: any;
    try {
      result = await h.handleToolCall("manage_settings", {
        operation: "get_knowledge_ai",
        projectId: PROJECT,
      });
    } catch {
      // The fake may not satisfy the read; reaching the API is the point.
    }
    expect(result?.error).not.toBe("backup_not_offered");
    expect(api.get).toHaveBeenCalled();
  });

  it.each([
    [
      "set_knowledge_ai",
      { knowledgeSearchModelId: "0042b4b0-c6f2-41af-8fcd-bb1756bc9d18" },
    ],
    ["set_voice_preview", { provider: "google" }],
  ])(
    "still holds %s on a first call and makes no API call",
    async (op, extra) => {
      const result = await h.handleToolCall("manage_settings", {
        operation: op,
        projectId: PROJECT,
        ...extra,
      });
      expect(result.error).toBe("backup_not_offered");
      expect(result.tool).toBe("manage_settings");
      expect(result.changed).toBe(false);
      expect(calls(api)).toBe(0);
    },
  );
});
