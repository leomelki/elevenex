# AgentPicker

The agent chip in the composer during a session, and its menu (⌘J). The chip shows the harness logo, the preset (or model) with model or harness and thinking level, a bolt when fast mode is on, the `ContextMeter` ring and, on a plan, the `PlanMeter`.

## The menu

One small card, built to be read top to bottom and driven by the keyboard:

- **Harness rail** (only while the harness can change: an empty session). A sunken well down the left edge holding one logo per harness; a raised thumb glides to the chosen one (`ease-glide`). Each logo names itself in a tooltip beside it. ↑↓ moves and chooses, like any radio group. Once the session has started the rail is gone: the harness can't change, so the menu doesn't offer it.
- **Header.** The harness name (with its logo when there's no rail, and a lock once it's fixed), the preset in muted text, and on the right one quiet line about the plan: “62% left”. It turns `attention` at 20% left and `danger` at the limit (“Used up · 14:30”); its tooltip names the limit and the reset. While a change applies, the same place says “Updating…”.
- **Models.** One 30px row per model, the chosen one marked by an `accent` check, never by a fill. Focus starts on it. ↑↓ moves without choosing (choosing a model is a deliberate ↵, Space or click); typing jumps to a model by its first letter. Lists longer than eight get a “Filter models” field: typing from the list starts it, ↵ picks the first match, and Esc clears it before it closes the menu. Once shown, the field stays for that harness until the menu closes or the harness changes, so catalog refreshes never hide a query or remove focus. While the harness can change, the list keeps one height (six rows, a soft fade at the foot when more scroll), so switching harness never resizes the menu.
- **Thinking.** One stepped track from Faster to Smarter, a dot per level the model offers, its name above the track. Dragging previews the level; letting go (or an arrow key) applies it. An unset level shows Default without changing the setting; its first arrow/Home adjustment or a click on the first step explicitly chooses the lowest reported level. Levels a model lacks aren't on its track, and the level carries over when a new model offers it. Models that report no levels have no track.
- **Fast** is a pill at the end of the thinking line (`accent` on `accent-soft` when on), or its own row when there's no track. It shows only where the model supports it.
- **Context** gets a line only once it matters: from 75% full, “Context 84% full” with **Compact**, on `attention-soft` (`danger-soft` from 90%).
- **Footer**: **Fork to…** once the harness is fixed, and **Save as preset** when the mix no longer matches a preset. No footer when neither applies.

Changes apply from the next message and keep the menu open, so several can be made in a row. The menu opens from the chip on the glide spring and eases its height when a section comes or goes (`AutoHeight`).

**Provide:** `value` (`{ preset?, mark, harness, model, thinking, fast, context?, tokens?, plan? }`; `mark` is the two-letter fallback for a harness without a logo), `locked` (default true; false in an empty session), `harnesses` (`{ id, label, mark, models: [{ id, label, thinking[], supportsFastMode? }] }`), `busy`, `reasoningAvailable`, `fastAvailable`, `canCompact`, `showFork`, `showSavePreset`.

- Do apply changes from the next message, and note the switch as a quiet line in the chat.
- Do list only the models the harness offers, and only the thinking levels the chosen model offers.
- Do keep focus and position while a change applies; choices simply wait.
- Don't color the menu while everything is fine: color is for a plan or context running out.
- Don't recolor or redraw harness logos; they render in `currentColor` from the bundled set.
