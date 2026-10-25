/**
 * Shared setup for the manage_flow_nodes file suites (get/update/compare):
 * a temp ROOT wired through COGNIGY_FILE_ROOT and a mocked-api harness.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeFlowNodeHarness,
  type FlowNodeHarness,
} from "./flowNodeHarness.js";
import { makeRoot, removeDir } from "./fileTestKit.js";

export const FLOW = "60d5ec49f1a2c8b1a4e0f002";
export const NODE = "60d5ec49f1a2c8b1a4e0f0a1";
export const NODE_PATH = `/v2.0/flows/${FLOW}/chart/nodes/${NODE}`;
export const PROJECT = "60d5ec49f1a2c8b1a4e0f000";
export const SENTINEL = "CONTENT-SENTINEL-93b1";

export interface FileEnv {
  root: string;
  harness: FlowNodeHarness;
  cleanup: () => void;
}

/** Fresh ROOT (via COGNIGY_FILE_ROOT) and a fresh harness. Call cleanup in afterEach. */
export const setupFileEnv = (): FileEnv => {
  const root = makeRoot();
  const previous = process.env.COGNIGY_FILE_ROOT;
  process.env.COGNIGY_FILE_ROOT = root;
  const harness = makeFlowNodeHarness();
  // first-change backup gate: pretend the question was already answered
  (harness.h as any).backupDeclinedForProject.add(PROJECT);
  (harness.h as any).backupAnsweredAnywhere = true;
  return {
    root,
    harness,
    cleanup: () => {
      if (previous === undefined) delete process.env.COGNIGY_FILE_ROOT;
      else process.env.COGNIGY_FILE_ROOT = previous;
      removeDir(root);
    },
  };
};

export const readIn = (root: string, rel: string): string =>
  fs.readFileSync(path.join(root, rel), "utf8");

export const listRoot = (root: string): string[] => fs.readdirSync(root).sort();

/** A say-node style detail as the API returns it. */
export const sayNode = (config: Record<string, unknown> = {}) => ({
  _id: NODE,
  referenceId: "ref-uuid",
  type: "say",
  label: "Greeting",
  config,
});
