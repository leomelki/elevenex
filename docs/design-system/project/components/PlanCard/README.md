# PlanCard

A plan from Plan mode: numbered steps you can read before anything changes. **Start coding** (⇧⇥) switches the session to Code and sends the plan as the next message; **Refine** keeps you in Plan. While the agent works, the same card ticks steps off: the current one runs, done ones get a drawn check, a thin line shows progress.

**Provide:** `title`, `steps` (`[{ text, state: 'todo' | 'running' | 'done' }]`), `status` (`proposed` · `running` · `done`), optional `onStart()`.

- Do keep the plan visible while it runs; pin it to the top of the chat if it scrolls away.
- Don't animate steps already done when the session reopens; only changes animate.

**Motion:** going from proposed to running eases its height (`AutoHeight`); steps tick off with a drawn check.
