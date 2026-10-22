# QuestionCard

The agent asks you to decide. It stays *Needs you* until you answer, then collapses to one line (“You chose …”, or a short list when there were several questions).

- **Pick one** (`kind: 'single'`, the default): options are radio rows; a click or 1–9 picks. With a single question, picking a listed option is the answer; your own answer waits for Send.
- **Pick any** (`kind: 'multi'`): checkbox rows; the check draws itself; **Send** when you're done (“2 picked”).
- **Your own answer** is always the list's last option, “Something else…”. It opens in place into a field and **is selected while you write** (pick one: the other options let go). Nothing is sent on its own: with one question, a footer appears with “↵ sends it” and **Send**; in a run, ↵ keeps it and goes on; for pick any, ↵ adds it as one more checked answer. Clicking away keeps what you wrote, selected (with Edit); Esc closes the field.
- **Several questions in a row** (`questions`): a strip of steps on top (each named by its `header`, checked once answered, clickable to go back), one question at a time, and a count (“1 of 3”). A pick moves on to the next question; pick-any questions need Next. **Send answers** at the end sends them all at once; ←/→ and Back move between questions.

**Provide:** `question`, `options` (`[{ label, detail, recommended }]`) and `kind`, or `questions` (`[{ id, header, question, kind, options }]`); `onSubmit(answers)` (`{ [id]: labels }`); `answer` or `answers` to show it answered.

- Do keep options to five or fewer, the agent's suggestion marked “suggested”, never preselected.
- Do give each question in a run a short `header` (“Retry policy”); keep runs to four questions or fewer.
- Do let a reply typed in the composer count as the answer.

**Motion:** the next question slides in from the right (back: from the left) while the card eases to its new height (`AutoHeight`); radio dots pop, checks draw, a step's check pops once; once answered the card eases down to its one line.
