#!/usr/bin/env bash
# Validate the marketplace and every mod in it, then run each mod's tests.
# Usage: scripts/check.sh [mod-name ...]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
marketplace="$root/.claude-plugin/marketplace.json"
cd "$root"

# Every listed source exists, and every mod folder is listed.
status=0
for source in $(jq -r '.plugins[].source' "$marketplace"); do
  [[ -f "$source/.claude-plugin/plugin.json" ]] || { echo "listed but missing: $source" >&2; status=1; }
done
for dir in mods/*/; do
  name="$(basename "$dir")"
  jq -e --arg s "./mods/$name" '.plugins[] | select(.source == $s)' "$marketplace" >/dev/null \
    || { echo "not listed in marketplace.json: mods/$name" >&2; status=1; }
done
[[ $status -eq 0 ]] || exit $status

if [[ $# -gt 0 ]]; then
  mods=("$@")
else
  mods=($(jq -r '.plugins[].name' "$marketplace"))
fi

claude plugin validate "$root"
for name in "${mods[@]}"; do
  echo "== $name"
  claude plugin validate "mods/$name"
  claude plugin test "mods/$name"
done
