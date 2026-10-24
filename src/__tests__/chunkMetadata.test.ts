import { describe, it, expect, beforeEach } from "@jest/globals";
import { ToolHandlers } from "../tools/handlers.js";
import { ID, mockApi } from "./helpers/endpointFixtures.js";

// K1: manage_knowledge list_chunks returns the chunk metadata (`data`).
describe("list_chunks returns chunk metadata (K1)", () => {
  let api: any;
  let h: InstanceType<typeof ToolHandlers>;
  const SRC = "60d5ec49f1a2c8b1a4e0f00b";

  beforeEach(() => {
    api = mockApi();
    h = new ToolHandlers(
      api,
      "https://endpoint-trial.cognigy.ai",
      "",
      "https://static-trial.cognigy.ai",
    );
  });

  const listWith = async (item: Record<string, unknown>) => {
    api.get.mockResolvedValueOnce({ items: [item], total: 1 });
    return h.handleToolCall("manage_knowledge", {
      operation: "list_chunks",
      knowledgeStoreId: ID.ks,
      sourceId: SRC,
    });
  };

  const base = {
    _id: "chunk1",
    referenceId: "ref-1",
    text: "Falafel $12",
    order: 3,
    disabled: false,
    createdBy: "someone",
    sourceReference: "s",
  };

  it("includes `data` as a plain-object copy placed after `disabled`, with other keys unchanged", async () => {
    const data = { title: "Menu", tags: ["a", "b"], nested: { page: 2 } };
    const upstream = { ...base, data };

    const result = await listWith(upstream);

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toEqual({
      id: "chunk1",
      text: "Falafel $12",
      order: 3,
      disabled: false,
      data: { title: "Menu", tags: ["a", "b"], nested: { page: 2 } },
    });
    expect(Object.keys(result.chunks[0])).toEqual([
      "id",
      "text",
      "order",
      "disabled",
      "data",
    ]);
  });

  it("returns new objects: neither the entry nor `data` aliases the upstream objects", async () => {
    const data = { title: "Menu", nested: { page: 2 } };
    const upstream = { ...base, data };

    const result = await listWith(upstream);

    expect(result.chunks[0]).not.toBe(upstream);
    expect(result.chunks[0].data).not.toBe(data);
    expect(result.chunks[0].data.nested).not.toBe(data.nested);
    result.chunks[0].data.title = "mutated";
    expect(data.title).toBe("Menu");
  });

  it("does not add any other upstream chunk field (no spread of the upstream chunk)", async () => {
    const result = await listWith({ ...base, data: { k: 1 } });

    expect(result.chunks[0].referenceId).toBeUndefined();
    expect(result.chunks[0].createdBy).toBeUndefined();
    expect(result.chunks[0].sourceReference).toBeUndefined();
    expect(result.chunks[0]._id).toBeUndefined();
  });

  it("keeps an empty plain object", async () => {
    const result = await listWith({ ...base, data: {} });

    expect(result.chunks[0].data).toEqual({});
    expect(Object.keys(result.chunks[0])).toEqual([
      "id",
      "text",
      "order",
      "disabled",
      "data",
    ]);
  });

  it.each([
    ["null", null],
    ["an array", [{ a: 1 }]],
    ["a string", "metadata"],
    ["a number", 7],
  ])("omits the `data` key when upstream data is %s", async (_n, value) => {
    const result = await listWith({ ...base, data: value });

    expect(Object.keys(result.chunks[0])).toEqual([
      "id",
      "text",
      "order",
      "disabled",
    ]);
    expect(result.chunks[0]).toEqual({
      id: "chunk1",
      text: "Falafel $12",
      order: 3,
      disabled: false,
    });
  });

  it("omits an own `__proto__` key of data and leaves the copy's prototype alone", async () => {
    const data = JSON.parse('{"__proto__":{"polluted":1},"ok":2}');
    expect(Object.keys(data)).toEqual(["__proto__", "ok"]);

    const result = await listWith({ ...base, data });

    const copy = result.chunks[0].data;
    expect(Object.keys(copy)).toEqual(["ok"]);
    expect(copy.ok).toBe(2);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy.polluted).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });

  it("omits the `data` key when upstream has no data", async () => {
    const result = await listWith({ ...base });

    expect("data" in result.chunks[0]).toBe(false);
  });
});
