import type { SessionChatItem } from "@elevenex/shared";
import type { ShellToolPresentation } from "../conversation/tool-presentation";

type Data = Readonly<Record<string, unknown>>;
const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const text = (data: Data, ...keys: string[]): string => {
  for (const key of keys)
    if (typeof data[key] === "string" && data[key]) return data[key];
  return "";
};
const integer = (value: unknown): number | undefined => {
  if (typeof value === "string" && /^-?\d+$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
};
const OUTPUT_LIMIT = 100_000;
const COMMAND_LIMIT = 24_000;

/** Preserve stdout/stderr and provider facts without teaching the view about harness payloads.
 * The adapter bounds source text; ANSI parsing/DOM work belongs to the lazy disclosure. */
export function sessionShellTool(
  item: SessionChatItem,
  result: SessionChatItem | undefined,
  decodedInput: unknown,
  output: unknown,
): ShellToolPresentation {
  const input = record(decodedInput);
  const data = record(output);
  const command =
    text(input, "command", "cmd", "input") ||
    (typeof decodedInput === "string" ? decodedInput : "");
  const exitCode =
    integer(result?.execution?.exitCode) ??
    integer(data["exit_code"] ?? data["exitCode"]) ??
    integer(
      result?.text.match(
        /^(?:Chunk ID:[^\n]*\n|Wall time:[^\n]*\n)*(?:Process exited with code|Exit code:)\s*(-?\d+)(?:\n|$)/i,
      )?.[1],
    );
  const render = (value: unknown): string =>
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value, null, 2);
  let captured = "";
  if (["stdout", "stderr", "output"].some((key) => Object.hasOwn(data, key))) {
    const stdout =
      data["stdout"] === ""
        ? data["output"]
        : (data["stdout"] ?? data["output"]);
    captured = [
      render(stdout),
      data["stdout"] && data["output"] !== data["stdout"]
        ? render(data["output"])
        : "",
      render(data["stderr"]),
    ]
      .filter(Boolean)
      .join("\n");
  } else if (result) {
    // Only strip the known leading transport receipt, never similarly named command output.
    captured =
      typeof output === "string"
        ? output.replace(
            /^(?:Chunk ID:.*\n|Wall time:.*\n|Process exited with code.*\n|Final output:\n)+/g,
            "",
          )
        : render(output);
  }
  const ms = data["duration_ms"] ?? data["durationMs"];
  const seconds =
    typeof ms === "number" && Number.isFinite(ms) && ms >= 0
      ? ms / 1000
      : undefined;
  return {
    command: command.slice(0, COMMAND_LIMIT),
    directory: (
      item.execution?.cwd ??
      result?.execution?.cwd ??
      text(input, "cwd", "workdir", "working_directory")
    ).slice(0, 4000),
    description: text(input, "description").slice(0, 1000),
    output: captured.slice(-OUTPUT_LIMIT),
    ...(exitCode !== undefined ? { exitCode } : {}),
    interrupted:
      result?.execution?.interrupted === true || data["interrupted"] === true,
    failed:
      item.error ||
      result?.error === true ||
      (exitCode !== undefined && exitCode !== 0),
    ...(seconds !== undefined
      ? {
          duration:
            seconds < 1
              ? "<1s"
              : seconds < 60
                ? `${Math.floor(seconds)}s`
                : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`,
        }
      : {}),
    commandShortened: item.truncated || command.length > COMMAND_LIMIT,
    outputShortened:
      result?.truncated === true || captured.length > OUTPUT_LIMIT,
  };
}
