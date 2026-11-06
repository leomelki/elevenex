# Task browser network boundary

Internal Node-only package shared by Electron main and the backend Chromium host.
It implements bounded SOCKS5 TCP forwarding and canonical public/loopback address
checks. Callers own destination grants, DNS resolution, activity checks and teardown.
Connections preserve origin/TLS/WebSocket bytes without parsing HTTP or recording
payloads. Handshakes are limited to 1 KiB/ten seconds and 128 tracked sockets;
streams apply Node backpressure. Callers may supply a bounded list of checked,
pinned addresses. Node races their families without resolving the hostname again,
so an unavailable address can fall back without introducing a rebinding window.

This package is never imported by the renderer or serializable shared contracts.
It exposes neither a generic app HTTP bridge nor transport credentials. Build it
before backend/main compilation with `pnpm --dir packages/browser-network build`;
the existing desktop runner and backend build scripts do this automatically.
