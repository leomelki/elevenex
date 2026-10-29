# PlanMeter

What's left of a Claude or Codex plan, always in view. Unlike context, a plan isn't one session's: every session on that account draws from it, and it comes back on a clock (a 5-hour window and a weekly one). It sits in the agent chip, beside the context ring, as a second small ring.

## The mark

- **A 14px ring with a clock hand**, the same size and weight as the `ContextMeter` ring next to it. The clock hand says it's a limit that comes back.
- **It fills as the plan is used:** a full ring means nothing left, like the context ring.
- **One number: the limit that stops you first,** the 5-hour one or the weekly one, whichever has less left.
- **Colors:** `ink-muted` while there's plenty, `attention` at 20% left, `danger` at the limit.
- **In the chip** (`compact`), the number only shows when it matters:
  - running low: "12%" (or "18% wk" when the weekly limit is the tighter one);
  - at the limit: when it comes back, "14:30".
- Without `compact`, the number always shows.

## The usage card (`UsageCard`)

Point at the agent chip (or focus it) for 400ms and a card rises above it:
- context: its ring, the percentage and the tokens ("84k of 200k");
- the plan's name and tier ("Claude plan · Max");
- each limit with a thin bar of what's left and when it resets ("5-hour limit · 12% left · Resets at 14:30", "Weekly limit · 58% left · Resets Monday"). The tighter one is in bold.
- a footer: "More in the agent menu ⌘J".

The agent menu (⌘J) opens on the same block, above the model and thinking settings.

## The line above the composer (`PlanNotice`)

- At 20% left: "12% of your 5-hour limit left. Resets at 14:30." in `attention-soft`, with a dismiss ×.
- At the limit: "Claude plan limit reached. Resets at 14:30." in `danger-soft`, with a way on:
  - **Send at 14:30**: write anyway; it sends when the limit resets. The composer's placeholder says so: "Write now, it sends at 14:30…".
  - **Fork to Codex**: continue in another agent whose plan has room (`forkTo`).
- Sessions running on that plan pause where they are and say so in their chat.
- While there's plenty, it renders nothing.

## When the limit hits

- **Every session on that plan pauses where it is.** Its glyph turns to Paused (a circle with a pause, `ink-muted`) and its row says “until 14:30”. It stays in the task's working sessions.
- **In the session,** the turn's work line reads “Paused after 3m 12s”, and one line says: “**Paused at the Claude plan limit.** It picks up where it stopped at 14:30.” with **Fork to Codex** and **Stop** (`Turn` with `status: 'paused'` and `pause`). At 14:30 it carries on by itself.
- **Wherever you are,** the title island shows it once, in `warn`: “Claude plan limit reached · 3 sessions paused until 14:30 · Show” (`IslandEvent` with the clock icon). Show opens the first paused session. Like any event, it shrinks back after a few seconds.

## Context filling up (`ContextNotice`)

- From 75%: the context ring turns `attention`, the agent menu shows **Compact** beside the context row, and a line above the composer says “**Context 78% full.** Compact it to keep long work sharp.” with Fork with a summary and **Compact now**. It can be dismissed.
- From 90%: `danger`, “**Context 94% full.** The agent may lose track of early details.”, and it stays until there's room.

## One line at a time

Above the composer, only the most urgent line shows: a plan at its limit, then context at 90%, then a plan running low, then context at 75%.

## Motion

- The arc eases as usage changes (`dur-slow`), and the color eases at each threshold.
- The number fades in when it appears. Nothing jumps when a threshold is crossed.
- The card rises 3px and fades in 140ms, and leaves in 120ms.

**Provide:** `plan` (`{ win, week, resetWin, resetWeek, name, tier }`; `win` and `week` are what's LEFT, 0–1), `compact`. On the chip, pass `plan` (and `tokens`) in the `AgentPicker` value; the chip draws the meter and the card itself.

- Do show it only for plans. With an API key there's no limit: the chip shows the context ring alone.
- Do say what's left and when it comes back. Never a raw token count for a plan.
- Don't color it while there's plenty.
