/**
 * Where a profile field's value came from, for validation messages. Origins
 * name a variable, a file or a profile, never the value itself.
 */
export type UrlField =
  | "apiBaseUrl"
  | "endpointBaseUrl"
  | "webchatBaseUrl"
  | "staticFilesBaseUrl";

export type FieldOrigins = Partial<Record<UrlField, string>>;

const CONFIG_FILE = "~/.cognigy-plugin/config.json";

/** The legacy environment variable behind each URL field. */
export const LEGACY_VARIABLE: Record<UrlField, string> = {
  apiBaseUrl: "COGNIGY_API_BASE_URL",
  endpointBaseUrl: "COGNIGY_ENDPOINT_BASE_URL",
  webchatBaseUrl: "COGNIGY_WEBCHAT_BASE_URL",
  staticFilesBaseUrl: "COGNIGY_STATIC_FILES_BASE_URL",
};

export const isUrlField = (field: string): field is UrlField =>
  field in LEGACY_VARIABLE;

/** A value supplied by an environment variable, by its exact spelling. */
export function envOrigin(variable: string): string {
  const base = `the environment variable ${variable}`;
  return variable === "COGNIGY_API_BASE_URL"
    ? `${base} (in Claude Code this is the plugin setting cognigy_api_base_url)`
    : base;
}

/** A legacy value read from the user config file. */
export function fileOrigin(variable: string): string {
  return `${variable} in ${CONFIG_FILE}`;
}

/** A value from a saved profile. */
export function savedProfileOrigin(name: string): string {
  return `the saved profile "${name}" in ${CONFIG_FILE}`;
}

/** The suffix appended to an invalid-URL message, or "" without an origin. */
export function originSuffix(origin: string | undefined): string {
  return origin ? ` (value from ${origin})` : "";
}
