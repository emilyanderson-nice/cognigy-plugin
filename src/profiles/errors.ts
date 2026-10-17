/** Raised for unusable or unreadable profile configuration; never quotes secrets. */
export class ProfileConfigError extends Error {
  override name = "ProfileConfigError";
}
