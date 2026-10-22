# MachineHome

What a window shows before it has a machine: every machine as a `MachineCard`, in two groups. **Connected** first (This Mac, and servers other windows are using), with live status. Then **Not connected**, with what we knew last; opening one connects to it. Add a server and Pair a computer sit at the foot, Find (⌘O) at the top.

New window (⇧⌘N) always opens here. ↵ opens the highlighted machine in this window, ⌘↵ in a new one.

**Provide:** `machines`, `highlighted`, `pressed`, `onOpen(machine)`, `onAdd`, `onPair`, optional `title` and `subtitle`.

- Do keep it connected to nothing: servers behind SSH stay untouched until someone opens one.
- Do put it inside `MachineLaunch`, so opening a card grows it into the window.
