/** Shared rig: buildServerParts over injected loader and fake runtimes. */
import { jest } from "@jest/globals";
import { buildServerParts } from "../../server/bootstrap.js";
import type { Profile, ProfileSet } from "../../profiles/profiles.js";
import type { EnvironmentRuntime } from "../../environments/registry.js";

export type Handler = (
  n: string,
  a: Record<string, unknown>,
) => Promise<unknown>;

export function rig(
  initial: ProfileSet,
  env: NodeJS.ProcessEnv = {},
  impl?: Record<string, Handler>,
) {
  let current = initial;
  let loader: () => ProfileSet = () => current;
  const gets: Record<string, jest.Mock<(u: string) => Promise<unknown>>[]> = {};
  const handlerCalls: Record<string, jest.Mock<Handler>> = {};
  const createRuntime = jest.fn((profile: Profile): EnvironmentRuntime => {
    const get = jest.fn<(u: string) => Promise<unknown>>(async () => ({
      info: { version: "2026.21.0" },
    }));
    (gets[profile.name] ??= []).push(get);
    const h = jest.fn<Handler>(
      impl?.[profile.name] ?? (async (n, a) => ({ echo: { n, a } })),
    );
    handlerCalls[profile.name] = h;
    return { profile, client: { get }, handlers: { handleToolCall: h } };
  });
  const parts = buildServerParts({
    env,
    loadProfiles: () => loader(),
    createRuntime,
  });
  return {
    parts,
    gets,
    handlerCalls,
    createRuntime,
    set: (s: ProfileSet) => (current = s),
    throwOnLoad: (e: Error) => {
      loader = () => {
        throw e;
      };
    },
    call: (name: string, args: Record<string, unknown> = {}) =>
      parts.dispatcher.callTool(name, args),
  };
}
