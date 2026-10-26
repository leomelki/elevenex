# PresetPicker

Agent presets as one-click choices: cards (harness monogram, preset name, model · thinking, harness, a bolt for fast mode, ⌘ number) for an empty session (`SessionStart`), or compact pills (`compact`) where space is tight. Selected = a 2px `accent` ring and a check.

**Provide:** `presets` (AgentConfig with `preset`), `value` (the selected preset's name, or `custom`), optional `onSelect(name)`, `compact`, `custom` (false hides the Custom card). `PresetCard` (`preset`, `selected`, `kbd`, `custom`) is one card.

- Do let people create, order and edit presets in Settings, or save the current custom mix with “Save as preset” in the agent menu.
- Don't use presets mid-session; they are a starting choice.
