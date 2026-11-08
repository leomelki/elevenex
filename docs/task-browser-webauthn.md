# Streamed browser WebAuthn

WebAuthn registration and explicit sign-in use the viewing desktop's native
authenticators. A native confirmation names the exact requesting origin before
the device starts authentication. Requests never authorize an agent to use a key.
The remote host needs the managed Chromium distribution with extension support;
installed Chrome versions which refuse unpacked extensions cannot provide this
relay. No Chrome store installation or user-browser profile import is required.

## Boundaries and ownership

The task's sandboxed Chromium loads a fixed Manifest V3 extension with only
`webAuthenticationProxy`. It has no content scripts, host permissions, network
transport, external messaging or page bindings. Chromium validates secure
contexts, ancestor policy, RP IDs, focus and TLS before sending a ceremony to the
[proxy API](https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy).
This preserves native `PublicKeyCredential` objects and extension serialization;
no website API is replaced and no production virtual authenticator is created.

`RuntimeWebAuthn` owns the extension worker, one request, a 100 ms serialized
poll and its cleanup. The extension bounds options to 64 KiB and expires requests
after two minutes. It rejects requests until a capable viewer opts in. Task
state contains an opaque UUID, operation and engine-supplied origin only. The
private `POST .../runtime/tasks/:taskId/webauthn` reads options or consumes a
result using that UUID and the current viewer lease. Public TCP, browser-origin
callers, agents and the preload bridge cannot call this operation. There is no
credential database or ceremony log on the host.

The proxy API supplies an origin, not a tab ID. Admission requires a currently
presented tab at that origin; agent control is revoked for every same-origin tab.
It does not claim to identify the originating tab. Chromium cancellation still
belongs to the actual initiating document. Cross-origin ancestor requests are
rejected, rather than manufacturing a different `crossOrigin` assertion.

`RemoteWebAuthn` owns the desktop task's in-flight ceremony and tombstones. It
validates identities and options, rejects remote origin-override extensions,
and calls the application-owned `WebAuthnBroker`. The broker handles one native
ceremony at a time; concurrent requests fail instead of queuing authentication.
Each request requires explicit native consent. A persistent, separate Electron
session holds native authenticator metadata, independent of website/agent
profiles. Public keys, assertions and options never enter Angular, MCP or saved
browser metadata; private keys remain with the authenticator.

The broker deliberately vouches for the engine-validated origin as a trusted
remote-desktop client. Its session-local HTTPS/HTTP protocol handler serves only
one fixed, inert document at the active ceremony URL. All other requests are
denied, as are navigation, popups, device permissions and subresources. No RP
page, cookies or scripts are downloaded into this session. Fixed main-owned code
uses Chromium's JSON option parsers and real `navigator.credentials` APIs, so
the local browser independently enforces RP binding and user verification. No
TLS errors, CSP, browser sandbox or origin checks are disabled. Allowed origins
are HTTPS and the explicit trustworthy HTTP development hosts `localhost`,
`*.localhost`, `127.0.0.1` and `[::1]`.

Aborting the website request, navigating its document, hiding the presented
origin, losing the viewer, switching task/scope, closing the window or timing
out cancels the ceremony. Late native responses are discarded. A result is
consumed before sending it to Chromium; uncertain transport outcomes are never
retried. Reconnecting creates no authentication prompts from old snapshots.
Older hosts omit `webAuthn`; clients only include the optional connect capability
when the host advertises it. Older viewers omit that opt-in and cannot trigger
local authentication.

## Native capabilities and limits

Supported authenticators are those exposed by the locked Electron/Chromium
runtime and OS: for example roaming security keys and Windows platform
authentication. Actual device/provider availability remains an OS decision.
`isUserVerifyingPlatformAuthenticatorAvailable()` is probed on the desktop and
forwarded conservatively. This capability is distinct from roaming-key support.

Electron 45 does not expose security-key PIN entry. PIN-required ceremonies fail;
presence-only keys and keys with available built-in verification use their normal
device interaction. On macOS, arbitrary websites' synced iCloud/third-party
passkeys are **not** enabled: Electron's `platformPasskeys` API requires signed
Associated Domains provisioning and each RP's AASA association with Elevenex.
It also changes the returned origin to the RP domain, which is unsuitable for
this relay's exact-origin contract. We do not enable it or claim access to the
user's Safari/Chrome credentials. See the locked Electron
[platform authenticator requirements](https://www.electronjs.org/docs/latest/api/app#appconfigurewebauthnoptions-macos)
and [PIN implementation](https://github.com/electron/electron/blob/v45.0.0/shell/browser/webauthn/electron_authenticator_request_client_delegate.cc).
Adding a browser/OS-specific provider is a separate adapter at `WebAuthnBroker`;
the remote proxy and viewer contracts do not need to change.

Conditional/autofill mediation is rejected by Chromium's proxy API. Cross-origin
iframes and payment-specific ceremonies are not supported. Same-origin pages,
same-origin frames and task-profile OAuth popup pages use ordinary WebAuthn.
Opening a site outside still uses a separate browser session; it does not transfer
the streamed page's authenticated state.

## Regression checks

The normal desktop suite includes `browser-webauthn.test.cjs` for validation,
stale replies, viewer cancellation and at-most-once completion. Backend
`runtime-webauthn.integration.spec.ts` uses sandboxed Chromium and tests original
origin serialization, RP spoofing, abort, hide and viewer loss. Existing private
IPC integration tests cover transport denial without a viewer lease.

After building both applications, run
`node apps/desktop/test/browser-webauthn-native.cjs` for native Electron + remote
Chromium registration, discoverable-account choice, signed assertions and denied
consent. Only the test process installs a virtual authenticator and substitutes
native consent. It checks genuine returned credential objects, the original
origin, challenge, RP hash and assertion signature. It does not verify a physical
key, platform biometrics, packaged signing or another host OS. Per-run evidence
belongs under ignored `artifacts/`, not in this guide.
