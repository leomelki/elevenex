# JobBrief

The first message of a session Elevenex started for a git job (a merge that hit real conflicts, a sync that broke a test). It isn't your bubble and it isn't the agent's: a quiet `surface-sunken` well with the ⚡ mark, “Elevenex” and why the session exists, then the brief itself.

A brief always says three things, in this order:
1. **What happened:** the job and where it stopped (“Merging fix/null-cart-total into leo/flaky-checkout hit 3 conflicts in payments/client.ts and test/checkout.spec.ts”), and what Elevenex already did itself (“I regenerated pnpm-lock.yaml”).
2. **What to do:** the judgement that's needed (“Resolve them keeping what both sides meant, run the cart and checkout tests”).
3. **When to stop:** “then stop: the merge finishes on its own.” The session ends itself when the job is done.

**Provide:** `title` (why the session exists; default “started this session for a git job”), `time`, `id`, and the brief as children (inline `code` for branches and files).

- Do keep it to a few sentences; the job's steps live in the git button's menu, not here.
- Do write it in Elevenex's voice: first person for what it did, plain instructions for the agent.
- Don't use it anywhere else: Elevenex never posts in a session it didn't start.
