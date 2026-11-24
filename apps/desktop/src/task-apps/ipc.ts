import type {
  BackendResult,
  EnvironmentSelection,
  TaskAppWindowContext,
} from "@elevenex/shared";
import { validTaskAppInput } from "@elevenex/shared";
import type { BrowserWindow } from "electron";
import type { BackendClient } from "../backend-client/client";
import {
  invalidResponse,
  requestBackendJson,
} from "../backend-client/transport";
import { handleForWindow, sendToWindow, type TrustedSender } from "../ipc";
import { TaskAppStream } from "./stream";
import { appRuns, appUuid, taskPath } from "./validation";

interface Watch {
  scope: string;
  id: string;
  cancel(): void;
  stream?: TaskAppStream;
}

export function registerTaskApps(
  client: BackendClient,
  trusted: TrustedSender,
  popOut: (
    selection: EnvironmentSelection,
    context: TaskAppWindowContext,
    configuration: string,
  ) => BrowserWindow,
): () => void {
  const companions = new Map<
    number,
    {
      context: TaskAppWindowContext;
      configuration: string;
      window: BrowserWindow;
    }
  >();
  const watches = new Map<number, Watch>();
  function target(
    windowId: number,
    scope: string,
    taskId: number,
    runId?: string,
  ): string {
    const companion = companions.get(windowId);
    if (
      companion &&
      (companion.configuration !==
        client.configurationIdentity(windowId, scope) ||
        taskId !== companion.context.taskId ||
        (runId !== undefined && runId !== companion.context.runId))
    )
      throw new Error("Another app owns this window");
    return taskPath(taskId, runId);
  }
  function find(
    windowId: number,
    scope: string,
    id: string,
  ): Watch | undefined {
    const watch = watches.get(windowId);
    return watch?.scope === scope &&
      watch.id === id &&
      client.state(windowId).scope?.id === scope
      ? watch
      : undefined;
  }
  function read(windowId: number, scope: string, taskId: number) {
    const path = target(windowId, scope, taskId);
    return client.execute(
      windowId,
      scope,
      path,
      false,
      async (endpoint, signal) => {
        const runs = appRuns(
          await requestBackendJson(
            endpoint,
            // Include worst-case JSON escaping for four full proposals and 128 history rows.
            { path, limit: 2 * 1024 * 1024 },
            signal,
          ),
          taskId,
        );
        const companion = companions.get(windowId);
        return companion
          ? runs.filter((run) => run.runId === companion.context.runId)
          : runs;
      },
    );
  }
  const dispose = [
    handleForWindow("task-app:read", trusted, read),
    handleForWindow(
      "task-app:output",
      trusted,
      (windowId, scope, taskId, runId) => {
        const path = target(windowId, scope, taskId, runId) + "/output";
        return client.execute(
          windowId,
          scope,
          path,
          false,
          async (endpoint, signal) => {
            const value = await requestBackendJson(
              endpoint,
              { path, limit: 512 * 1024 },
              signal,
            );
            if (
              !value ||
              typeof value !== "object" ||
              !("output" in value) ||
              typeof value.output !== "string" ||
              value.output.length > 128 * 1024
            )
              throw invalidResponse();
            return value.output;
          },
        );
      },
    ),
    handleForWindow(
      "task-app:approve",
      trusted,
      (windowId, scope, taskId, runId) => {
        const path = target(windowId, scope, taskId, runId) + "/approve";
        return client.execute(
          windowId,
          scope,
          null,
          true,
          async (endpoint, signal) => {
            const result = await requestBackendJson(
              endpoint,
              { path, method: "POST", limit: 128 },
              signal,
            );
            if (
              !result ||
              typeof result !== "object" ||
              !("approved" in result) ||
              result.approved !== true
            )
              throw invalidResponse();
          },
        );
      },
    ),
    handleForWindow(
      "task-app:stop",
      trusted,
      (windowId, scope, taskId, runId) => {
        const path = target(windowId, scope, taskId, runId) + "/stop";
        return client.execute(
          windowId,
          scope,
          null,
          true,
          async (endpoint, signal) => {
            const result = await requestBackendJson(
              endpoint,
              { path, method: "POST", limit: 128 },
              signal,
            );
            if (
              !result ||
              typeof result !== "object" ||
              !("stopped" in result) ||
              result.stopped !== true
            )
              throw invalidResponse();
          },
        );
      },
    ),
    handleForWindow(
      "task-app:watch",
      trusted,
      async (
        windowId,
        scope,
        taskId,
        runId,
        id,
      ): Promise<BackendResult<void>> => {
        const path = target(windowId, scope, taskId, runId);
        if (!appUuid(id)) throw new Error("Invalid app watch");
        const lease = client.lease(windowId, scope);
        if (!lease.ok) return lease;
        watches.get(windowId)?.cancel();
        const { endpoint, signal, release } = lease.value;
        const watch: Watch = {
          scope,
          id,
          cancel: () => {
            if (watches.get(windowId) === watch) watches.delete(windowId);
            release();
          },
        };
        watches.set(windowId, watch);
        try {
          const response = await requestBackendJson(
            endpoint,
            { path: path + "/watch", method: "POST", limit: 256 },
            AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          );
          if (
            signal.aborted ||
            !response ||
            typeof response !== "object" ||
            !("token" in response) ||
            !appUuid(response.token)
          )
            throw invalidResponse();
          const stream = new TaskAppStream(
            endpoint,
            response.token,
            { scopeId: scope, watchId: id, taskId, runId },
            signal,
            (frame) => {
              if (find(windowId, scope, id) === watch)
                sendToWindow(windowId, "task-app:frame", frame);
            },
            (reason) => {
              if (find(windowId, scope, id) === watch)
                sendToWindow(windowId, "task-app:closed", {
                  scopeId: scope,
                  watchId: id,
                  reason,
                });
              watch.cancel();
            },
          );
          watch.stream = stream;
          await stream.ready;
          if (signal.aborted) throw invalidResponse();
          return { ok: true, value: undefined };
        } catch {
          watch.cancel();
          return {
            ok: false,
            error: {
              code: "unavailable",
              message:
                "App stream unavailable. Check the run and retry the stream.",
            },
          };
        }
      },
    ),
    handleForWindow("task-app:unwatch", trusted, (windowId, scope, id) =>
      find(windowId, scope, id)?.cancel(),
    ),
    handleForWindow("task-app:ack", trusted, (windowId, scope, id, sequence) =>
      find(windowId, scope, id)?.stream?.acknowledge(sequence),
    ),
    handleForWindow("task-app:input", trusted, (windowId, scope, id, input) => {
      const stream = find(windowId, scope, id)?.stream;
      if (!stream || !validTaskAppInput(input))
        throw new Error("Invalid app control");
      return stream.control(input);
    }),
    handleForWindow("task-app:release", trusted, (windowId, scope, id) =>
      find(windowId, scope, id)?.stream?.release(),
    ),
    handleForWindow(
      "task-app:window",
      trusted,
      (windowId) => companions.get(windowId)?.context ?? null,
    ),
    handleForWindow(
      "task-app:pop-out",
      trusted,
      async (windowId, scope, taskId, runId) => {
        target(windowId, scope, taskId, runId);
        if (companions.has(windowId))
          throw new Error("App already in companion window");
        const runs = await read(windowId, scope, taskId);
        const current = client.state(windowId).scope;
        const configuration = client.configurationIdentity(windowId, scope);
        if (
          !runs.ok ||
          !runs.value.some(
            (run) =>
              run.runId === runId &&
              run.status === "running" &&
              run.mode === "stream",
          ) ||
          current?.id !== scope ||
          !configuration
        )
          throw new Error("App unavailable");
        for (const companion of companions.values()) {
          if (
            configuration === companion.configuration &&
            runId === companion.context.runId &&
            taskId === companion.context.taskId
          ) {
            companion.window.restore();
            companion.window.show();
            companion.window.focus();
            return;
          }
        }
        if (companions.size >= 8) throw new Error("Too many app windows");
        const context = { taskId, runId };
        const window = popOut(current.environment, context, configuration);
        const id = window.webContents.id;
        companions.set(id, { context, configuration, window });
        window.once("closed", () => companions.delete(id));
      },
    ),
  ];
  return () => {
    for (const watch of watches.values()) watch.cancel();
    dispose.forEach((unregister) => unregister());
  };
}
