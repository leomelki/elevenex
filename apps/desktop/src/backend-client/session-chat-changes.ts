import type {
  SessionChatChangesPage,
  SessionChatChangeSource,
  SessionChatChangeSummary,
  SessionChatChangedFile,
} from "@elevenex/shared";
import { chatObject, chatText, invalid } from "./session-chat-values";

const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw invalid();
  return value;
};
const next = (value: unknown) => (value === null ? null : count(value));
export function parseChangeSummary(
  value: unknown,
  max = 200,
): SessionChatChangeSummary {
  const raw = chatObject(value);
  if (!Array.isArray(raw["files"]) || raw["files"].length > max)
    throw invalid();
  const files = raw["files"].map((value): SessionChatChangedFile => {
    const file = chatObject(value),
      status = file["status"];
    if (status !== "A" && status !== "M" && status !== "D")
      throw invalid();
    return {
      path: chatText(file["path"]),
      status,
      add: count(file["add"]),
      del: count(file["del"]),
    };
  });
  if (
    files.some((file) => !file.path) ||
    new Set(files.map((file) => file.path)).size !== files.length
  )
    throw invalid();
  const total = count(raw["total"]);
  if (total < files.length) throw invalid();
  if (raw["shared"] !== undefined && raw["shared"] !== true) throw invalid();
  const totals = raw["lineTotals"] === undefined ? undefined : chatObject(raw["lineTotals"]);
  const lineTotals = totals ? { add: count(totals["add"]), del: count(totals["del"]) } : undefined;
  if (lineTotals) {
    const add = files.reduce((sum, file) => sum + file.add, 0);
    const del = files.reduce((sum, file) => sum + file.del, 0);
    if (add > lineTotals.add || del > lineTotals.del ||
        (files.length === total && (add !== lineTotals.add || del !== lineTotals.del))) throw invalid();
  }
  const sources = raw["sources"];
  if (sources !== undefined && (!Array.isArray(sources) || sources.length > 2 ||
      new Set(sources).size !== sources.length || sources.some(source => source !== "provider" && source !== "command")))
    throw invalid();
  const notice = raw["notice"] === undefined ? undefined : chatText(raw["notice"], 4000);
  return { files, total, ...(sources ? { sources } : {}), ...(notice ? { notice } : {}), ...(lineTotals ? { lineTotals } : {}), ...(raw["shared"] ? { shared: true } : {}) };
}
export function parseChangesPage(
  value: unknown,
  turnId: string,
  path?: string,
  source: SessionChatChangeSource = "net",
): SessionChatChangesPage {
  const raw = chatObject(value),
    summary = parseChangeSummary(raw, 100);
  if (raw["turnId"] !== turnId || (raw["source"] ?? "net") !== source) throw invalid();
  const revision = chatText(raw["revision"], 64);
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw invalid();
  const offset = count(raw["offset"]),
    nextOffset = next(raw["nextOffset"]);
  if (
    nextOffset !== null &&
    (nextOffset <= offset || nextOffset >= summary.total)
  )
    throw invalid();
  if (offset + summary.files.length > summary.total || (path !== undefined && !summary.files.some(file => file.path === path))) throw invalid();
  let content: SessionChatChangesPage["content"] = null;
  if (raw["content"] !== null) {
    const data = chatObject(raw["content"]);
    if (
      data["path"] !== path ||
      !Array.isArray(data["lines"]) ||
      data["lines"].length > 400
    )
      throw invalid();
    content = {
      path: chatText(data["path"]),
      nextOffset: next(data["nextOffset"]),
      ...(data["error"] !== undefined
        ? { error: chatText(data["error"], 4000) }
        : {}),
      lines: data["lines"].map((value) => {
        const line = chatObject(value),
          kind = line["kind"];
        if (kind !== "add" && kind !== "del" && kind !== "context")
          throw invalid();
        return {
          id: chatText(line["id"]),
          kind,
          text: chatText(line["text"], 4000),
          ...(line["evidence"] !== undefined ? { evidence: chatText(line["evidence"], 300) } : {}),
          ...(line["oldNumber"] !== undefined
            ? { oldNumber: count(line["oldNumber"]) }
            : {}),
          ...(line["newNumber"] !== undefined
            ? { newNumber: count(line["newNumber"]) }
            : {}),
        };
      }),
    };
  } else if (path !== undefined) throw invalid();
  return { turnId, revision, offset, nextOffset, ...summary, ...(source !== "net" ? { source } : {}), content };
}
