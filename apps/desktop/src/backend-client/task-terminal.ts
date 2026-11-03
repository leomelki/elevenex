import type {
  TaskTerminal,
  TaskTerminalList,
  TaskTerminalOutput,
} from "@elevenex/shared";
import { handleForWindow, type TrustedSender } from "../ipc";
import type { BackendClient } from "./client";
import { invalidResponse, requestBackendJson } from "./transport";
import type { TerminalLifetime } from './terminal-lifetime';
import type { BackendEndpoint } from './transport';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid terminal object");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid terminal text");
  return value;
}
function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error("Invalid terminal number");
  return value;
}
function generation(value: unknown): string {
  const id = text(value, 36);
  if (!/^[a-f\d-]{36}$/.test(id))
    throw new Error("Invalid terminal generation");
  return id;
}
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key)))
    throw new Error("Unexpected terminal argument");
}
export function parseTaskTerminal(
  raw: unknown,
  taskId: number,
  terminalId?: number,
): TaskTerminal {
  try {
    const value = object(raw),
      id = integer(value["id"], 1);
    if (
      integer(value["taskId"], 1) !== taskId ||
      (terminalId !== undefined && id !== terminalId)
    )
      throw invalidResponse();
    const status = value["status"];
    if (
      status !== "idle" &&
      status !== "running" &&
      status !== "serving" &&
      status !== "failed" &&
      status !== "exited" &&
      status !== "unavailable"
    )
      throw invalidResponse();
    if (
      typeof value["canRerun"] !== "boolean" ||
      typeof value["alive"] !== "boolean"
    )
      throw invalidResponse();
    const protocol = value["protocol"];
    if (protocol !== undefined && protocol !== "http" && protocol !== "https")
      throw invalidResponse();
    const port =
      value["port"] === null ? null : integer(value["port"], 1, 65535);
    if (status === "serving" && port === null) throw invalidResponse();
    return {
      id,
      taskId,
      alive: value["alive"],
      title: text(value["title"], 120),
      cwd: text(value["cwd"], 8192),
      branch: text(value["branch"], 1024),
      generation:
        value["generation"] === null ? null : generation(value["generation"]),
      sequence: integer(value["sequence"]),
      status,
      command: text(value["command"], 4096),
      exitCode:
        value["exitCode"] === null ? null : integer(value["exitCode"], 0, 255),
      port,
      ...(protocol === undefined ? {} : { protocol }),
      canRerun: value["canRerun"],
    };
  } catch {
    throw invalidResponse();
  }
}
export function parseTerminalList(
  raw: unknown,
  task: number,
): TaskTerminalList {
  try {
    const value = object(raw);
    if (
      value["taskId"] !== task ||
      value["limit"] !== 16 ||
      !Array.isArray(value["terminals"]) ||
      value["terminals"].length > 16 ||
      !Array.isArray(value["scripts"]) ||
      value["scripts"].length > 100
    )
      throw invalidResponse();
    const terminals = value["terminals"].map((row) =>
      parseTaskTerminal(row, task),
    );
    if (new Set(terminals.map((row) => row.id)).size !== terminals.length)
      throw invalidResponse();
    const scripts = value["scripts"].map((raw) => {
      const row = object(raw);
      return {
        id: text(row["id"], 100),
        name: text(row["name"], 100),
        cmd: text(row["cmd"], 200),
      };
    });
    if (new Set(scripts.map((row) => row.id)).size !== scripts.length)
      throw invalidResponse();
    return { taskId: task, terminals, scripts, limit: 16 };
  } catch {
    throw invalidResponse();
  }
}
export function parseTerminalOutput(
  raw: unknown,
  task: number,
  id: number,
): TaskTerminalOutput {
  try {
    const value = object(raw),
      terminal = parseTaskTerminal(value["terminal"], task, id);
    const gen =
        value["generation"] === null ? null : generation(value["generation"]),
      from = integer(value["from"]),
      next = integer(value["next"]),
      data = text(value["data"], 32768);
    if (
      terminal.generation !== gen ||
      next < from ||
      next - from !== data.length ||
      next > terminal.sequence ||
      typeof value["gap"] !== "boolean" ||
      typeof value["more"] !== "boolean" ||
      value["more"] !== next < terminal.sequence
    )
      throw invalidResponse();
    return {
      terminal,
      generation: gen,
      from,
      next,
      data,
      gap: value["gap"],
      more: value["more"],
    };
  } catch {
    throw invalidResponse();
  }
}

export function registerTaskTerminalIpc(
  client: BackendClient,
  trusted: TrustedSender,
  lifetime?: Pick<TerminalLifetime, 'owner' | 'track'>,
): () => void {
  const stops: (() => void)[] = [];
  const track = (window: number, endpoint: BackendEndpoint) => {
    const environment = client.state(window).scope?.environment;
    lifetime?.track(endpoint, environment?.kind === 'remote' ? `remote:${environment.hostId}` : 'local');
  };
  const scope = (args: unknown[]) => {
    if (args.length !== 2) throw new Error("Invalid terminal arguments");
    return generation(args[0]);
  };
  const path = (task: number, id?: number) =>
    `/api/desktop-workspace/tasks/${task}/terminals${id === undefined ? "" : "/" + id}`;
  stops.push(
    handleForWindow("task-terminal:list", trusted, (window, ...args) => {
      const scopeId = scope(args),
        task = integer(args[1], 1);
      return client.execute(
        window,
        scopeId,
        `terminal:list:${task}`,
        false,
        async (endpoint, signal) => {
          track(window, endpoint);
          return parseTerminalList(
            await requestBackendJson(
              endpoint,
              { path: path(task), limit: 512 * 1024 },
              signal,
            ),
            task,
          );
        },
      );
    }),
  );
  stops.push(
    handleForWindow("task-terminal:create", trusted, (window, ...args) => {
      const scopeId = scope(args),
        value = object(args[1]);
      keys(value, ["taskId", "scriptId"]);
      const task = integer(value["taskId"], 1),
        script =
          value["scriptId"] === undefined
            ? undefined
            : text(value["scriptId"], 100);
      return client.execute(
        window,
        scopeId,
        null,
        true,
        async (endpoint, signal) => {
          track(window, endpoint);
          return parseTaskTerminal(
            await requestBackendJson(
              endpoint,
              {
                path: path(task),
                method: "POST",
                body: { ...(script === undefined ? {} : { scriptId: script }), ...(lifetime ? { owner: lifetime.owner } : {}) },
                limit: 16384,
              },
              signal,
            ),
            task,
          );
        },
        30000,
      );
    }),
  );
  stops.push(
    handleForWindow("task-terminal:read", trusted, (window, ...args) => {
      const scopeId = scope(args),
        value = object(args[1]);
      keys(value, ["taskId", "terminalId", "generation", "after"]);
      const task = integer(value["taskId"], 1),
        id = integer(value["terminalId"], 1),
        after = integer(value["after"]),
        gen =
          value["generation"] === null ? null : generation(value["generation"]);
      const query = new URLSearchParams({
        after: String(after),
        ...(gen ? { generation: gen } : {}),
      });
      return client.execute(
        window,
        scopeId,
        `terminal:read:${task}:${id}:${query}`,
        false,
        async (endpoint, signal) => {
          track(window, endpoint);
          const reply = parseTerminalOutput(
            await requestBackendJson(
              endpoint,
              { path: path(task, id) + "/output?" + query, limit: 256 * 1024 },
              signal,
            ),
            task,
            id,
          );
          if (!reply.gap && (reply.generation !== gen || reply.from !== after))
            throw invalidResponse();
          return reply;
        },
      );
    }),
  );
  const accepted = async (value: Promise<unknown>) => {
    if (object(await value)["accepted"] !== true) throw invalidResponse();
    return { accepted: true as const };
  };
  stops.push(
    handleForWindow("task-terminal:input", trusted, (window, ...args) => {
      const scopeId = scope(args),
        value = object(args[1]);
      keys(value, ["taskId", "terminalId", "generation", "data"]);
      const task = integer(value["taskId"], 1),
        id = integer(value["terminalId"], 1),
        gen = generation(value["generation"]),
        data = text(value["data"], 32768);
      if (!data || Buffer.byteLength(data) > 32768)
        throw new Error("Terminal input is too large");
      return client.execute(window, scopeId, null, true, (endpoint, signal) =>
        accepted(
          requestBackendJson(
            endpoint,
            {
              path: path(task, id),
              method: "POST",
              body: { type: "input", generation: gen, data },
              limit: 1024,
            },
            signal,
          ),
        ),
      );
    }),
  );
  stops.push(
    handleForWindow("task-terminal:resize", trusted, (window, ...args) => {
      const scopeId = scope(args),
        value = object(args[1]);
      keys(value, ["taskId", "terminalId", "generation", "cols", "rows"]);
      const task = integer(value["taskId"], 1),
        id = integer(value["terminalId"], 1),
        gen = generation(value["generation"]),
        cols = integer(value["cols"], 2, 500),
        rows = integer(value["rows"], 1, 300);
      return client.execute(window, scopeId, null, true, (endpoint, signal) =>
        accepted(
          requestBackendJson(
            endpoint,
            {
              path: path(task, id),
              method: "POST",
              body: { type: "resize", generation: gen, cols, rows },
              limit: 1024,
            },
            signal,
          ),
        ),
      );
    }),
  );
  stops.push(
    handleForWindow("task-terminal:action", trusted, (window, ...args) => {
      const scopeId = scope(args),
        value = object(args[1]);
      keys(value, ["taskId", "terminalId", "generation", "type"]);
      const task = integer(value["taskId"], 1),
        id = integer(value["terminalId"], 1),
        gen = generation(value["generation"]),
        type = value["type"];
      if (type !== "interrupt" && type !== "rerun")
        throw new Error("Invalid terminal action");
      return client.execute(
        window,
        scopeId,
        null,
        true,
        (endpoint, signal) =>
          accepted(
            requestBackendJson(
              endpoint,
              {
                path: path(task, id),
                method: "POST",
                body: { type, generation: gen },
                limit: 1024,
              },
              signal,
            ),
          ),
        30000,
      );
    }),
  );
  stops.push(
    handleForWindow("task-terminal:close", trusted, (window, ...args) => {
      const scopeId = scope(args),
        value = object(args[1]);
      keys(value, ["taskId", "terminalId"]);
      const task = integer(value["taskId"], 1),
        id = integer(value["terminalId"], 1);
      return client.execute(
        window,
        scopeId,
        null,
        true,
        (endpoint, signal) =>
          accepted(
            requestBackendJson(
              endpoint,
              { path: path(task, id), method: "DELETE", limit: 1024 },
              signal,
            ),
          ),
        30000,
      );
    }),
  );
  return () => {
    for (const stop of stops) stop();
  };
}
