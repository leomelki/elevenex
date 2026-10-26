# ContextMeter

How much of the agent's context window the session has used: a small ring that fills smoothly, `ink-muted` normally, `attention` from 75%, `danger` from 90%. It sits inside the agent chip (compact) and in full in the agent menu, with the token count in its tooltip.

**Provide:** `used` (0–1), optional `tokens` (text), `compact`.

- Do offer “Compact the conversation” or “Fork with a summary” in the agent menu once it turns `attention`.
