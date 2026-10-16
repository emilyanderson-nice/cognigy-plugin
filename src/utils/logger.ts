/**
 * Simple logger utility for the MCP server
 */

import { MIN_REDACTABLE_KEY_LENGTH, redactKey } from "./redact.js";

type LogLevel = "debug" | "info" | "warn" | "error";

class Logger {
  private secrets = new Set<string>();

  private level: LogLevel;
  private levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.level];
  }

  /**
   * Registers a secret (e.g. an API key) that must never reach the log. Every
   * emitted line has it replaced by "[redacted]". Secrets shorter than
   * MIN_REDACTABLE_KEY_LENGTH, and empty values, are silently ignored.
   */
  registerSecret(secret: string): void {
    if (typeof secret !== "string" || secret.length < MIN_REDACTABLE_KEY_LENGTH)
      return;
    this.secrets.add(secret);
  }

  /** Forgets all registered secrets. Test seam; not used in production code. */
  clearSecrets(): void {
    this.secrets.clear();
  }

  // Redacts the final line, so no meta structure can hide a secret. The
  // JSON-escaped form is matched too, since JSON.stringify rewrites quotes
  // and backslashes inside a secret.
  private redact(line: string): string {
    let out = line;
    for (const secret of this.secrets) {
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) out = redactKey(out, escaped);
      out = redactKey(out, secret);
    }
    return out;
  }

  private formatMessage(level: LogLevel, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    return this.redact(
      `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`,
    );
  }

  debug(message: string, meta?: any) {
    if (this.shouldLog("debug")) {
      // Use stderr to avoid polluting stdout (MCP uses stdio protocol)
      console.error(this.formatMessage("debug", message, meta));
    }
  }

  info(message: string, meta?: any) {
    if (this.shouldLog("info")) {
      // Use stderr to avoid polluting stdout (MCP uses stdio protocol)
      console.error(this.formatMessage("info", message, meta));
    }
  }

  warn(message: string, meta?: any) {
    if (this.shouldLog("warn")) {
      // Use stderr to avoid polluting stdout (MCP uses stdio protocol)
      console.error(this.formatMessage("warn", message, meta));
    }
  }

  error(message: string, meta?: any) {
    if (this.shouldLog("error")) {
      // Use stderr to avoid polluting stdout (MCP uses stdio protocol)
      console.error(this.formatMessage("error", message, meta));
    }
  }
}

export const logger = new Logger();
