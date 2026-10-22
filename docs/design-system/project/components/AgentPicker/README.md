# AgentPicker

The agent chip in the composer during a session: it shows the preset (or model) with model and thinking level, a bolt when fast mode is on, and a `ContextMeter` ring for how full the context is (`value.context`, 0–1). Its menu adjusts the running session: model, thinking level and fast mode. The harness is fixed once the session has started; “Fork to…” starts a fork with another harness. Presets are picked before the first message, in `SessionStart`.

**Provide:** `value` (`{ preset?, mark, harness, model, thinking, fast }`; `mark` is a two-letter harness monogram), `open`, `placement` (`top` inside the composer), `locked` (default true; false in an empty session, where the harness can still change), optional `harnesses`.

- Do apply changes from the next message, and note the switch as a quiet line in the chat.
- Do list only the models the harness offers; thinking levels a model lacks are disabled, not hidden.
- Do offer “Save as preset” when the mix no longer matches a preset.
- Don't show provider logos; harness monograms stay neutral on `accent-soft`.
