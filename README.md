# claude-code-mods

Open-source **mods for [Claude Code](https://claude.com/claude-code)**, distributed as a plugin marketplace.

A mod is a Claude Code plugin made of *function hooks*: a TypeScript module that can draw panes and bands, set the status line, show toasts, add slash commands, and block, rewrite or react to tool calls and prompts.

> Function hooks are an early-access surface of Claude Code and may change between releases.

## Install

Add the marketplace, then install any mod from it:

```sh
claude plugin marketplace add paulosergio-jnr/claude-code-mods
claude plugin install agent-flow@claude-code-mods
```

Or from inside a session: `/plugin marketplace add paulosergio-jnr/claude-code-mods`.

## Mods

| Mod | What it does |
| --- | --- |
| [agent-flow](mods/agent-flow) | Animated pane showing the orchestrator, its subagents, who is working and the messages between them. |
| [usage-band](mods/usage-band) | Band above the prompt showing context %, tools, skills and MCP share of context, and session and weekly limits, with yellow and red usage indicators. |

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per mod
mods/<name>/
  .claude-plugin/plugin.json      the mod's manifest
  hooks/hooks.json                { "modules": ["./register.ts"] }
  hooks/register.ts(x)            the hooks module
  types/index.d.ts                the $.state contract (only if the mod keeps state)
  **/*.test.ts                    run by `claude plugin test`
  README.md
scripts/new-mod.sh                scaffold a mod and list it in the marketplace
scripts/check.sh                  validate the marketplace and every mod, run their tests
```

## Developing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache 2.0](LICENSE.txt)
