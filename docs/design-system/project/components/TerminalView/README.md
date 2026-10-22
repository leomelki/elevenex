# TerminalView

The Terminal side view: **your** terminals, in the task's workspace. The agent's commands are tool calls in the chat (`WorkTimeline`) and never show here; this view is only for you.

**Provide:**
- `tabs`: `[{ id, title, cmd, status, port, cwd, branch, unread }]`. `status` is one of `idle`, `running`, `serving` (a server on `port`), `failed`.
- `active`, `onSelect`, `onClose`, `onNew`.
- `scripts`: `[{ name, cmd }]`, the project's scripts (`package.json` and the like), with `onRun(script)`.
- `output`: lines `[[kind, text]]` for the preview, where `kind` is `cmd`, `dim`, `ok`, `err`, `warn` or `info`. In the app, pass the real terminal (xterm) as children.
- `failure`: `{ code, cmd }`, the last command failed. With `onAsk` and `onRerun`.
- `onOpenPort(port)`, `onStop`.

**Tabs say what they're doing**
- A spinner while a command runs.
- A teal dot and the port (`:3000`) while a server is up. Its row has **Open :3000**, which opens it in the Browser view.
- A red dot when the last command failed (it pulses once).
- A blue dot when a tab in the background has new output.
- Tabs grow in and close away; a middle click closes one.

**+ opens a new shell (⌘T) or runs one of the project's scripts** in its own tab, named after the script.

**Under the tabs:** the working directory and branch of the task's workspace, Open :port, Stop (⌃C) while something runs, and Find (⌘F).

**When a command fails,** a bar opens under the output: **Exited 1 · pnpm test …** with **Ask the agent** (it sends the command and its output to the session) and **Run again**.

**The terminal itself** sits on `surface-sunken` in the code type, with colors from the tokens:

| ANSI | Token |
| --- | --- |
| red | `danger` |
| green | `diff-add` |
| yellow | `attention` |
| blue | `code-function` |
| magenta | `code-keyword` |
| cyan | `accent` |
| white / black | `ink` / `surface-sunken` |
| bright black | `ink-muted` |

The prompt is `accent`, and the caret is hollow when the terminal doesn't have focus.

- Do open every terminal in the task's workspace, never somewhere else.
- Don't mirror the agent's commands here: they live in the chat, where they're tied to what the agent was doing.
- If the agent wants to run something in one of your terminals, it asks first (`ApprovalCard`), and the command runs where you can see it.
