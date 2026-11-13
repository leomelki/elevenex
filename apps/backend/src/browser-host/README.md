# Browser host setup

This boundary is shared by task browser startup and the standalone administrator
helper. See [host setup](../../../../docs/task-browser-streaming.md#browser-host-provisioning-and-startup-failures)
for the user/deployment contract.

- `cli.ts` composes argument parsing, user-owned browser installation, disposable
  rendering verification and explicit `--system` provisioning. Importing it does
  not execute the CLI. It must remain independent of application/native services.
- `paths.ts` resolves the locked distribution/installer and emits display-only,
  quoted recovery commands for source, bundled Node and Electron runtimes.
- `diagnostics.ts` owns bounded loader/font/policy observations. `ldd` is diagnostic
  only after an actual loader failure; its output is never a readiness gate alone.
- `linux-setup.ts` owns the small apt package catalog and atomic AppArmor policy
  publication/rollback. Only the explicit administrator CLI calls provisioning.
- `process.ts` owns short output-limited probes and interruption/timeout cleanup
  for provisioning subprocess groups.

Task browser errors live in `desktop-browser/runtime-start-error.ts`; only fixed
messages, validated sonames and installation recovery commands may cross that
boundary. Older viewers require messages no longer than 400 characters. Full
commands that exceed that limit remain in backend logs, never truncated in place.

`bundle-electron-backend.js` emits `browser-setup.cjs` alongside `main.cjs` and
keeps Playwright external. Local, development and remote runtime assembly must
copy it with the driver. The helper uses built-in Node APIs and the locked driver;
it must not depend on a global pnpm, global Playwright or a source checkout.
