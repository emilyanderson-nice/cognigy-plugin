#!/usr/bin/env bash
# Cognigy status line segment for Claude Code.
#
# Prints the Cognigy environment the current Claude Code session uses, e.g.
# "cognigy:prod", or nothing when the session has no Cognigy MCP server.
# The server (one per session) writes ~/.cognigy-plugin/sessions/<pid>.json,
# keyed by the pid of its `claude` ancestor; this script walks up its own
# ancestry to find a pid with such a file. Always exits 0.
#
# Use from a status line command:
#   seg=$(bash ~/.cognigy-plugin/statusline-segment.sh 2>/dev/null)
#
# COGNIGY_SL_COLOR=0 disables ANSI colours.
# Depends only on ps; uses jq when available, sed otherwise.

dir="${HOME}/.cognigy-plugin/sessions"
[ -d "$dir" ] || exit 0

# Reads one top-level field from a flat JSON file: string, number or null.
field() {
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$2" '.[$k] // empty | if type == "array" then .[0] // empty else . end' "$1" 2>/dev/null
    return
  fi
  tr -d '\n' <"$1" |
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\[*[[:space:]]*\"\{0,1\}\([^]\",}]*\)\"\{0,1\}.*/\1/p" |
    sed 's/[[:space:]]*$//; s/^null$//'
}

alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

file=""
pid="${PPID:-}"
hops=0
while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && [ "$hops" -lt 6 ]; do
  candidate="$dir/$pid.json"
  if [ -f "$candidate" ]; then
    server=$(field "$candidate" pid)
    if alive "$server"; then
      file="$candidate"
      break
    fi
    # Stale: the server that wrote it is gone.
    rm -f "$candidate" 2>/dev/null
  fi
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  hops=$((hops + 1))
done
[ -n "$file" ] || exit 0

pinned=$(field "$file" pinned)
last=$(field "$file" lastUsed)
configured=$(field "$file" configured)
single=$(field "$file" environments)

name=""
note=""
if [ -n "$pinned" ]; then
  name="$pinned"
elif [ "${configured:-0}" -ge 2 ] 2>/dev/null; then
  name="unpinned"
  [ -n "$last" ] && note=" (last $last)"
elif [ "${configured:-0}" -eq 1 ] 2>/dev/null; then
  name="${last:-$single}"
fi
[ -n "$name" ] || exit 0

if [ "${COGNIGY_SL_COLOR:-1}" = "0" ]; then
  printf '%s' "cognigy:${name}${note}"
else
  printf '\033[2m%s\033[0m\033[38;2;125;207;255m%s\033[0m' "cognigy:" "$name"
  [ -n "$note" ] && printf '\033[2m%s\033[0m' "$note"
fi
exit 0
