# Offline

A page: the whole window while its remote machine (dev-box) is out of reach, moment by moment. It's built from `IslandReach`, `ReconnectAsk`, `OpensWhenBack`, `Composer`'s `waitingFor`, `Turn`'s `reach`, `GitBar`'s `unreachable` and the `.ex-offline` class on the window.

**The rule:** writing waits, opening needs the machine, and what can't be undone never waits.

Try it:
- Write and press ↵: the message waits above the input.
- Open "Token bucket per merchant": it wasn't loaded.
- Click Push: git never waits.
- Pick "Needs you", choose what it needs, and click the island.
