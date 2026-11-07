# agent-flow

An animated pane showing the orchestrator, its subagents, who is working, and the messages between them.

- **Timeline:** one line per agent, every agent always listed: its name on the left, the tool or state on the right. The time axis is the run itself, from its first activity to its last event, fitted to the pane width, so it redraws when something happens rather than scrolling with the clock. Each line is coloured by what the agent was doing: orange thinking, blue acting (running a tool), green waiting (idle, or for its subagents). A `●` drops from a parent to where a subagent starts (`╰`), and the result climbs back (`╯`, `◆`) where it ends. Spinners, packets and the shimmer on running agents keep moving between events.
- **Summary rows:** at the foot of the pane, one compact row per agent: badge and name, a bar of how long it ran against the whole run (filled part coloured by its thinking, acting and waiting time, the rest dotted), its tool or `done 12s`, and its tokens in and out (`↑12k` `↓2k`).
- **Details:** click a lane or a row, or use ↑/↓ and Enter, to open a strip with the agent's type, model, tokens, cache hit rate, tool counts, skills, task and result. It sits between the timeline and the summary rows, and shows only while an agent is selected; otherwise that space is left empty.
- **clear finished:** removes finished subagents and the interactions drawn between them.

Open the pane any time with `/agent-flow`. Terminal and desktop get the animated view (below 80 columns the timeline narrows to a short bar per lane); VS Code and mobile get a plain list.

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
