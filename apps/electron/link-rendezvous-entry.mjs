// Bundle entry for the rendezvous renderer.
//
// Trystero and its strategies are ESM-only npm packages that import each other
// by bare specifier, so they cannot be loaded from a preload as shipped files.
// esbuild flattens them into one self-contained module (see
// `pnpm build:rendezvous`), which keeps the packaged app free of a runtime
// node_modules tree — the same reason link-ws.cjs is hand-rolled.
//
// Adding a strategy here is the only step needed to offer another broker
// family; link-rendezvous-preload.cjs picks them up by name.

import { joinRoom as joinNostrRoom } from 'trystero';
import { joinRoom as joinMqttRoom } from '@trystero-p2p/mqtt';

export const strategies = {
  nostr: joinNostrRoom,
  mqtt: joinMqttRoom,
};
