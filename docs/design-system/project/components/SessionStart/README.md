# SessionStart

The empty chat of a new session: the task line (project, task name, branch, workspace setup), the prompt “What should we work on?”, the presets as cards, and the composer. The preset is chosen here, with one click on a card (or ⌥1–⌥9), before the first message; there is no menu to open.

**Provide:** `presets` (AgentConfig with `preset` names, in the person's order), optional `value` (the preset selected at first: the last one used in this task, else the first), `task` (`{ project, title, branch, base, workspace: { state: 'setup' | 'ready', step } }`), `title`, `composer` (Composer props).

- Do let people write while the workspace is still setting up; the first message sends as soon as it is ready.
- Do let the task name and branch be renamed right here (click them).
- Do preselect the last preset used in the task, so starting is just typing and ↵.
- Do skip this screen for forks and side chats: they inherit their parent's agent.
- Don't show more than six presets here; the rest live in Settings.
