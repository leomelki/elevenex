# MachineHome

What a window shows before it has a machine: every machine as a `MachineCard`, in two groups. **Connected** first (This Mac, and servers other windows are using), with live status. Then **Not connected**, with what we knew last; opening one connects to it. Add a server and Pair a computer sit at the foot, Find (⌘O) at the top.

New window (⇧⌘N) always opens here. ↵ opens the highlighted machine in this window, ⌘↵ in a new one.

**Getting ready happens here.** Opening a machine that isn't ready (not connected, behind the app) doesn't launch yet: its card gets ready (`busy`), says “Will open” (`pending`), and launches once ready. A card getting ready, or about to open (`pending`), stays in its group, so it doesn't move away as you click it. While a machine is open or opening, nothing on Home moves (no regroup, no slide); it catches up when Home shows again. Home stays usable meanwhile: open another machine and that one wins.

**The first run** (`firstRun`, until a machine has been opened): the title asks “Where should your agents run?”, every machine sits in one grid (at first only This Mac, its engine downloading), and “A server” and “Another computer” follow as dashed cards (`MachineAdd`) instead of the foot.

**Adding:** `onAdd(from)` and `onPair(from)` hand back what was clicked; open `AddMachine` in a `ModalLayer` with that as `from`. When a machine is added (or removed), the cards that move slide from where they were and the new one grows in where it lands, a beat later and above them.

**When getting ready fails,** the card says so (`MachineCard`'s `error`) and is its own Try again (`onAction`). Nothing is lost: a download picks up where it stopped, and a machine you added stays on Home with what failed until it's fixed or removed.

**The island on Home** (see `TitleIsland`) says the most urgent thing about these machines and points at its card when clicked: pass `ping: { id, at }` (a new `at` each click) and Home scrolls to that card, which springs a little and sends one ring in its state's color. At rest the island reads "Machines" and opens Find (`onFind`, the ⌘O pill, which then shows `findOpen`); on the first run, which has no Find, it points at This Mac. After Change it reads "Back to dev-box" and opens it again.

**Editing and removing:** pass `onMenu` and every card gets its ⋯ (on hover or focus) and right-click; open `MachineMenu` where it says, with `menuOpen` set to that id. Edit opens `EditMachine` in a `ModalLayer` with `from: card`. Remove: drop the machine from `machines` at once and show a `Toast` with Undo; Home collapses its card out and slides the others over, and Undo (putting it back) grows it in where it was. A machine with a window open asks first (`EditMachine` with `step: 'remove'`).

**Provide:** `machines`, `highlighted`, `pressed`, `pending` (an id, or ids), `firstRun`, `ping`, `onFind`, `findOpen`, `onMenu`, `menuOpen`, `onOpen(machine)`, `onAction(machine)`, `onAdd(from)`, `onPair(from)`, optional `title` and `subtitle`.

- Do keep it connected to nothing: servers behind SSH stay untouched until someone opens one.
- Do put it inside `MachineLaunch`, so opening a card grows it into the window.
