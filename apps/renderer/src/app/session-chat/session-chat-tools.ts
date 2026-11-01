import type { SessionChatItem } from "@elevenex/shared";
import type {
  StepKind,
  ToolBlock,
  ToolField,
  ToolListItem,
  ToolPresentation,
} from "../conversation";
import { focusSessionTool } from "./session-tool-focus";

type Data = Readonly<Record<string, unknown>>;
const MAX_ROWS = 40;
const MAX_BLOCKS = 18;
const TEXT_BUDGET = 16000;
const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const list = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];
function string(data: Data, ...keys: string[]): string {
  for (const key of keys)
    if (typeof data[key] === "string" && data[key]) return data[key];
  return "";
}
function decode(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
function label(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b(?:url|uri|id|cwd)\b/gi, (value) =>
      value === "cwd" ? "Working directory" : value.toUpperCase(),
    )
    .replace(/^./, (value) => value.toUpperCase());
}
function scalar(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value === null
        ? "None"
        : "";
}
function sameData(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (
    depth >= 4 ||
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const leftEntries = Object.entries(left),
    rightData = record(right);
  if (
    leftEntries.length > MAX_ROWS ||
    leftEntries.length !== Object.keys(right).length
  )
    return false;
  return leftEntries.every(
    ([key, value]) =>
      Object.hasOwn(right, key) &&
      sameData(
        value,
        Array.isArray(right) ? right[Number(key)] : rightData[key],
        depth + 1,
      ),
  );
}
function containsData(value: unknown, target: unknown, depth = 0): boolean {
  if (sameData(value, target)) return true;
  return (
    depth < 3 &&
    value !== null &&
    typeof value === "object" &&
    Object.values(value)
      .slice(0, MAX_ROWS)
      .some(
        (child) =>
          child !== null &&
          typeof child === "object" &&
          containsData(child, target, depth + 1),
      )
  );
}
function status(value: unknown): ToolListItem["status"] {
  return value === "completed" || value === "done" || value === "success"
    ? "done"
    : value === "in_progress" || value === "running"
      ? "running"
      : value === "failed" || value === "error"
        ? "failed"
        : value === "pending"
          ? "pending"
          : undefined;
}
const kinds: Readonly<Record<string, StepKind>> = {
  read: "read",
  write: "create",
  edit: "edit",
  file_changes: "edit",
  notebook_edit: "edit",
  bash: "run",
  grep: "search",
  glob: "list",
  web_fetch: "web",
  web_search: "web",
  ask_user_question: "ask",
};
export function sessionToolKind(item: SessionChatItem): StepKind {
  const kind = item.toolKind ?? "";
  return Object.hasOwn(kinds, kind) ? kinds[kind]! : "tool";
}
export function sessionToolVerb(
  item: SessionChatItem,
  live: boolean,
  outcome?: "failed" | "unknown",
): string {
  if (outcome) {
    const actions: Readonly<Record<string, string>> = {
      read: "read",
      write: "write",
      edit: "edit",
      file_changes: "apply changes",
      notebook_edit: "edit notebook",
      bash: "run",
      grep: "search",
      glob: "list",
      web_fetch: "fetch",
      web_search: "search the web",
      todo_write: "update plan",
      task_agent: "delegate",
      agent_collaboration: "coordinate",
      ask_user_question: "ask",
      enter_plan_mode: "enter plan mode",
      exit_plan_mode: "review plan",
      worktree: "prepare workspace",
      lsp: "check code",
      skill: "load skill",
      mcp: "use connection",
    };
    const kind = item.toolKind ?? "";
    const action = Object.hasOwn(actions, kind) ? actions[kind] : "use tool";
    return `${outcome === "failed" ? "Failed to" : "Attempted to"} ${action}`;
  }
  const verbs: Readonly<Record<string, readonly [string, string]>> = {
    read: ["Read", "Reading"],
    write: ["Wrote", "Writing"],
    edit: ["Edited", "Editing"],
    file_changes: ["Patched", "Patching"],
    notebook_edit: ["Edited notebook", "Editing notebook"],
    bash: ["Ran", "Running"],
    grep: ["Searched", "Searching"],
    glob: ["Listed", "Listing"],
    web_fetch: ["Fetched", "Fetching"],
    web_search: ["Searched the web", "Searching the web"],
    todo_write: ["Updated plan", "Updating plan"],
    task_agent: ["Delegated", "Delegating"],
    agent_collaboration: ["Coordinated", "Coordinating"],
    ask_user_question: ["Asked", "Asking"],
    enter_plan_mode: ["Entered plan mode", "Entering plan mode"],
    exit_plan_mode: ["Reviewed plan", "Reviewing plan"],
    worktree: ["Prepared workspace", "Preparing workspace"],
    lsp: ["Checked code", "Checking code"],
    skill: ["Loaded skill", "Loading skill"],
    mcp: ["Used connection", "Using connection"],
  };
  const kind = item.toolKind ?? "";
  return Object.hasOwn(verbs, kind)
    ? verbs[kind]![live ? 1 : 0]
    : live
      ? "Using tool"
      : "Used tool";
}

/** Parsing never evaluates tool content or fetches returned links/media. A single budget
 * bounds both nested provider responses and their DOM representation. Original payloads
 * remain available through the transcript's separate raw-content reader. */
export function presentSessionTool(
  item: SessionChatItem,
  result?: SessionChatItem,
): ToolPresentation {
  const decodedInput = decode(item.input),
    input = record(decodedInput);
  const blocks: ToolBlock[] = [];
  let reserved = result?.error ? 6000 : 0;
  let remaining = TEXT_BUDGET - reserved,
    shortened = item.truncated || result?.truncated === true;
  let blockLimit = reserved ? MAX_BLOCKS - 4 : MAX_BLOCKS;
  let resultStart: number | undefined;
  const beginOutput = (): void => {
    resultStart ??= blocks.length;
    remaining += reserved;
    reserved = 0;
    blockLimit = MAX_BLOCKS;
  };
  const take = (text: string, limit = 8000): string => {
    const length = Math.min(remaining, limit);
    if (text.length > length) shortened = true;
    const value = text.slice(0, length);
    remaining -= value.length;
    return value;
  };
  const add = (block: ToolBlock): void => {
    if (blocks.length < blockLimit) blocks.push(block);
    else shortened = true;
  };
  const text = (
    title: string,
    value: string,
    code = false,
    patch = false,
  ): void => {
    if (!value.trim()) return;
    const bounded = take(value);
    if (bounded)
      add({
        kind: patch ? "patch" : code ? "code" : "text",
        title,
        text: bounded,
      });
  };
  const fields = (values: readonly ToolField[], title?: string): void => {
    const present = values.filter((field) => field.value !== "");
    if (present.length > MAX_ROWS) shortened = true;
    const bounded = present
      .slice(0, MAX_ROWS)
      .map((field) => ({
        label: take(field.label, 100),
        value: take(field.value, 1600),
      }))
      .filter((field) => field.value);
    if (bounded.length) add({ kind: "fields", title, fields: bounded });
  };
  const rows = (
    title: string,
    values: readonly unknown[],
    convert: (value: unknown) => ToolListItem,
  ): void => {
    if (values.length > MAX_ROWS) shortened = true;
    const items = values
      .slice(0, MAX_ROWS)
      .map(convert)
      .map((row) => ({
        ...row,
        label: take(row.label, 800),
        detail: row.detail ? take(row.detail, 1600) : undefined,
      }))
      .filter((row) => row.label || row.detail);
    if (items.length) add({ kind: "list", title, items });
  };
  const field = (name: string, ...keys: string[]): ToolField => ({
    label: name,
    value: string(input, ...keys),
  });
  const compact = (value: unknown, depth = 0): string => {
    if (value === null || typeof value !== "object") {
      const rendered = scalar(value);
      if (rendered.length > 800) shortened = true;
      return rendered.slice(0, 800);
    }
    if (depth >= 3) {
      shortened = true;
      return "More details in original data";
    }
    const data = record(value);
    if (["image", "audio"].includes(String(data["type"])))
      return `${label(String(data["type"]))} attachment${string(data, "mimeType", "mime_type") ? ` (${string(data, "mimeType", "mime_type")})` : ""}`;
    const entries = Object.entries(value);
    if (entries.length > 8) shortened = true;
    return entries
      .slice(0, 8)
      .map(([key, nested]) =>
        Array.isArray(value)
          ? compact(nested, depth + 1)
          : `${label(key)}: ${compact(nested, depth + 1)}`,
      )
      .join(" · ");
  };
  const genericRow = (value: unknown): ToolListItem => {
    if (typeof value !== "object" || value === null)
      return { label: scalar(value) };
    const entry = record(value);
    if (Array.isArray(value)) return { label: "Group", detail: compact(value) };
    if (["image", "audio"].includes(String(entry["type"])))
      return {
        label: `${label(String(entry["type"]))} attachment`,
        detail: string(entry, "mimeType", "mime_type"),
      };
    const heading = string(
      entry,
      "title",
      "label",
      "name",
      "path",
      "file_path",
      "file",
      "content",
      "text",
      "description",
      "query",
      "q",
      "question",
      "subject",
      "summary",
      "branch",
      "command",
      "url",
      "id",
      "uri",
    );
    const parts = Object.entries(entry)
      .filter(
        ([key, value]) =>
          value !== undefined &&
          (typeof value === "object" || scalar(value) !== heading) &&
          !["type", "mimeType"].includes(key) &&
          !(key === "status" && status(value)),
      )
      .slice(0, 8)
      .map(([key, value]) => `${label(key)}: ${compact(value)}`);
    if (Object.keys(entry).length > 8) shortened = true;
    return {
      label: heading || label(string(entry, "type") || "Item"),
      detail: parts.join(" · "),
      status: status(entry["status"]),
    };
  };
  const showValue = (title: string, value: unknown, depth = 0): void => {
    if (remaining <= 0 || blocks.length >= blockLimit) {
      shortened = true;
      return;
    }
    if (typeof value === "string") {
      const decoded = decode(value);
      if (decoded !== value && depth < 3) showValue(title, decoded, depth + 1);
      else if (
        /^\s*[[{]/.test(value) &&
        (title === "Parameters" || result?.truncated)
      ) {
        text(
          title,
          "Structured details could not be parsed. Open raw details or the original transcript content to inspect them.",
        );
      } else text(title, value);
      return;
    }
    if (Array.isArray(value)) {
      rows(title, value, genericRow);
      return;
    }
    if (value === null || typeof value !== "object") {
      text(title, scalar(value));
      return;
    }
    if (depth > 3) {
      text(title, "Additional structured data is available in raw details.");
      shortened = true;
      return;
    }
    const data = record(value);
    // Errors must survive large content blocks and scalar metadata fields.
    const priority = (key: string): boolean =>
      ["error", "stderr", "message", "reason", "final"].includes(key);
    for (const [key, entry] of Object.entries(data).filter(([key]) =>
      priority(key),
    ))
      showValue(label(key), entry, depth + 1);
    // MCP commonly supplies the same result as both JSON text and structured data.
    // Prefer the structured copy while retaining prose and attachment descriptions.
    const structured = data["structuredContent"];
    const hasStructured =
      structured !== null &&
      typeof structured === "object" &&
      Object.keys(structured).length > 0;
    if (Array.isArray(data["content"])) {
      for (const part of data["content"].slice(0, MAX_ROWS)) {
        const content = record(part),
          type = content["type"];
        if (typeof part === "string") text(title, part);
        else if (type === "text" || typeof content["text"] === "string") {
          const parsed =
            typeof content["text"] === "string"
              ? decode(content["text"])
              : undefined;
          if (
            !(
              hasStructured &&
              parsed !== null &&
              typeof parsed === "object" &&
              containsData(structured, parsed)
            )
          )
            showValue(title, content["text"], depth + 1);
        } else if (type === "image" || type === "audio")
          fields(
            [
              { label: "Attachment", value: label(type) },
              {
                label: "Format",
                value: string(content, "mimeType", "mime_type"),
              },
            ],
            title,
          );
        else if (type === "resource")
          showValue(title, content["resource"], depth + 1);
        else showValue(title, content, depth + 1);
      }
      if (data["content"].length > MAX_ROWS) shortened = true;
    }
    const values: ToolField[] = [];
    const nested: [string, unknown][] = [];
    for (const [key, entry] of Object.entries(data)
      .filter(([key]) => !priority(key))
      .slice(0, MAX_ROWS)) {
      if (
        (key === "content" && Array.isArray(entry)) ||
        ["_meta", "annotations"].includes(key) ||
        (key === "data" && ["image", "audio"].includes(String(data["type"])))
      )
        continue;
      if (entry !== null && typeof entry === "object")
        nested.push([label(key), entry]);
      else if (
        typeof entry === "string" &&
        (entry.includes("\n") || entry.length > 300)
      )
        nested.push([label(key), entry]);
      else values.push({ label: label(key), value: scalar(entry) });
    }
    fields(values, title);
    for (const [key, entry] of nested) showValue(key, entry, depth + 1);
    if (Object.keys(data).length > MAX_ROWS) shortened = true;
  };

  let summary =
    string(
      input,
      "description",
      "title",
      "query",
      "pattern",
      "url",
      "file_path",
      "path",
    ) ||
    item.toolName ||
    "Tool";
  let meta = "";
  const path = string(input, "file_path", "path", "filePath", "notebook_path");
  const output = result ? decode(result.text) : undefined;
  const succeeded = result !== undefined && !result.error;
  let outputHandled = false;
  switch (item.toolKind) {
    case "bash": {
      const command =
        string(input, "command", "cmd", "input") ||
        (typeof decodedInput === "string" ? decodedInput : "");
      summary = command.split("\n")[0] || summary;
      text("Command", command, true);
      fields([
        {
          label: "Working directory",
          value:
            item.execution?.cwd ??
            result?.execution?.cwd ??
            string(input, "cwd", "workdir", "working_directory"),
        },
        field("Purpose", "description"),
      ]);
      const data = record(output);
      const exit =
        result?.execution?.exitCode ??
        data["exit_code"] ??
        data["exitCode"] ??
        result?.text.match(
          /(?:Process exited with code|Exit code:)\s*(-?\d+)/i,
        )?.[1];
      if (result?.execution?.interrupted) meta = "Interrupted";
      else if (typeof exit === "number" || typeof exit === "string")
        meta = `Exit ${exit}`;
      if (
        Object.hasOwn(data, "stdout") ||
        Object.hasOwn(data, "stderr") ||
        Object.hasOwn(data, "output")
      ) {
        beginOutput();
        const commandValue = (title: string, value: unknown): void => {
          if (typeof value === "string") text(title, value, true);
          else if (value !== undefined) showValue(title, value);
        };
        const siblings = Object.fromEntries(
          Object.entries(data).filter(
            ([key]) =>
              !["stdout", "stderr", "output", "exit_code", "exitCode"].includes(
                key,
              ),
          ),
        );
        if (result?.error) showValue("Error", siblings);
        if (result?.error) commandValue("Standard error", data["stderr"]);
        commandValue(
          "Output",
          data["stdout"] === ""
            ? data["output"]
            : (data["stdout"] ?? data["output"]),
        );
        if (
          data["stdout"] !== undefined &&
          data["stdout"] !== "" &&
          data["output"] !== undefined &&
          !sameData(data["stdout"], data["output"])
        )
          commandValue("Additional output", data["output"]);
        if (!result?.error) commandValue("Standard error", data["stderr"]);
        fields([{ label: "Exit code", value: scalar(exit) }]);
        if (!result?.error) showValue("Result", siblings);
        outputHandled = true;
      } else if (result) {
        beginOutput();
        const clean = result.text.replace(
          /^(?:Chunk ID:.*\n|Wall time:.*\n|Process exited with code.*\n|Final output:\n)+/g,
          "",
        );
        text(result?.error ? "Error output" : "Output", clean, true);
        outputHandled = true;
      }
      break;
    }
    case "read":
      summary = path || summary;
      fields([
        field("File", "file_path", "path", "filePath"),
        {
          label: "Start line",
          value: scalar(input["offset"] ?? input["start_line"]),
        },
        {
          label: "Line limit",
          value: scalar(input["limit"]),
        },
        { label: "End line", value: scalar(input["end_line"]) },
      ]);
      rows("Files", list(input["paths"] ?? input["files"]), (value) => ({
        label: scalar(value),
      }));
      if (result) {
        beginOutput();
        text(
          result.error ? "Read error" : "File content",
          result.text,
          !result.error,
        );
        outputHandled = true;
      }
      break;
    case "write":
      summary = path || summary;
      fields([field("File", "file_path", "path", "filePath")]);
      text(
        succeeded ? "File content" : "Proposed content",
        string(input, "content", "new_string", "text"),
        true,
      );
      break;
    case "edit": {
      summary = path || summary;
      fields([
        field("File", "file_path", "path", "filePath"),
        {
          label: "Replace all",
          value:
            typeof input["replace_all"] === "boolean"
              ? scalar(input["replace_all"])
              : "",
        },
      ]);
      const edits = Array.isArray(input["edits"]) ? input["edits"] : [input];
      if (edits.length > 8) shortened = true;
      for (const value of edits.slice(0, 8)) {
        const edit = record(value);
        const before = string(edit, "old_string", "oldString"),
          after = string(edit, "new_string", "newString");
        if (after.startsWith("*** Begin Patch"))
          text(succeeded ? "Patch" : "Proposed patch", after, false, true);
        else if (before || after)
          add({
            kind: "diff",
            title: succeeded ? "Replacement" : "Proposed replacement",
            before: take(before, 4000),
            after: take(after, 4000),
          });
      }
      break;
    }
    case "file_changes": {
      const changes = list(input["changes"]);
      summary = changes.length
        ? `${changes.length} ${changes.length === 1 ? "file" : "files"}`
        : path || "File changes";
      rows(succeeded ? "Changed files" : "Proposed files", changes, (value) => {
        const change = record(value);
        const kind = record(change["kind"]);
        const operation =
          string(change, "kind", "type", "status") ||
          string(kind, "type") ||
          "Modified";
        const destination =
          string(kind, "move_path", "movePath") ||
          string(change, "move_path", "movePath");
        return {
          label: string(change, "path", "file_path"),
          detail: `${label(operation)}${destination ? ` → ${destination}` : ""}`,
        };
      });
      if (changes.length > 8) shortened = true;
      for (const value of changes.slice(0, 8)) {
        const change = record(value);
        text(
          `${succeeded ? "" : "Proposed patch: "}${string(change, "path", "file_path") || "Patch"}`,
          string(change, "diff", "patch"),
          false,
          true,
        );
      }
      text(
        succeeded ? "Patch" : "Proposed patch",
        string(input, "patch", "input", "new_string"),
        false,
        true,
      );
      break;
    }
    case "notebook_edit":
      summary = path || "Notebook cell";
      fields([
        field("Notebook", "notebook_path", "file_path", "path"),
        field("Cell", "cell_id"),
        field("Cell type", "cell_type"),
        field("Operation", "edit_mode"),
      ]);
      text(
        succeeded ? "Cell content" : "Proposed cell content",
        string(input, "new_source", "source", "content"),
        true,
      );
      break;
    case "grep":
    case "glob": {
      summary =
        string(input, "pattern", "query", "path") || "Repository search";
      fields([
        field("Pattern", "pattern", "query"),
        field("Search in", "path", "directory", "root"),
        field("File filter", "glob", "include", "type"),
        field("Output mode", "output_mode"),
      ]);
      if (typeof output === "string") {
        beginOutput();
        const lines = output.trim().split("\n").filter(Boolean);
        if (item.toolKind === "glob" && lines.length && !result?.error) {
          rows("Paths", lines, (value) => ({ label: String(value) }));
          meta = `${lines.length}${result?.truncated ? "+" : ""} paths`;
        } else text(result?.error ? "Search error" : "Matches", output, true);
        outputHandled = true;
      }
      break;
    }
    case "web_search":
    case "web_fetch": {
      const queries = list(input["queries"]);
      const action = record(input["action"]);
      summary =
        string(input, "query", "url", "search_term") ||
        string(action, "url", "pattern") ||
        string(record(queries[0]), "q", "query") ||
        "Web search";
      fields([
        field("Query", "query", "search_term"),
        field("URL", "url"),
        field("Instructions", "prompt"),
      ]);
      fields([
        { label: "Action", value: label(string(action, "type")) },
        { label: "Page", value: string(action, "url") },
        { label: "Find", value: string(action, "pattern") },
      ]);
      rows("Queries", queries, (value) => ({
        label:
          typeof value === "string"
            ? value
            : string(record(value), "q", "query"),
      }));
      const sources = Array.isArray(output)
        ? output
        : list(record(output)["results"] ?? record(output)["sources"]);
      if (sources.length) {
        beginOutput();
        const siblings = Object.fromEntries(
          Object.entries(record(output)).filter(
            ([key]) => !["results", "sources"].includes(key),
          ),
        );
        if (result?.error && !Array.isArray(output))
          showValue("Error", siblings);
        rows("Sources", sources, genericRow);
        if (!result?.error && !Array.isArray(output))
          showValue("Result", siblings);
        outputHandled = true;
      } else if (result && !result.text.trim()) {
        beginOutput();
        text("Result", "No result details supplied.");
        outputHandled = true;
      }
      break;
    }
    case "todo_write": {
      const todos = list(input["todos"] ?? input["items"] ?? input["plan"]);
      const done = todos.filter(
        (value) =>
          status(record(value)["status"]) === "done" ||
          record(value)["completed"] === true,
      ).length;
      summary = todos.length
        ? `${done} of ${todos.length} complete`
        : "Update plan";
      rows("Plan", todos, (value) => {
        const todo = record(value);
        return {
          label: string(todo, "content", "text", "step", "title"),
          status:
            todo["completed"] === true
              ? "done"
              : (status(todo["status"]) ?? "pending"),
        };
      });
      break;
    }
    case "task_agent":
    case "agent_collaboration": {
      summary =
        string(input, "description", "task_name", "target", "agent_id") ||
        item.toolName ||
        "Agent";
      fields([
        field("Agent", "subagent_type", "agent_type", "name"),
        field("Target", "target", "agent_id", "id"),
        field("Model", "model"),
        field("Task", "task_name"),
      ]);
      const ids = list(input["receiverThreadIds"] ?? input["ids"]);
      rows("Agents", ids, (value) => ({ label: scalar(value) }));
      text("Instructions", string(input, "prompt", "message", "task"));
      const states = record(record(output)["agentsStates"]);
      if (Object.keys(states).length) {
        beginOutput();
        const siblings = Object.fromEntries(
          Object.entries(record(output)).filter(
            ([key]) => !["agentsStates", "agent_id"].includes(key),
          ),
        );
        if (result?.error) showValue("Error", siblings);
        rows("Agent status", Object.entries(states), (value) => {
          const pair = list(value),
            id = scalar(pair[0]),
            state = pair[1],
            info = record(state);
          return {
            label: id,
            detail:
              typeof state === "string"
                ? state
                : string(info, "message", "status", "state"),
            status: status(typeof state === "string" ? state : info["status"]),
          };
        });
        fields([
          { label: "Agent ID", value: string(record(output), "agent_id") },
        ]);
        if (!result?.error) showValue("Result", siblings);
        outputHandled = true;
      }
      break;
    }
    case "ask_user_question":
      summary =
        string(
          record(list(input["questions"])[0]),
          "question",
          "header",
          "title",
        ) || "Question";
      rows("Questions", list(input["questions"]), (value) => {
        const question = record(value);
        return {
          label: string(question, "question", "title", "header"),
          detail: list(question["options"])
            .map((option) =>
              typeof option === "string"
                ? option
                : string(record(option), "label"),
            )
            .join(" · "),
        };
      });
      break;
    case "enter_plan_mode":
    case "exit_plan_mode":
      summary =
        item.toolKind === "enter_plan_mode" ? "Enter plan mode" : "Review plan";
      text("Plan", string(input, "plan", "text", "content"));
      fields([
        field("Plan file", "planFilePath", "plan_file_path", "file_path"),
      ]);
      break;
    case "worktree":
      summary =
        string(input, "name", "branch", "path") || item.toolName || "Workspace";
      fields([
        field("Workspace", "name"),
        field("Branch", "branch"),
        field("Path", "path"),
        field("Action", "action"),
      ]);
      break;
    case "lsp":
      summary = string(input, "operation", "method") || "Code intelligence";
      fields([
        field("Operation", "operation", "method"),
        field("File", "filePath", "file_path", "path"),
        { label: "Line", value: scalar(input["line"]) },
        {
          label: "Column",
          value: scalar(input["character"] ?? input["column"]),
        },
      ]);
      break;
    case "skill":
      summary = string(input, "skill", "name") || "Skill";
      fields([field("Skill", "skill", "name")]);
      if (input["args"] !== undefined) showValue("Arguments", input["args"]);
      break;
    case "mcp": {
      const tool = string(input, "tool"),
        server = string(input, "server");
      summary = tool
        ? label(tool.replace(/^mcp__[^_]+__/, "").replace(/\./g, " "))
        : item.toolName || "Connected tool";
      meta = server;
      fields([
        { label: "Connection", value: server },
        { label: "Tool", value: tool },
      ]);
      const args =
        input["arguments"] ??
        Object.fromEntries(
          Object.entries(input).filter(
            ([key]) => !["tool", "server"].includes(key),
          ),
        );
      showValue("Parameters", args);
      break;
    }
    default:
      showValue("Parameters", decodedInput);
  }
  beginOutput();
  if (result && !outputHandled)
    showValue(result.error ? "Error" : "Result", output);
  return {
    summary: summary.slice(0, 500),
    ...(meta ? { meta: meta.slice(0, 100) } : {}),
    blocks,
    ...focusSessionTool(item, result, blocks, resultStart ?? blocks.length),
    ...(shortened
      ? {
          notice:
            "Preview shortened. Open the original transcript content for the full details.",
        }
      : {}),
  };
}
