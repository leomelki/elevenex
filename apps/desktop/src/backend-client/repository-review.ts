import type {
  RepositoryReviewQuery,
  RepositoryReviewPage,
  RepositoryReviewFile,
  RepositoryReviewContent,
  RepositoryReviewHunk,
  RepositoryReviewLine,
} from "@elevenex/shared";
import { handleForWindow, type TrustedSender } from "../ipc";
import type { BackendClient } from "./client";
import {
  requestBackendJson,
  invalidResponse,
  BackendRequestError,
} from "./transport";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidResponse();
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 2000): string => {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw invalidResponse();
  return value;
};
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw invalidResponse();
  return value;
};
const bool = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw invalidResponse();
  return value;
};
const digest = (value: unknown): string => {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw invalidResponse();
  return result;
};
const sha = (value: unknown): string | null => {
  if (value === null) return null;
  const result = text(value, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) throw invalidResponse();
  return result;
};
const next = (value: unknown): number | null =>
  value === null ? null : count(value, 2000000);
const source = (value: unknown): RepositoryReviewQuery["source"] => {
  if (value !== "uncommitted" && value !== "last-commit" && value !== "branch")
    throw invalidResponse();
  return value;
};
const mode = (value: unknown): "changes" | "full" => {
  if (value !== "changes" && value !== "full") throw invalidResponse();
  return value;
};
const taskId = (value: unknown) => {
  const id = count(value);
  if (!id) throw invalidResponse();
  return id;
};
const requestId = (value: unknown) => {
  const id = text(value, 100);
  if (!/^[a-z0-9-]{1,100}$/i.test(id)) throw invalidResponse();
  return id;
};
const scopeId = (value: unknown) => {
  const id = text(value, 36);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw invalidResponse();
  return id;
};

export function parseReviewQuery(value: unknown): RepositoryReviewQuery {
  const raw = object(value);
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          "taskId",
          "requestId",
          "source",
          "baseRef",
          "revision",
          "query",
          "offset",
          "fileId",
          "fileRev",
          "mode",
          "lineOffset",
          "context",
          "expansions",
          "force",
        ].includes(key),
    )
  )
    throw invalidResponse();
  if (raw["fileId"] !== undefined && (!raw["revision"] || !raw["fileRev"]))
    throw invalidResponse();
  const baseRef =
    raw["baseRef"] === undefined ? undefined : text(raw["baseRef"], 240);
  if (
    baseRef !== undefined &&
    (!baseRef || baseRef.startsWith("-") || /[~^:?*[\\\s]/.test(baseRef))
  )
    throw invalidResponse();
  const expansions = raw["expansions"];
  if (
    expansions !== undefined &&
    (!Array.isArray(expansions) || expansions.length > 32)
  )
    throw invalidResponse();
  const parsedExpansions = Array.isArray(expansions)
    ? expansions.map((value) => {
        const item = object(value);
        return {
          hunkId: text(item["hunkId"], 100),
          before: count(item["before"], 200),
          after: count(item["after"], 200),
        };
      })
    : undefined;
  return {
    taskId: taskId(raw["taskId"]),
    requestId: requestId(raw["requestId"]),
    source: source(raw["source"]),
    ...(baseRef === undefined ? {} : { baseRef }),
    ...(raw["revision"] === undefined
      ? {}
      : { revision: digest(raw["revision"]) }),
    ...(raw["query"] === undefined ? {} : { query: text(raw["query"], 1000) }),
    ...(raw["offset"] === undefined
      ? {}
      : { offset: count(raw["offset"], 1000000) }),
    ...(raw["fileId"] === undefined
      ? {}
      : { fileId: text(raw["fileId"], 4200) }),
    ...(raw["fileRev"] === undefined
      ? {}
      : { fileRev: digest(raw["fileRev"]) }),
    ...(raw["mode"] === undefined ? {} : { mode: mode(raw["mode"]) }),
    ...(raw["lineOffset"] === undefined
      ? {}
      : { lineOffset: count(raw["lineOffset"], 2000000) }),
    ...(parsedExpansions === undefined ? {} : { expansions: parsedExpansions }),
    ...(raw["context"] === undefined
      ? {}
      : { context: count(raw["context"], 200) }),
    ...(raw["force"] === undefined ? {} : { force: bool(raw["force"]) }),
  };
}
function repositoryPath(value: unknown): string {
  const path = text(value, 4096);
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.split(/[\\/]/).includes("..")
  )
    throw invalidResponse();
  return path;
}
function file(value: unknown): RepositoryReviewFile {
  const raw = object(value),
    status = raw["status"],
    layer = raw["layer"];
  if (status !== "A" && status !== "M" && status !== "D" && status !== "R")
    throw invalidResponse();
  if (
    layer !== "staged" &&
    layer !== "unstaged" &&
    layer !== "untracked" &&
    layer !== "committed"
  )
    throw invalidResponse();
  const path = repositoryPath(raw["path"]);
  const id = text(raw["id"], 4200);
  if (id !== `${layer}:${path}`) throw invalidResponse();
  const oldMode = text(raw["oldMode"], 6),
    newMode = text(raw["newMode"], 6);
  if (!/^[0-7]{6}$/.test(oldMode) || !/^[0-7]{6}$/.test(newMode))
    throw invalidResponse();
  return {
    id,
    path,
    rev: digest(raw["rev"]),
    status,
    layer,
    add: count(raw["add"]),
    del: count(raw["del"]),
    binary: bool(raw["binary"]),
    large: bool(raw["large"]),
    countsExact: bool(raw["countsExact"]),
    oldRevision: sha(raw["oldRevision"]),
    newRevision:
      raw["newRevision"] === null ? null : text(raw["newRevision"], 256),
    oldMode,
    newMode,
    ...(raw["oldPath"] === undefined
      ? {}
      : { oldPath: repositoryPath(raw["oldPath"]) }),
  };
}
function line(value: unknown): RepositoryReviewLine {
  const raw = object(value),
    kind = raw["kind"];
  if (kind !== "add" && kind !== "del" && kind !== "context")
    throw invalidResponse();
  const content = text(raw["text"], 32768);
  let spans: RepositoryReviewLine["spans"];
  if (raw["spans"] !== undefined) {
    if (!Array.isArray(raw["spans"]) || raw["spans"].length > 256)
      throw invalidResponse();
    spans = raw["spans"].map((value) => {
      const span = object(value),
        token = span["token"];
      if (
        token !== undefined &&
        token !== "keyword" &&
        token !== "string" &&
        token !== "number" &&
        token !== "function" &&
        token !== "comment"
      )
        throw invalidResponse();
      return {
        text: text(span["text"], 32768),
        ...(token === undefined ? {} : { token }),
      };
    });
    if (spans?.map((span) => span.text).join("") !== content)
      throw invalidResponse();
  }
  const oldNumber =
      raw["oldNumber"] === undefined ? undefined : count(raw["oldNumber"]),
    newNumber =
      raw["newNumber"] === undefined ? undefined : count(raw["newNumber"]);
  if (
    (kind !== "add" && !oldNumber) ||
    (kind !== "del" && !newNumber) ||
    (kind === "add" && oldNumber !== undefined) ||
    (kind === "del" && newNumber !== undefined)
  )
    throw invalidResponse();
  return {
    id: text(raw["id"]),
    kind,
    text: content,
    ...(oldNumber === undefined ? {} : { oldNumber }),
    ...(newNumber === undefined ? {} : { newNumber }),
    ...(spans ? { spans } : {}),
  };
}
export function parseReviewPage(
  value: unknown,
  input: RepositoryReviewQuery,
): RepositoryReviewPage {
  const raw = object(value);
  if (
    raw["taskId"] !== input.taskId ||
    raw["source"] !== input.source ||
    (input.revision && raw["revision"] !== input.revision)
  )
    throw invalidResponse();
  const total = count(raw["total"]),
    matched = count(raw["matched"]),
    offset = count(raw["offset"]),
    nextOffset = next(raw["nextOffset"]);
  if (!Array.isArray(raw["files"]) || raw["files"].length > 100)
    throw invalidResponse();
  const files = raw["files"].map(file);
  if (
    matched > total ||
    offset + files.length > matched ||
    new Set(files.map((file) => file.id)).size !== files.length ||
    (nextOffset !== null &&
      (nextOffset !== offset + files.length || nextOffset >= matched))
  )
    throw invalidResponse();
  if (
    files.some((file) =>
      input.source === "uncommitted"
        ? file.layer === "committed"
        : file.layer !== "committed",
    )
  )
    throw invalidResponse();
  let content: RepositoryReviewContent | null = null;
  if (raw["content"] !== null) {
    const data = object(raw["content"]);
    if (
      !input.fileId ||
      data["fileId"] !== input.fileId ||
      data["rev"] !== input.fileRev ||
      data["mode"] !== (input.mode ?? "changes") ||
      data["offset"] !== (input.lineOffset ?? 0)
    )
      throw invalidResponse();
    if (!Array.isArray(data["hunks"]) || data["hunks"].length > 400)
      throw invalidResponse();
    let lineCount = 0;
    const hunks = data["hunks"].map((value): RepositoryReviewHunk => {
      const hunk = object(value);
      if (
        !Array.isArray(hunk["lines"]) ||
        (lineCount += hunk["lines"].length) > 400
      )
        throw invalidResponse();
      return {
        id: text(hunk["id"]),
        heading: text(hunk["heading"], 1000),
        lines: hunk["lines"].map(line),
        ...(hunk["before"] === undefined
          ? {}
          : { before: count(hunk["before"]) }),
        ...(hunk["after"] === undefined ? {} : { after: count(hunk["after"]) }),
      };
    });
    const contentOffset = count(data["offset"]),
      contentNext = next(data["nextOffset"]);
    if (contentNext !== null && contentNext !== contentOffset + lineCount)
      throw invalidResponse();
    content = {
      fileId: input.fileId,
      rev: input.fileRev!,
      mode: mode(data["mode"]),
      offset: contentOffset,
      nextOffset: contentNext,
      hunks,
      ...(data["notice"] === undefined ? {} : { notice: text(data["notice"]) }),
    };
  } else if (input.fileId) throw invalidResponse();
  const baseRef = raw["baseRef"] === null ? null : text(raw["baseRef"], 240);
  if (input.baseRef && baseRef !== input.baseRef) throw invalidResponse();
  return {
    taskId: input.taskId,
    source: input.source,
    revision: digest(raw["revision"]),
    headSha: sha(raw["headSha"]),
    baseSha: sha(raw["baseSha"]),
    targetSha: sha(raw["targetSha"]),
    baseRef,
    fingerprint:
      raw["fingerprint"] === null ? null : digest(raw["fingerprint"]),
    explanation: text(raw["explanation"]),
    total,
    matched,
    additions: count(raw["additions"]),
    deletions: count(raw["deletions"]),
    countsExact: bool(raw["countsExact"]),
    offset,
    nextOffset,
    files,
    content,
  };
}
const REVIEW_CONFLICTS = {
  "review-conflicts":
    "The index contains merge conflicts. Resolve them or choose Last commit or Branch changes to review committed content.",
  "review-busy": "Too many repository reads are pending. Try again shortly.",
  "review-expired": "This review expired. Refresh to read a coherent revision.",
  "review-file-changed":
    "This file changed. Update the review before loading its new content.",
  "review-base-missing":
    "The target branch was deleted or cannot be resolved. Choose another base.",
  "review-base-unrelated":
    "The target and task have no common ancestor. Choose another base.",
  "review-base-ambiguous":
    "This history has multiple merge-bases. Choose a more specific base commit.",
  "review-no-base":
    "Choose a base branch. No task or repository default is available.",
  "review-moving":
    "Working changes moved while the review was being read. Try refreshing.",
  "review-limit":
    "This file exceeds the bounded text preview limit. Review it with your code tools.",
  "review-path": "This file cannot be read within the task workspace.",
  "review-task":
    "The task workspace is unavailable. Reopen the task to review repository changes.",
} as const;

export function registerRepositoryReviewIpc(
  client: BackendClient,
  trusted: TrustedSender,
): () => void {
  const read = handleForWindow(
    "repository-review:read",
    trusted,
    (window, ...args) => {
      if (args.length !== 2) throw invalidResponse();
      const scope = scopeId(args[0]),
        input = parseReviewQuery(args[1]);
      return client.execute(
        window,
        scope,
        `repository-review:${input.requestId}:${JSON.stringify(input)}`,
        false,
        async (endpoint, signal) => {
          try {
            return parseReviewPage(
              await requestBackendJson(
                endpoint,
                {
                  path: `/api/desktop-workspace/tasks/${input.taskId}/review`,
                  method: "POST",
                  body: input,
                  limit: 4 * 1024 * 1024,
                  conflictMessages: REVIEW_CONFLICTS,
                },
                signal,
              ),
              input,
            );
          } catch (error) {
            if (
              error instanceof BackendRequestError &&
              error.detail.status === 404
            )
              throw new BackendRequestError({
                code: "unavailable",
                message:
                  "Repository review or the selected task is unavailable. Refresh tasks, or update the engine if it does not support repository review.",
              });
            throw error;
          }
        },
        45000,
      );
    },
  );
  const branches = handleForWindow(
    "repository-review:branches",
    trusted,
    (window, ...args) => {
      if (args.length !== 2) throw invalidResponse();
      const scope = scopeId(args[0]),
        raw = object(args[1]),
        task = taskId(raw["taskId"]),
        query = text(raw["query"], 240),
        id = requestId(raw["requestId"]);
      return client.execute(
        window,
        scope,
        `repository-review:${id}:branches:${task}:${query}`,
        false,
        async (endpoint, signal) => {
          const result = object(
            await requestBackendJson(
              endpoint,
              {
                path: `/api/desktop-workspace/tasks/${task}/review/branches?${new URLSearchParams({ query })}`,
                limit: 32000,
              },
              signal,
            ),
          );
          if (
            result["taskId"] !== task ||
            !Array.isArray(result["refs"]) ||
            result["refs"].length > 50
          )
            throw invalidResponse();
          return {
            taskId: task,
            refs: result["refs"].map((value) => {
              const ref = text(value, 240);
              if (
                !ref.startsWith("refs/heads/") &&
                !ref.startsWith("refs/remotes/")
              )
                throw invalidResponse();
              return ref;
            }),
            hasMore: bool(result["hasMore"]),
          };
        },
        20000,
      );
    },
  );
  const cancel = handleForWindow(
    "repository-review:cancel",
    trusted,
    (window, ...args) => {
      if (args.length !== 2) throw invalidResponse();
      client.cancel(
        window,
        scopeId(args[0]),
        "repository-review:" + requestId(args[1]),
      );
    },
  );
  return () => {
    read();
    branches();
    cancel();
  };
}
