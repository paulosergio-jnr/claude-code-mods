# threads

Keep track of the open questions, doubts and ideas that get lost in a long conversation. Threads adds a side pane with two lists: **Project** threads, saved in `.claude/threads.local.json`, and **Session** threads, which belong to one conversation: they come back with `claude --resume` and disappear on `/clear`. Claude can also propose threads it sees left open; they wait in a **Suggested** block until you accept (`[+]`) or dismiss (`[-]`) them.

## Use

- `/threads` shows or hides the pane. Click or Tab to a row to select it; the buttons at the end of a row move it between scopes (`[↑]` promotes a session thread to the project, `[↓]` demotes it).
- `/thread <text>` adds a session thread from the prompt; `/thread --project <text>` adds a project one.
- With a row selected: `d` done/reopen, `e` edit, `m` move, `x` delete. `p` and `s` add a project or session thread. Tab or the arrow keys walk the buttons.
- A thread has a title, an optional note and an optional kind: `?` question, `!` doubt, `◇` explore, `◆` decision.

## Settings

| Setting | Values | Default |
| --- | --- | --- |
| `suggestions` | `on`, `off`. `off` registers no tool and adds nothing to the system prompt. | `on` |
| `paneVisibility` | `at-start`, `at-suggestion` (once per session), `manual` | `manual` |
| `doneRetention` | `keep`, or `delete` 30 seconds after finishing, with an Undo | `keep` |

## Notes

- Session threads are saved in the plugin's store (under your Claude Code config directory) as they change, keyed by session id, and dropped after 30 days unused. Suggestions are not saved.
- The project file is plain JSON. Commit it or add `.claude/threads.local.json` to `.gitignore`, as you prefer.
- Sessions sharing a project coordinate writes with a lock directory, `.claude/threads.local.lock`, and the pane picks up each other's changes within a couple of seconds.
- Suggestions come from the `suggest_threads` tool Claude can call: at most 5 per turn, 10 waiting at a time, and never a title that is already a thread.
