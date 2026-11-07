/**
 * Patterns for Voice Gateway values, shared by the tool schema and the reader so
 * the two cannot drift apart. A value that fails its pattern is never used in a
 * URL and never returned.
 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The trace id in a call row (32 hex characters observed, V2). */
export const TRACE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** A SIP Call-ID, e.g. `abc123@host`; anything else is not matched or returned. */
export const SIP_CALL_ID_RE = /^[A-Za-z0-9_.@:+-]{1,128}$/;
export const REASON_RE = /^[A-Za-z0-9_.:\- ]{1,64}$/;
