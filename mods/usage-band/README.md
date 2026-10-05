# usage-band

A dim band above the prompt:

```
context 12.0% · tools 3.0% · skills 30 (0.5%) · mcp 15 (0.0%) · session 10.0% (resets at 11:40) · week 5.0% (resets at Wed 00:00)
```

- `context`, `session` and `week` turn yellow from 75.0% and red from 90.0%.
- `tools` is the loaded tools' share of the context window; `skills` and `mcp` show a count and their share. All come from the engine's local estimate (`/context` may differ slightly).
- `session` is the five-hour rate-limit window and `week` the seven-day one; both only appear on a subscription.
- Each entry except `context` can be switched off with its `show*` option.
