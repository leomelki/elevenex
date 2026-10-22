# TaskLine

The one line at the top of a new session that says where it will work: the project mark, the task's name (click to rename), its `BranchChip` and the workspace status. The session opens at once; while the workspace is being set up the line says “Setting up workspace · installing deps” with a running ring, then “Workspace ready”. You can write the first message meanwhile; it's sent when the workspace is ready.

**Provide:** `task` (`{ project, title, branch, base, workspace: { state: 'setup' | 'ready', step } }`).

- Do keep it to one line; details live in the task header once the session has started.
