# MachineHome

What a window shows before it has a machine: every machine as a `MachineCard`, in two groups. **Connected** first (This Mac, and servers other windows are using), with live status. Then **Not connected**, with what we knew last; opening one connects to it. Add a server and Pair a computer sit at the foot, Find (⌘O) at the top.

New window (⇧⌘N) always opens here. ↵ opens the highlighted machine in this window, ⌘↵ in a new one.

**Getting ready happens here.** Opening a machine that isn't ready (not connected, behind the app) doesn't launch yet: its card gets ready (`busy`), says “Will open” (`pending`), and launches once ready. A card getting ready, or about to open (`pending`), stays in its group, so it doesn't move away as you click it. While a machine is open or opening, nothing on Home moves (no regroup, no slide); it catches up when Home shows again. Home stays usable meanwhile: open another machine and that one wins.

**The first run** (`firstRun`, until a machine has been opened): the title asks “Where should your agents run?”, every machine sits in one grid (at first only This Mac, its engine downloading), and “A server” and “Another computer” follow as dashed cards (`MachineAdd`) instead of the foot.

**Adding:** `onAdd(from)` and `onPair(from)` hand back what was clicked; open `AddMachine` in a `ModalLayer` with that as `from`. When a machine is added (or removed), the cards that move slide from where they were and the new one grows in where it lands, a beat later and above them.

**Provide:** `machines`, `highlighted`, `pressed`, `pending` (an id, or ids), `firstRun`, `onOpen(machine)`, `onAdd(from)`, `onPair(from)`, optional `title` and `subtitle`.

- Do keep it connected to nothing: servers behind SSH stay untouched until someone opens one.
- Do put it inside `MachineLaunch`, so opening a card grows it into the window.
