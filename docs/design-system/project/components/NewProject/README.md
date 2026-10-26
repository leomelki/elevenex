# NewProject

Making a project: **1 Repositories ↵ 2 Name ↵ 3 Look ↵**, in New task's numbered rows. The card says what it is on top, "dev-box / New project" (the machine, then the title), so you know at a glance you're creating a project. It's the first thing a machine with no project shows, and what the rail's + opens later.

**The steps:**
1. **Repositories:** one box. The repositories you've added are rows (name, path, branch; × on hover removes one), and the last row is the field where you add one. The field asks the machine for one folder at a time as you type (`listFolders`), like a shell's ⇥: git folders show their branch, plain folders open with ↵ or ⇥, and a git URL offers "clones into ~/code". A folder without git gets git set up. Add as many as you like. With one or more added, ↵ on the empty field goes on.
2. **Name:** starts as the first repository's name and is yours to change.
3. **Look:** the face (`ProjectMark`): letters from the name, an emoji or an icon, then one of six colors. The color starts as one picked from the name, until you choose. ↵ creates.

**One button, no hints.** The footer holds only the main button. It reads **Next ↵** until the last step, then **Create project ↵**; the label crossfades in place while the button eases to its new width (`EaseSwap`). Next stays off until the step has an answer (a repository, a name). The keys still work without being listed: ⇧⇥ goes back a step, ⌘↵ creates from any step once there's a repository and a name, Esc cancels when `onCancel` is given (the first run has no Esc: there's nowhere to go back to). Click any row to go back to it.

**Provide:** `machine` (its name), `listFolders(query)` → `[{ path, name?, git?, branch?, dir?, clone? }]` (`git` is the line to show, like `main · 214 commits`; `dir` marks a folder you can go into; `clone` the URL to clone), and `onCreate(project, cardElement)` with `{ name, repos, look, emoji, icon, hue }`. Optional: `onCancel`, `autoFocus`, `machineIcon`, and a state to start from (`repos`, `name`, `look`, `emoji`, `icon`, `hue`, `step`, `query`). Without `onCreate` the card shows a "Created" line, for demos. `projectFace(project)` turns the result into `ProjectMark` props.

**Where it opens:**
- **A machine with no project** (first run): the machine launches from Home (`MachineLaunch`) onto this card, over the app out of focus (blurred, a little smaller). Nothing else is asked first.
- **Later,** from the rail's +: the same card in a `ModalLayer` that grows out of the + tile (`from`), so the window recedes behind it, with Esc. Create doesn't jump: clear `from` as you close, so the card leaves the plain way, and the project pops into the rail (`ProjectRail`).

**The launch (Create):** everything starts together and is done in about a second.
- The card dissolves (fades, blurs, shrinks a little).
- The face jumps home with `jumpHome`: a copy of it travels along one bell-shaped arc, up over the title bar and down into its tile in the rail, never up again. One curve times it all (it sets off gently and eases all the way in). The copy grows towards the top of the arc and shrinks back to the tile's size, like a cartoon jump, and its shadow follows the height.
- As it lands, `settleMark` plays: the tile squashes and springs back, and one soft ring in its color goes out, so you see where the project went.
- The name follows on a lower arc into the sidebar's header (`jumpHome` with `grow: 0.06`, no shadow).
- The window comes into focus around them, and the project opens on `NewTask` (with several repositories, Repository is its step 2). It never opens on a task named for you.
- Reduced motion: no jump; the project is simply there.

Find the copies to fly in the card element `onCreate` hands back: `[data-np="face"]` (its `.ex-pmark`) and `[data-np="name"]`.

- Do keep the card for configuring a project's start only; everything else lives in `ProjectSettings`.
- Don't scan the machine for repositories: the person points, folder by folder.
- Don't show keyboard hints in the footer; the ↵ on the button is the hint.

**Motion:** the open step unfolds and the previous one folds (`Fold`), added repositories grow in and removed ones collapse (`MotionList`), the face swaps with a short blur, the button's label crossfades while its width eases.
