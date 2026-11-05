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

import { object, text, integer, generation, keys } from './terminal-validation';
import { parseTerminalCommands } from './terminal-commands';
export { parseTerminalCommands } from './terminal-commands';

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
    const shellIntegration = value['shellIntegration'];
    if (shellIntegration !== undefined && shellIntegration !== 'pending' && shellIntegration !== 'active' &&
        shellIntegration !== 'disabled' && shellIntegration !== 'unsupported' && shellIntegration !== 'unavailable')
      throw invalidResponse();
    const rawActivityTitle = value['activityTitle'];
    const activityTitle = rawActivityTitle === undefined || rawActivityTitle === null ? rawActivityTitle : text(rawActivityTitle, 120);
    // This is untrusted display metadata, never a command or path grant.
    if (typeof activityTitle === 'string' && (!activityTitle.trim() ||
        // eslint-disable-next-line no-control-regex -- Reject terminal control characters in display metadata.
        /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(activityTitle) ||
        /[\uD800-\uDFFF]/u.test(activityTitle))) throw invalidResponse();
    const currentCwd = value['currentCwd'];
    const commandTracking = value['commandTracking'];
    if (commandTracking !== undefined && commandTracking !== true) throw invalidResponse();
    const port =
      value["port"] === null ? null : integer(value["port"], 1, 65535);
    if (status === "serving" && port === null) throw invalidResponse();
    return {
      id,
      taskId,
      alive: value["alive"],
      title: text(value["title"], 120),
      ...(activityTitle === undefined ? {} : { activityTitle }),
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
      ...(shellIntegration === undefined ? {} : { shellIntegration }),
      ...(currentCwd === undefined ? {} : { currentCwd: currentCwd === null ? null : text(currentCwd, 8192) }),
      ...(commandTracking === undefined ? {} : { commandTracking }),
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
    const control = value['shellIntegrationControl'];
    if (control !== undefined && typeof control !== 'boolean') throw invalidResponse();
    return { taskId: task, terminals, scripts, limit: 16,
      ...(control === undefined ? {} : { shellIntegrationControl: control }),
    };
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
    const rawSize = value["size"] === undefined ? undefined : object(value["size"]);
    const size = rawSize === undefined ? undefined : {
      cols: integer(rawSize["cols"], 2, 500),
      rows: integer(rawSize["rows"], 1, 300),
    };
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
    const rawStarts = value['commandStarts'];
    if (rawStarts !== undefined && (!Array.isArray(rawStarts) || rawStarts.length > 201)) throw invalidResponse();
    const commandStarts = (Array.isArray(rawStarts) ? rawStarts : undefined)?.map((raw: unknown) => {
      const marker = object(raw);
      return { id: integer(marker['id'], 1), at: integer(marker['at'], from + 1, next) };
    });
    if (commandStarts?.some((marker, index) => index > 0 &&
      (marker.id <= commandStarts[index - 1]!.id || marker.at <= commandStarts[index - 1]!.at))) throw invalidResponse();
    return {
      terminal,
      generation: gen,
      from,
      next,
      data,
      gap: value["gap"],
      more: value["more"],
      ...(size === undefined ? {} : { size }),
      ...(commandStarts === undefined ? {} : { commandStarts }),
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
              { path: path(task), limit: 1024 * 1024 },
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
      keys(value, ["taskId", "scriptId", "shellIntegration"]);
      const shellIntegration = value['shellIntegration'];
      if (shellIntegration !== undefined && typeof shellIntegration !== 'boolean')
        throw new Error('Invalid shell integration option');
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
                body: { ...(script === undefined ? {} : { scriptId: script }),
                  ...(shellIntegration === undefined ? {} : { shellIntegration }),
                  ...(lifetime ? { owner: lifetime.owner } : {}) },
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
  stops.push(handleForWindow('task-terminal:commands', trusted, (window, ...args) => {
    const scopeId = scope(args), value = object(args[1]);
    keys(value, ['taskId', 'terminalId', 'generation', 'after']);
    const task = integer(value['taskId'], 1), id = integer(value['terminalId'], 1),
      after = integer(value['after']), gen = value['generation'] === null ? null : generation(value['generation']);
    const query = new URLSearchParams({ after: String(after), ...(gen ? { generation: gen } : {}) });
    return client.execute(window, scopeId, `terminal:commands:${task}:${id}:${query}`, false,
      async (endpoint, signal) => {
        track(window, endpoint);
        const reply = parseTerminalCommands(await requestBackendJson(endpoint,
          { path: path(task, id) + '/commands?' + query, limit: 1024 * 1024 }, signal), task, id);
        if (!reply.gap && (reply.generation !== gen ||
          (reply.commands.length ? reply.commands[0]!.id !== after + 1 : reply.next !== after))) throw invalidResponse();
        return reply;
      });
  }));
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
