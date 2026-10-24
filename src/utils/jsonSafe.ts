/** Helpers for copying upstream objects into tool output without spreading them. */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** `jsonSafeCopy` for a value that must be a plain object, else undefined. */
export function plainObjectCopy(
  value: unknown,
  maxDepth = Infinity,
): Record<string, unknown> | undefined {
  return isPlainObject(value)
    ? (jsonSafeCopy(value, maxDepth) as Record<string, unknown>)
    : undefined;
}

/**
 * JSON-safe copy: plain objects, arrays and finite primitives only (functions,
 * class instances and other values are dropped), nesting capped at `maxDepth`
 * (the root is depth 0; anything deeper is dropped). An own `__proto__` key
 * (possible from JSON.parse) is omitted so a copy can never change prototype.
 */
export function jsonSafeCopy(
  value: unknown,
  maxDepth = Infinity,
  depth = 0,
): unknown {
  if (depth > maxDepth) return undefined;
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "object": {
      if (Array.isArray(value)) {
        return value
          .map((item) => jsonSafeCopy(item, maxDepth, depth + 1))
          .filter((item) => item !== undefined);
      }
      if (!isPlainObject(value)) return undefined;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if (key === "__proto__") continue;
        const copied = jsonSafeCopy(child, maxDepth, depth + 1);
        if (copied !== undefined) out[key] = copied;
      }
      return out;
    }
    default:
      return undefined;
  }
}
