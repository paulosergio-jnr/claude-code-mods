# usage-band

A dim band above the prompt. Click `context` to expand a second row with `tools`, `skills`, `mcp` and the cache token counts, and click again to collapse it.

Collapsed:

![usage-band collapsed](../../docs/usage-band-collapsed.png)

Expanded:

![usage-band expanded](../../docs/usage-band-expanded.png)

- The model (orange) and effort (white) lead the band once the first request names them; the effort is left out on a model without one.
- `cache` is the share of the last response's input read from the prompt cache; the expanded row adds the cache read and write token counts. It is absent before the first response, and drops after a cache break such as `/model` or a long pause.
- `context`, `session` and `week` turn yellow from 75.0% and red from 90.0%.
- `tools` is the loaded tools' share of the context window; `skills` and `mcp` show a count and their share. All come from the engine's local estimate (`/context` may differ slightly).
- `session` is the five-hour rate-limit window and `week` the seven-day one; both only appear on a subscription.
- Each entry except `context` can be switched off with its `show*` option.
- The toggle is a click, so it works on the terminal and desktop surfaces only.
