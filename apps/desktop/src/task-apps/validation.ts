import type { TaskAppRun } from "@elevenex/shared";
import { invalidResponse } from "../backend-client/transport";

export function appUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
  );
}

export function taskPath(taskId: number, runId?: string): string {
  if (
    !Number.isSafeInteger(taskId) ||
    taskId < 1 ||
    (runId !== undefined && !appUuid(runId))
  )
    throw new Error("Invalid app target");
  return runId === undefined
    ? `/api/task-apps/${taskId}`
    : `/api/task-apps/${taskId}/${runId}`;
}

function launchSpec(value: unknown): NonNullable<TaskAppRun["pendingLaunch"]> {
  if (
    !value ||
    typeof value !== "object" ||
    !("executable" in value) ||
    typeof value.executable !== "string" ||
    !value.executable.length ||
    value.executable.length > 4096 ||
    value.executable.includes("\0") ||
    !("args" in value) ||
    !Array.isArray(value.args) ||
    value.args.length > 128
  )
    throw invalidResponse();
  const args: string[] = [];
  let length = 0;
  for (const argument of value.args) {
    if (
      typeof argument !== "string" ||
      argument.includes("\0") ||
      argument.length > 8192 ||
      (length += argument.length) > 32768
    )
      throw invalidResponse();
    args.push(argument);
  }
  return { executable: value.executable, args };
}

export function appRuns(value: unknown, taskId: number): readonly TaskAppRun[] {
  if (!Array.isArray(value) || value.length > 128) throw invalidResponse();
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("taskId" in item) ||
      item.taskId !== taskId ||
      !("runId" in item) ||
      !appUuid(item.runId) ||
      ids.has(item.runId) ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      item.name.length > 256 ||
      !("startedAt" in item) ||
      typeof item.startedAt !== "number" ||
      !Number.isSafeInteger(item.startedAt) ||
      !("mode" in item) ||
      (item.mode !== "native" && item.mode !== "stream") ||
      !("status" in item) ||
      (item.status !== "requested" &&
        item.status !== "starting" &&
        item.status !== "running" &&
        item.status !== "stopping" &&
        item.status !== "exited" &&
        item.status !== "failed") ||
      ("detail" in item &&
        (typeof item.detail !== "string" || item.detail.length > 2048))
    )
      throw invalidResponse();
    const pendingLaunch =
      "pendingLaunch" in item ? launchSpec(item.pendingLaunch) : undefined;
    if ((item.status === "requested") !== !!pendingLaunch)
      throw invalidResponse();
    ids.add(item.runId);
    return {
      taskId,
      runId: item.runId,
      name: item.name,
      startedAt: item.startedAt,
      mode: item.mode,
      status: item.status,
      ...(pendingLaunch ? { pendingLaunch } : {}),
      ...("detail" in item && typeof item.detail === "string"
        ? { detail: item.detail }
        : {}),
    };
  });
}
