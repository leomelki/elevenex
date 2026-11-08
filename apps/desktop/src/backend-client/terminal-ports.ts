import type { BackendClient } from "./client";
import type { RemoteManager } from "../remote/manager";
import { handleForWindow, type TrustedSender } from "../ipc";
import { parseTerminalOutput } from "./task-terminal";
import { requestBackendJson } from "./transport";
import { parseTerminalServiceAddress } from './terminal-service-address';
import { object } from './terminal-validation';
import type { TaskTerminalServiceAddress } from '@elevenex/shared';

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
          if (
            !state.terminal.alive ||
            (state.terminal.port !== port &&
              !state.terminal.services?.some(service => service.port === port))
          )
            throw new Error("The service is no longer running");
          let service: TaskTerminalServiceAddress = {
            port, host: '127.0.0.1',
            protocol: state.terminal.protocol ?? 'http', path: '/',
          };
          const verifyService = async (): Promise<void> => {
            if (state.terminal.portDiscovery === undefined) return;
            const checked = object(await requestBackendJson(
              endpoint,
              {
                path: `/api/desktop-workspace/tasks/${task}/terminals/${id}/service?generation=${state.generation}&port=${port}`,
                limit: 4096,
              },
              signal,
            ));
            if (checked['generation'] !== state.generation)
              throw new Error('Terminal process changed');
            service = parseTerminalServiceAddress(checked['service']);
            if (service.port !== port) throw new Error('Terminal service changed');
          };
          await verifyService();
          const current = () =>
            client.state(window).scope?.id === scopeId && !signal.aborted;
          if (!current()) throw new Error("The backend changed");
          const environment = client.state(window).scope!.environment;
          let localPort = port;
          if (environment.kind === "remote") {
            const forwardedHost = service.host;
            const existing = remote
              .snapshot(window)
              .forwards.find((forward) => forward.remotePort === port);
            if (!existing)
              await remote.addForward(window, {
                remotePort: port,
                localPort: 0,
                label: `Terminal :${port}`,
              }, service.host);
            else {
              const retargeted = await remote.targetForward(window, existing.id, service.host);
              if (!retargeted && (
                existing.phase === "unavailable" ||
                existing.phase === "conflict" ||
                existing.phase === "stopped"
              )) {
                // Only this explicit user action retries a failed saved listener.
                await remote.retryForward(window, existing.id);
              }
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
            // Setting up a forward can take seconds. Recheck before navigation
            // so an exited/replaced service cannot use the earlier snapshot.
            await verifyService();
            if (service.host !== forwardedHost)
              throw new Error('The service address changed while forwarding');
          }
          if (!current()) throw new Error("The backend changed");
          const host = environment.kind === 'remote' ? '127.0.0.1' : service.host;
          const authority = host.includes(':') ? `[${host}]` : host;
          const url = `${service.protocol}://${authority}:${localPort}${service.path}`;
          await open(url);
          return { accepted: true as const, url };
        },
        25000,
      );
    },
  );
}
