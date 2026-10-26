# CloseTask

The confirmation shown when closing a task. It says plainly what will happen: running sessions stop, sessions are archived (reopenable from Closed), and the task's files are cleaned up. Unpushed work is called out and the primary action becomes “Push and close”.

**Provide:** `title`, `sessions` (count), optional `running` (count), `unpushed` (commit count), `ticket` (a linked ticket key: offers to move it to Done).

- Do skip the dialog when nothing would be lost (no running sessions, nothing unpushed): close at once and offer Undo in a toast.
- Do reopen a closed task with its sessions and files restored from its last pushed state.
- Don't use `danger` styling; closing is reversible.
- Show it in a `ModalLayer` (centred): the window recedes behind it (see `Sheet`), and it pops in.
