import type { SessionChatItem } from "@elevenex/shared";
import type { ToolBlock, ToolListItem } from "../conversation";

interface ToolFocus {
  readonly preview: readonly ToolBlock[];
  readonly previewNotice?: string;
}

const technicalField =
  /\b(?:id|uuid|token|cursor|offset|timestamp|connection|server|tool|arguments|parameters|working directory|purpose|exit code|duration|created at|updated at)\b/i;
const usefulField =
  /^(?:title|name|status|state|summary|description|message|result|answer|error|reason|count|total|branch|path)$/i;

/** Select evidence for the collapsed card. This intentionally differs from the
 * complete parsed receipt: parameters and transport metadata belong in Details. */
export function focusSessionTool(
  item: SessionChatItem,
  result: SessionChatItem | undefined,
  blocks: readonly ToolBlock[],
  resultStart: number,
): ToolFocus {
  const input = blocks.slice(0, resultStart),
    output = blocks.slice(resultStart);
  const preview: ToolBlock[] = [];
  let hiddenLines = 0,
    hiddenRows = 0,
    hiddenText = false;
  const short = (value: string, limit: number): string => {
    if (value.length <= limit) return value;
    hiddenText = true;
    return value.slice(0, limit).trimEnd() + "…";
  };
  const lines = (value: string, limit = 6, tail = false): string => {
    const all = value.split(/\r?\n/);
    if (all.at(-1) === "") all.pop();
    hiddenLines += Math.max(0, all.length - limit);
    const selected = tail ? all.slice(-limit) : all.slice(0, limit);
    return (
      selected.map((line) => short(line, 110)).join("\n") +
      (selected.at(-1) === "" ? "\n" : "")
    );
  };
  const cleanRow = (row: ToolListItem): ToolListItem => ({
    ...row,
    label: short(row.label, 100),
    detail: row.detail
      ? short(
          row.detail
            .split(" · ")
            .filter((part) => !technicalField.test(part.split(":")[0] ?? ""))
            .join(" · "),
          160,
        ) || undefined
      : undefined,
  });
  const patchLines = (value: string, limit: number): string => {
    const all = value.trimEnd().split("\n");
    const useful = all.filter(
      (line) => !/^\*\*\* (?:Begin Patch|End Patch|End of File)$/.test(line),
    );
    const change = useful.findIndex((line) => /^[+-](?![+-])/.test(line));
    const start = change < 0 ? 0 : Math.max(0, change - 1);
    const selected = useful.slice(start, start + limit);
    const file = useful.find((line) =>
      /^\*\*\* (?:Update|Add|Delete) File:/.test(line),
    );
    if (file && !selected.includes(file)) selected.unshift(file);
    hiddenLines += Math.max(0, all.length - selected.length);
    return selected.map((line) => short(line, 110)).join("\n");
  };
  const shrink = (
    block: ToolBlock,
    lineLimit = 6,
    tail = false,
    rowLimit = 3,
  ): ToolBlock | undefined => {
    switch (block.kind) {
      case "code":
        return { ...block, text: lines(block.text, lineLimit, tail) };
      case "patch":
        return { ...block, text: patchLines(block.text, lineLimit) };
      case "text":
        return { ...block, text: short(lines(block.text, 3), 280) };
      case "diff":
        return {
          ...block,
          before: lines(
            block.before,
            block.before && block.after
              ? Math.max(1, Math.floor(lineLimit / 2))
              : lineLimit,
          ),
          after: lines(
            block.after,
            block.before && block.after
              ? Math.max(1, Math.floor(lineLimit / 2))
              : lineLimit,
          ),
        };
      case "list": {
        hiddenRows += Math.max(0, block.items.length - rowLimit);
        return block.items.length
          ? { ...block, items: block.items.slice(0, rowLimit).map(cleanRow) }
          : undefined;
      }
      case "fields": {
        const fields = block.fields
          .filter((field) => !technicalField.test(field.label))
          .sort(
            (a, b) =>
              Number(usefulField.test(b.label)) -
              Number(usefulField.test(a.label)),
          )
          .slice(0, 2)
          .map((field) => ({ ...field, value: short(field.value, 110) }));
        return fields.length ? { ...block, fields } : undefined;
      }
    }
  };
  const add = (
    block: ToolBlock | undefined,
    limit = 6,
    tail = false,
    rowLimit = 3,
  ): void => {
    if (!block || preview.length >= 2) return;
    const selected = shrink(block, limit, tail, rowLimit);
    if (selected)
      preview.push(
        selected.kind === "patch" || item.toolKind === "file_changes"
          ? selected
          : { ...selected, title: undefined },
      );
  };
  const evidence = (candidates: readonly ToolBlock[]): void => {
    const narrative = candidates.find(
      (block) =>
        block.kind === "text" &&
        /message|summary|final|answer|result|error|reason/i.test(
          block.title ?? "",
        ),
    );
    const fields = candidates
      .flatMap((block) => (block.kind === "fields" ? block.fields : []))
      .filter((field) => !technicalField.test(field.label))
      .sort(
        (a, b) =>
          Number(usefulField.test(b.label)) - Number(usefulField.test(a.label)),
      );
    const heading = fields.find((field) =>
      /^(?:title|name)$/i.test(field.label),
    );
    if (heading) add({ kind: "text", text: short(heading.value, 120) });
    const primaryFields = fields.filter(
      (field) =>
        field !== heading &&
        !/^(?:title|name|assignee|owner)$/i.test(field.label),
    );
    if (primaryFields.length)
      add({ kind: "fields", title: "Result", fields: primaryFields });
    if (narrative) add(narrative);
    if (preview.length < 2)
      add(candidates.find((block) => block.kind === "list"));
    if (!preview.length)
      add(candidates.find((block) => block.kind !== "fields"));
  };
  const failed = result?.error === true;
  if (failed) {
    const meaningful = output.filter(
      (block) =>
        block.kind !== "fields" ||
        block.fields.some((field) => !technicalField.test(field.label)),
    );
    const error = meaningful.find((block) =>
      /error|stderr|reason|message|final|read error|standard error/i.test(
        block.title ?? "",
      ),
    );
    const reason =
      error ??
      meaningful.find(
        (block) => block.kind === "text" || block.kind === "code",
      );
    if (reason?.kind === "text" || reason?.kind === "code") {
      const originalLines = reason.text.split("\n");
      const reasonLines = originalLines.filter(
        (line) => !/^\s*(?:at\s|File\s"|Traceback\b)/.test(line),
      );
      hiddenLines += originalLines.length - reasonLines.length;
      const text = reasonLines.join("\n");
      add({ ...reason, text }, 4, !error && reason.kind === "code");
    } else add(reason, 4);
    if (!preview.length)
      add({
        kind: "text",
        title: "Error",
        text: "The tool failed without additional error details.",
      });
  }

  switch (item.toolKind) {
    case "bash": {
      if (!failed) {
        const commandOutput =
          output.find((block) => block.title === "Output") ??
          output.find((block) => block.title === "Standard error");
        if (commandOutput) add(commandOutput, 6, commandOutput.kind === "code");
        else evidence(output);
        if (!preview.length) add({ kind: "text", text: "No output received." });
      }
      break;
    }
    case "read":
      if (!failed)
        add(output.find((block) => block.kind === "code") ?? output[0]);
      break;
    case "write":
    case "notebook_edit":
      if (!failed) add(input.find((block) => block.kind === "code"));
      break;
    case "edit":
      if (!failed)
        add(
          input.find(
            (block) => block.kind === "diff" || block.kind === "patch",
          ),
        );
      break;
    case "file_changes": {
      if (failed) break;
      const patches = input.filter(
        (block) =>
          block.kind === "patch" ||
          block.kind === "diff" ||
          block.kind === "text",
      );
      if (patches.length) {
        add(patches[0], patches.length > 1 ? 3 : 6);
        add(patches[1], 3);
      } else add(input.find((block) => block.kind === "list"));
      break;
    }
    case "grep":
    case "glob":
      if (!failed)
        add(
          output.find(
            (block) => block.kind === "code" || block.kind === "list",
          ) ?? output[0],
          6,
          false,
          item.toolKind === "glob" ? 4 : 3,
        );
      break;
    case "web_search":
    case "web_fetch": {
      if (failed) break;
      const sources = output.find(
        (block) => block.kind === "list" && block.title === "Sources",
      );
      if (sources?.kind === "list") {
        const items = sources.items.map((row) => {
          const match = row.detail?.match(
            /(?:URL|URI|Link):\s*(https?:\/\/[^\s·]+)/i,
          );
          let domain = "";
          try {
            if (match?.[1])
              domain = new URL(match[1]).hostname.replace(/^www\./, "");
          } catch {
            /* Invalid source URLs remain available in Details. */
          }
          const snippet = row.detail
            ?.split(" · ")
            .find((part) =>
              /^(?:snippet|description|summary|text|content):/i.test(part),
            )
            ?.replace(/^[^:]+:\s*/, "");
          return {
            label: row.label,
            detail: [domain, snippet].filter(Boolean).join(" · ") || undefined,
            status: row.status,
          };
        });
        add({ ...sources, items });
      } else evidence(output);
      break;
    }
    case "todo_write": {
      const plan = input.find(
        (block) => block.kind === "list" && block.title === "Plan",
      );
      if (plan?.kind === "list" && !failed) {
        const active = plan.items.filter((row) => row.status === "running"),
          pending = plan.items.filter(
            (row) => row.status === "pending" || !row.status,
          );
        const remaining = [...active, ...pending];
        hiddenRows += plan.items.length - remaining.length;
        if (remaining.length) add({ ...plan, items: remaining });
        else add({ kind: "text", text: "All steps complete." });
      }
      break;
    }
    case "task_agent":
    case "agent_collaboration":
      if (!failed) {
        evidence(output);
        if (!preview.length)
          add(
            input.find(
              (block) =>
                block.kind === "text" && block.title === "Instructions",
            ),
          );
      }
      break;
    case "ask_user_question":
      if (!failed) {
        evidence(output);
        if (!preview.length)
          add(
            input.find((block) => block.kind === "list"),
            6,
            false,
            1,
          );
      }
      break;
    case "enter_plan_mode":
    case "exit_plan_mode":
      if (!failed) {
        evidence(output);
        if (!preview.length) add(input.find((block) => block.kind === "text"));
      }
      break;
    case "worktree":
    case "lsp":
    case "skill":
    case "mcp":
    default:
      if (!failed) evidence(result ? output : input);
  }

  const notices = [
    hiddenLines
      ? `${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}`
      : "",
    hiddenRows
      ? `${hiddenRows} more ${hiddenRows === 1 ? "item" : "items"}`
      : "",
    hiddenText ? "More text" : "",
  ].filter(Boolean);
  return {
    preview,
    ...(notices.length ? { previewNotice: notices.join(" · ") } : {}),
  };
}
