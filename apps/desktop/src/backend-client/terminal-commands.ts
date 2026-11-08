import type {
  TaskTerminalCommand,
  TaskTerminalCommands,
} from "@elevenex/shared";
import { invalidResponse } from "./transport";
import { object, text, integer, generation } from "./terminal-validation";

function nullableNumber(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): number | null {
  return value === null ? null : integer(value, 0, max);
}
function command(raw: unknown): TaskTerminalCommand {
  const value = object(raw),
    state = value["state"],
    confidence = value["confidence"];
  if (state !== "running" && state !== "completed" && state !== "interrupted")
    throw invalidResponse();
  if (
    confidence !== "exact" &&
    confidence !== "history" &&
    confidence !== "unavailable"
  )
    throw invalidResponse();
  const row: TaskTerminalCommand = {
    id: integer(value["id"], 1),
    command: value["command"] === null ? null : text(value["command"], 4096),
    confidence,
    cwd: value["cwd"] === null ? null : text(value["cwd"], 8192),
    state,
    startedAt: nullableNumber(value["startedAt"]),
    finishedAt: nullableNumber(value["finishedAt"]),
    durationMs: nullableNumber(value["durationMs"]),
    outputStart: nullableNumber(value["outputStart"]),
    outputEnd: nullableNumber(value["outputEnd"]),
    exitCode: nullableNumber(value["exitCode"], 255),
  };
  if (
    (row.command === null) !== (confidence === "unavailable") ||
    (row.startedAt === null) !== (row.outputStart === null) ||
    (state === "running" &&
      (row.finishedAt !== null ||
        row.outputEnd !== null ||
        row.durationMs !== null ||
        row.exitCode !== null)) ||
    (state !== "running" &&
      (row.finishedAt === null || row.outputEnd === null)) ||
    (state === "completed") !== (row.exitCode !== null) ||
    (state !== "running" &&
      (row.startedAt === null) !== (row.durationMs === null)) ||
    (row.outputStart !== null &&
      row.outputEnd !== null &&
      row.outputEnd < row.outputStart)
  )
    throw invalidResponse();
  return row;
}

export function parseTerminalCommands(
  raw: unknown,
  task: number,
  id: number,
): TaskTerminalCommands {
  try {
    const value = object(raw),
      rows = value["commands"];
    if (
      value["taskId"] !== task ||
      value["terminalId"] !== id ||
      !Array.isArray(rows) ||
      rows.length > 20 ||
      typeof value["more"] !== "boolean" ||
      typeof value["gap"] !== "boolean"
    )
      throw invalidResponse();
    const commands = rows.map(command),
      current = value["current"] === null ? null : command(value["current"]),
      next = integer(value["next"]);
    const gen =
      value["generation"] === null ? null : generation(value["generation"]);
    if (
      commands.some(
        (row, index) =>
          row.state === "running" ||
          (index > 0 && row.id !== commands[index - 1]!.id + 1),
      ) ||
      (commands.length > 0 && commands.at(-1)!.id !== next) ||
      (current !== null &&
        (current.state !== "running" || current.id <= next)) ||
      (value["more"] && commands.length !== 20) ||
      (gen === null &&
        (commands.length > 0 ||
          current !== null ||
          next !== 0 ||
          value["more"]))
    )
      throw invalidResponse();
    return {
      taskId: task,
      terminalId: id,
      generation: gen,
      commands,
      current,
      next,
      more: value["more"],
      gap: value["gap"],
    };
  } catch {
    throw invalidResponse();
  }
}
