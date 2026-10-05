# Contributing

## Start a mod

```sh
scripts/new-mod.sh my-mod "One line on what it does"
```

This creates `mods/my-mod/` with a manifest, a hooks module that adds `/my-mod`, a passing test, and an entry in `.claude-plugin/marketplace.json`.

## Try it live

Point a session at the mod folder; edits reload when each turn ends:

```sh
claude --plugin-dir mods/my-mod
```

Or add this checkout as a local marketplace. Mods are then read from the folder, so `/reload-plugins` picks up edits without reinstalling:

```sh
claude plugin marketplace add .
claude plugin install my-mod@claude-code-mods
```

Inside Claude Code you can also ask Claude to write a mod. The built-in `plugin-authoring` skill knows the API.

## Check it

```sh
scripts/check.sh            # every mod
scripts/check.sh my-mod     # one mod
```

This runs `claude plugin validate` on the marketplace and on each mod, then `claude plugin test`. CI runs the same script.

**Type-checking.** Once a mod has loaded in a session, the engine writes its API types to `mods/<name>/.claude-plugin/types/` (git-ignored). Add a `tsconfig.json` to the mod that extends `../../tsconfig.base.json` and includes `.claude-plugin/types`, `hooks`, `types` and `tests`, then run `npx tsc -p mods/<name>`.

## Conventions

- Mod names are kebab-case. The folder name, the `plugin.json` name and the marketplace entry name are the same.
- Bump `version` in both `plugin.json` and the marketplace entry when a mod changes.
- Every mod has at least one `*.test.ts` that covers the behaviour it adds.
- Values kept in `$.state` are declared in `types/index.d.ts` under the mod's name, and that file is listed as `"types"` in `plugin.json`.
- Hooks call `next(e)` unless they mean to answer for the engine.
