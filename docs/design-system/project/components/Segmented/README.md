# Segmented

A small choice among two to five options, one always selected: mode, harness, thinking level. The selected option sits on a raised thumb that glides to the new choice (`dur-fast`, `ease-in-out`).

**Provide:** `options` (`[{ id, label, icon, title }]`), `value`, optional `onChange(id)`, `size` (`sm`), `label` (the group's accessible name).

- Do keep labels to one short word; use `title` for the full name.
- Don't use it for more than five options; use a menu.
