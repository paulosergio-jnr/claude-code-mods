# claude-code-mods

A Claude Code plugin marketplace of mods: plugins of function hooks. Load the `plugin-authoring` skill before writing or debugging a mod; the API types it points to are the reference.

- Marketplace manifest: `.claude-plugin/marketplace.json`. Every `mods/<name>` must have an entry with `"source": "./mods/<name>"`.
- New mod: `scripts/new-mod.sh <name> "<description>"`.
- Verify: `scripts/check.sh [name]` (validate + tests). Run it before calling a mod done.
- In tests, `$.command.run` takes the full `CommandRunInput`: pass `origin` and `presentation`, plus `args` (`''` when there are none), or the hook sees `args` as undefined.
