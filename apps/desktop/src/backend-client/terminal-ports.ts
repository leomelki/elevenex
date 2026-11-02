import type { BackendClient } from "./client";
import type { RemoteManager } from "../remote/manager";
import { handleForWindow, type TrustedSender } from "../ipc";
import { parseTerminalOutput } from "./task-terminal";
import { requestBackendJson } from "./transport";

/** Browser handoff validates the process, then uses this window's managed SSH forward. */
export function registerTerminalPorts(
  client: BackendClient,
  remote: RemoteManager,
  trusted: TrustedSender,
  open: (url: string) => Promise<void>,
): () => void {
  return handleForWindow(
    "task-terminal:open-port",
    trusted,
    async (window, ...args) => {
      if (
        args.length !== 2 ||
        typeof args[0] !== "string" ||
        !/^[a-f\d-]{36}$/.test(args[0])
      )
        throw new Error("Invalid terminal scope");
      const scopeId = args[0],
        input: unknown = args[1];
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid service");
      const raw = input as Record<string, unknown>,
        task = raw["taskId"],
        id = raw["terminalId"],
        port = raw["port"];
      if (
        Object.keys(raw).some(
          (key) => !["taskId", "terminalId", "port"].includes(key),
        ) ||
        typeof task !== "number" ||
        !Number.isSafeInteger(task) ||
        task < 1 ||
        typeof id !== "number" ||
        !Number.isSafeInteger(id) ||
        id < 1 ||
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      )
        throw new Error("Invalid terminal service");
      return client.execute(
        window,
        scopeId,
        null,
        false,
        async (endpoint, signal) => {
          const state = parseTerminalOutput(
            await requestBackendJson(
              endpoint,
              {
                path: `/api/desktop-workspace/tasks/${task}/terminals/${id}/output?after=0`,
                limit: 256 * 1024,
              },
              signal,
            ),
            task,
            id,
          );
          if (!state.terminal.alive || state.terminal.port !== port)
            throw new Error("The service is no longer running");
          const current = () =>
            client.state(window).scope?.id === scopeId && !signal.aborted;
          if (!current()) throw new Error("The backend changed");
          const environment = client.state(window).scope!.environment;
          let localPort = port;
          if (environment.kind === "remote") {
            const existing = remote
              .snapshot(window)
              .forwards.find((forward) => forward.remotePort === port);
            if (!existing)
              await remote.addForward(window, {
                remotePort: port,
                localPort: 0,
                label: `Terminal :${port}`,
              });
            else if (
              existing.phase === "unavailable" ||
              existing.phase === "conflict" ||
              existing.phase === "stopped"
            ) {
              // Only this explicit user action retries a failed saved listener.
              await remote.retryForward(window, existing.id);
            }
            if (!current()) throw new Error("The backend changed");
            // The listener's actual allocated port is authoritative; never assume remote localhost is local.
            localPort = await new Promise<number>((resolve, reject) => {
              const timer = setTimeout(
                () => finish(new Error("Port forwarding timed out")),
                10000,
              );
              const finish = (result: number | Error) => {
                clearTimeout(timer);
                stop();
                signal.removeEventListener("abort", aborted);
                if (typeof result === "number") resolve(result);
                else reject(result);
              };
              const aborted = () => finish(new Error("Port opening cancelled"));
              const check = () => {
                if (!current()) return finish(new Error("The backend changed"));
                const forward = remote
                  .snapshot(window)
                  .forwards.find((forward) => forward.remotePort === port);
                if (forward?.phase === "listening" && forward.boundPort)
                  finish(forward.boundPort);
                else if (
                  forward?.phase === "conflict" ||
                  forward?.phase === "unavailable" ||
                  forward?.phase === "stopped"
                )
                  finish(new Error("The service forward is unavailable"));
              };
              const stop = remote.subscribe((changedWindow) => {
                if (changedWindow === window) check();
              });
              signal.addEventListener("abort", aborted, { once: true });
              check();
            });
          }
          if (!current()) throw new Error("The backend changed");
          await open(
            `${state.terminal.protocol ?? "http"}://127.0.0.1:${localPort}/`,
          );
          return { accepted: true as const };
        },
        15000,
      );
    },
  );
}
