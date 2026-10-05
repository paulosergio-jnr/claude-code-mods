# agent-flow

An animated pane showing the orchestrator, its subagents, who is working, and the messages between them.

- **Tree:** each agent shows a status badge, its current tool, its model and its token use. Wires animate when a task goes down to a subagent or a result comes back up.
- **Details:** click a row, or use ↑/↓ and Enter, to see an agent's type, model, tokens (with cache reads), tool counts, skills, task and result.
- **Interactions log:** recent tasks, results and messages between agents.
- **clear finished:** removes finished subagents and empties the log.

Open the pane any time with `/agent-flow`. Terminal and desktop get the animated view; VS Code and mobile get a plain list.

## Settings

| Setting | Values | Default |
| --- | --- | --- |
| `autoOpen` | `never`: only `/agent-flow` opens the pane.<br>`on-subagent`: it also opens when a subagent spawns.<br>`always`: it also opens when a session starts. | `on-subagent` |

Change it in the `/config` menu or with `claude plugin configure agent-flow`. A pane opened automatically needs a terminal at least 144 columns wide; one opened with `/agent-flow` fits any width.

## Install

```sh
claude plugin marketplace add paulosergio-jnr/claude-code-mods
claude plugin install agent-flow@claude-code-mods
```
