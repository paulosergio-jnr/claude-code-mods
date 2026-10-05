#!/usr/bin/env bash
# Scaffold a new mod under mods/<name> and list it in the marketplace.
# Usage: scripts/new-mod.sh <name> "<one-line description>"
set -euo pipefail

name="${1:-}"
description="${2:-TODO: describe this mod}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/mods/$name"
marketplace="$root/.claude-plugin/marketplace.json"

if [[ ! "$name" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "usage: $0 <kebab-case-name> \"<description>\"" >&2
  exit 1
fi
if [[ -e "$dir" ]]; then
  echo "mods/$name already exists" >&2
  exit 1
fi

mkdir -p "$dir/.claude-plugin" "$dir/hooks" "$dir/tests"

jq -n --arg name "$name" --arg description "$description" '{
  name: $name,
  version: "0.1.0",
  description: $description,
  author: { name: "Paulo Sergio Pereira Junior" },
  license: "Apache-2.0",
  repository: "https://github.com/paulosergio-jnr/claude-code-mods"
}' > "$dir/.claude-plugin/plugin.json"

echo '{ "modules": ["./register.ts"] }' > "$dir/hooks/hooks.json"

cat > "$dir/hooks/register.ts" <<TS
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async (\$, e, next) => {
    await \$.command.register({
      name: '$name',
      description: '$description',
    })

    return next(e)
  })

  on('command.run', { command: '$name' }, async () => ({ text: '$name is running.' }))
}
TS

cat > "$dir/tests/register.test.ts" <<TS
import { expect, test } from 'claude-code/testing'

// What the engine stamps on a command the person typed at the prompt.
const TYPED = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

test('/$name answers', async \$ => {
  const ran = await \$.command.run({ ...TYPED, command: '$name', args: '' })

  expect(ran.text).toBe('$name is running.')
})
TS

cat > "$dir/README.md" <<MD
# $name

$description
MD

tmp="$(mktemp)"
jq --arg name "$name" --arg description "$description" \
  '.plugins += [{ name: $name, source: ("./mods/" + $name), description: $description, version: "0.1.0" }]' \
  "$marketplace" > "$tmp"
mv "$tmp" "$marketplace"

echo "Created mods/$name and listed it in .claude-plugin/marketplace.json"
