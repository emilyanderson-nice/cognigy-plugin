// Sync PRs from upstream also carry upstream's own squash commits, whose
// subjects end with a GitHub PR number, e.g. "fix(scope): summary (#57)".
// Those commits cannot be rewritten and can exceed our 100-character header
// limit, so they are ignored. Only the SUBJECT (first line) is inspected: it
// must end with exactly one space followed by "(#<digits>)". Everything else
// is still linted. `defaultIgnores` stays on, so merge commits remain ignored.
const UPSTREAM_SQUASH_SUBJECT = /\S \(#\d+\)$/;

export default {
  extends: ["@commitlint/config-conventional"],
  ignores: [
    (message) =>
      UPSTREAM_SQUASH_SUBJECT.test(String(message).split(/\r?\n/, 1)[0]),
  ],
  rules: {
    "body-max-line-length": [2, "always", 200],
  },
};
