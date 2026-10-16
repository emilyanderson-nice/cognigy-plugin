import type { Profile, ProfileSet } from "./profiles.js";

export interface ProfileCliDeps {
  out(text: string): void;
  err(text: string): void;
  isTTY: boolean;
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
  env: NodeJS.ProcessEnv;
  configPath?: string;
  /** Overall deadline for one environment's check (default 20000). */
  checkTimeoutMs?: number;
  loadProfiles(): ProfileSet;
  store: {
    upsertProfile(
      name: string,
      profile: {
        apiBaseUrl: string;
        apiKey: string;
        endpointBaseUrl?: string;
        webchatBaseUrl?: string;
        staticFilesBaseUrl?: string;
        versionHint?: string;
      },
      options?: { path?: string },
    ): { created: boolean };
    removeProfile(name: string, options?: { path?: string }): boolean;
    setDefaultProfile(
      name: string | undefined,
      options?: { path?: string },
    ): void;
  };
  createGetter(profile: Profile): { get<T = unknown>(url: string): Promise<T> };
}
