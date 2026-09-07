# Elevenex link relay

A rendezvous server that lets two Elevenex desktops reach each other when neither
is reachable from the internet — behind NAT, behind carrier-grade NAT, on hotel
wifi — with nothing configured on either router.

Both machines dial **outwards** to this relay over WebSocket. The relay pairs the
two connections that present the same pairing id and copies bytes between them.
That is all it does.

## It cannot read the session

The two ends run an X25519 handshake authenticated by the pairing key, which the
relay never sees (it is in the pairing code, which only ever travels between the
two users). Everything after the handshake is AES-256-GCM. So:

- a relay operator sees ciphertext and connection timing, nothing else;
- a relay operator **cannot** impersonate either end — without the pairing key the
  handshake fails on both sides;
- keys are ephemeral per session, so a pairing key that leaks later does not
  decrypt traffic captured earlier.

This is why it is reasonable to run the relay on any cheap box, or to use someone
else's. It is not a trusted component.

What it *can* do is refuse service, and observe that two devices are talking and
how much. If that matters, run your own.

## Running it

```sh
node apps/relay/server.cjs
```

No dependencies and no database — it is one file plus `apps/electron/link-ws.cjs`,
both plain Node.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `RELAY_PATH` | `/link` | WebSocket path |
| `MAX_ROOMS` | `10000` | Concurrent pairings before new ones are refused |
| `CLIENT_WAIT_TIMEOUT_MS` | `30000` | How long a connecting device waits for its host before being told nobody is sharing |

`GET /health` returns `{"ok":true,"rooms":n}` for a load balancer.

### Behind a reverse proxy

The relay speaks plain HTTP and does not terminate TLS. Put it behind whatever
you already run and make sure WebSocket upgrades are passed through. With Caddy:

```
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Then the pairing URL is `wss://relay.example.com/link`.

Sessions are long-lived and idle between keystrokes, so set generous read
timeouts — the relay sends its own 30s pings, but a proxy that closes idle
upgrades early will still cut sessions short.

## Sizing

Every byte of a session crosses the relay, so bandwidth scales with real usage:
terminal output, file reads, diffs. CPU is negligible (it copies buffers, it does
not decrypt). Memory is a few KB per connection.
