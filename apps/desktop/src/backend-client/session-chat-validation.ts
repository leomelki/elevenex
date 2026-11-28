import { parseChangeSummary } from "./session-chat-changes";
import { parseAgentContext, parseAgentEntry, parseAgentSender, parseDelegatedWork } from './session-agent-values';
import {
  SESSION_CHAT_FULL_TIMELINE_SLOTS,
  SESSION_CHAT_PROMPT_LIMIT,
  SESSION_CHAT_TOOL_CATEGORIES,
  SESSION_CHAT_TURN_FILES_LIMIT,
  SESSION_CHAT_TURN_REPLY_LIMIT,
  SESSION_CHAT_TURN_TIMELINE_SLOTS,
  SESSION_CHAT_TOOL_LABEL_LIMIT,
  SESSION_CHAT_TOOL_META_LIMIT,
  SESSION_CHAT_TURN_TOOL_LABEL_LIMIT,
  SESSION_CHAT_TURN_TOOL_META_LIMIT,
  SESSION_CHAT_TURN_WORK_LIMIT,
  SESSION_CHAT_TURN_WORK_MAX_LIMIT,
} from "@elevenex/shared";
import type {
  SessionChatAgentPage,
  SessionChatModelQuota,
  SessionChatAgentContext,
  SessionChatWorkStatus,
  SessionChatAction,
  SessionChatEvent,
  SessionChatItem,
  SessionChatRecord,
  SessionChatCompletedTurn,
  SessionChatTurnTimelineRow,
  SessionChatTurnWorkReply,
  SessionChatTurnWorkRead,
  SessionChatToolDetailsReply,
  SessionChatToolDetailsRead,
  SessionChatToolEvidence,
  SessionChatToolHeading,
  SessionChatToolReference,
  SessionChatPage,
  SessionChatState,
  SessionChatPlanUsage,
  SessionChatPresetDefault,
  SessionChatCatalog,
  SessionChatBackgroundWork,
  SessionChatWork,
  SessionChatWorkEvent,
} from "@elevenex/shared";
import { chatObject, chatText, invalid } from "./session-chat-values";
export { chatObject, chatText } from "./session-chat-values";
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid();
  return value;
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  )
    throw invalid();
  return value;
}
function nullable(value: unknown, max = 1000): string | null {
  return value === null ? null : chatText(value, max);
}
function completionAt(value: unknown): string {
  const at = chatText(value, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at))) throw invalid();
  return at;
}
function array<T>(
  value: unknown,
  max: number,
  parse: (value: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value.map(parse);
}
export function chatId(value: unknown): number {
  const id = number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw invalid();
  return id;
}
export function requestId(value: unknown): string {
  const id = chatText(value, 100);
  if (!/^[\w-]{1,100}$/.test(id)) throw invalid();
  return id;
}
function presetId(value: unknown): string {
  const id = chatText(value, 64);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw invalid();
  return id;
}
export function defaultRevision(value: unknown): string {
  const revision = chatText(value, 64);
  if (!/^[a-f0-9]{64}$/.test(revision)) throw invalid();
  return revision;
}
export function parsePresetDefault(value: unknown): SessionChatPresetDefault {
  const raw = chatObject(value);
  const defaultIds = array(raw["defaultIds"], 24, presetId);
  if (new Set(defaultIds).size !== defaultIds.length) throw invalid();
  const id = raw["id"] === null ? null : presetId(raw["id"]);
  if (id !== null && !defaultIds.includes(id)) throw invalid();
  return {
    id,
    provider: presetId(raw["provider"]),
    defaultIds,
    revision: defaultRevision(raw["revision"]),
  };
}
export function parseChatCatalog(
  value: unknown,
  provider: string,
): SessionChatCatalog {
  const raw = chatObject(value);
  if (raw["provider"] !== provider) throw invalid();
  const models = array(raw["models"], 100, (value) => {
    const model = chatObject(value);
    return {
      id: chatText(model["id"], 200),
      label: chatText(model["label"], 200),
      reasoningEfforts: array(model["reasoningEfforts"], 20, (v) =>
        chatText(v, 100),
      ),
      supportsFastMode: bool(model["supportsFastMode"]),
    };
  });
  if (new Set(models.map((m) => m.id)).size !== models.length) throw invalid();
  const selected = nullable(raw["model"], 200);
  const reasoning = nullable(raw["reasoning"], 100);
  const model = models.find((m) => m.id === selected);
  const fast = bool(raw["fast"]);
  if (
    (selected !== null && !model) ||
    (reasoning !== null && !model?.reasoningEfforts.includes(reasoning)) ||
    (fast && !model?.supportsFastMode)
  )
    throw invalid();
  return {
    provider,
    label: chatText(raw["label"], 200),
    models,
    model: selected,
    reasoning,
    fast,
    reasoningAvailable: bool(raw["reasoningAvailable"]),
    fastAvailable: bool(raw["fastAvailable"]),
    error: nullable(raw["error"], 1000),
  };
}
function execution(value: unknown): NonNullable<SessionChatItem["execution"]> {
  const raw = chatObject(value);
  const exitCode = raw["exitCode"];
  if (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))) throw invalid();
  return {
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(raw["cwd"] !== undefined ? { cwd: chatText(raw["cwd"], 4000) } : {}),
    ...(raw["interrupted"] !== undefined ? { interrupted: bool(raw["interrupted"]) } : {}),
  };
}
function item(value: unknown): SessionChatRecord {
  const raw = chatObject(value),
    kind = raw["kind"];
  if (
    kind !== "user" &&
    kind !== "assistant" &&
    kind !== "thinking" &&
    kind !== "tool_use" &&
    kind !== "tool_result" &&
    kind !== "system" &&
    kind !== "error"
  )
    throw invalid();
  const assistantPhase = raw['assistantPhase'];
  if (assistantPhase !== undefined && (kind !== 'assistant' ||
    (assistantPhase !== 'commentary' && assistantPhase !== 'final'))) throw invalid();
  const mentions = raw['mentions'] === undefined ? undefined : sessionMentions(raw['mentions']);
  if (mentions && kind !== 'user') throw invalid();
  const editable = raw['editable'];
  if (editable !== undefined && (editable !== true || kind !== 'user')) throw invalid();
  const id = chatText(raw["id"]);
  const sender = raw['sender'] === undefined ? undefined : parseAgentSender(raw['sender']);
  const agent = raw['agent'] === undefined ? undefined : parseAgentEntry(raw['agent'], kind === 'tool_result', kind === 'tool_use' ? id : undefined);
  if ((sender && (kind !== 'user' || editable)) ||
      (agent && kind !== 'tool_use' && kind !== 'tool_result' &&
        !(kind === 'system' && agent.id === id && agent.operation.type === 'native-wait'))) throw invalid();
  return {
    id,
    kind,
    ...(editable === true ? { editable } : {}),
    ...(assistantPhase === undefined ? {} : { assistantPhase }),
    text: chatText(raw["text"], 64000),
    timestamp: chatText(raw["timestamp"]),
    toolId: nullable(raw["toolId"]),
    toolName: nullable(raw["toolName"]),
    toolKind: nullable(raw["toolKind"]),
    input: chatText(raw["input"], 16100),
    error: bool(raw["error"]),
    truncated: bool(raw["truncated"]),
    ...(mentions === undefined ? {} : { mentions }),
    ...(sender ? { sender } : {}),
    ...(agent ? { agent } : {}),
    ...(raw["media"] !== undefined ? { media: mediaReferences(raw["media"]) } : {}),
    ...(raw["execution"] !== undefined ? { execution: execution(raw["execution"]) } : {}),
    ...(raw["changes"] !== undefined ? { changes: parseChangeSummary(raw["changes"]) } : {}),
  };
}
function sessionMentions(value: unknown) {
  const mentions = array(value, 8, value => {
    const mention = chatObject(value), sessionId = mention['sessionId'];
    const title = chatText(mention['title'], 1000);
    if (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId <= 0 || !title.trim()) throw invalid();
    return { sessionId, title };
  });
  if (new Set(mentions.map(mention => mention.sessionId)).size !== mentions.length) throw invalid();
  return mentions;
}
function mediaReferences(value: unknown) {
  return array(value, 12, value => {
    const media = chatObject(value);
    const id = chatText(media["id"], 2);
    if (!/^\d{1,2}$/.test(id)) throw invalid();
    return { id, path: chatText(media["path"], 4000), caption: chatText(media["caption"], 200), inline: bool(media["inline"]), ...(media["kind"] === undefined ? {} : { kind: mediaKind(media["kind"]) }) };
  });
}
function contentRevision(value: unknown): string {
  const revision = chatText(value, 64);
  if (!/^[a-f0-9]{64}$/.test(revision)) throw invalid();
  return revision;
}
export function deferredToolDetails(value: unknown): true | undefined {
  if (value !== undefined && value !== true) throw invalid();
  return value;
}

function toolHeading(value: unknown): SessionChatToolHeading {
  const raw = chatObject(value);
  return {
    revision: contentRevision(raw['revision']),
    ...(raw['summary'] === undefined ? {} : { summary: chatText(raw['summary'], SESSION_CHAT_TOOL_LABEL_LIMIT) }),
    ...(raw['meta'] === undefined ? {} : { meta: chatText(raw['meta'], SESSION_CHAT_TOOL_META_LIMIT) }),
  };
}

function activityItem(value: unknown, detailsAllowed: boolean, inlineReceipt = false): SessionChatRecord {
  const raw = chatObject(value), row = item(raw);
  const details = raw['toolDetails'] === undefined ? undefined : toolHeading(raw['toolDetails']);
  if (details && (!detailsAllowed || !row.id || (row.kind !== 'tool_use' && row.kind !== 'tool_result') ||
    row.input || row.text || row.execution !== undefined || (row.kind === 'tool_use' && !details.summary))) throw invalid();
  const peerId = (value: unknown): string => {
    const id = chatText(value);
    if (!id || id === row.id) throw invalid();
    return id;
  };
  let receipt: SessionChatRecord['receipt'];
  if (raw['receipt'] !== undefined) {
    const peer = chatObject(raw['receipt']);
    if (row.kind !== 'tool_use' || (!details && !inlineReceipt)) throw invalid();
    const toolDetails = peer['toolDetails'] === undefined ? undefined : toolHeading(peer['toolDetails']);
    if (toolDetails && !details) throw invalid();
    receipt = { id: peerId(peer['id']), error: bool(peer['error']), ...(toolDetails ? { toolDetails } : {}) };
  }
  let invocation: SessionChatRecord['invocation'];
  if (raw['invocation'] !== undefined) {
    const peer = chatObject(raw['invocation']);
    const toolDetails = toolHeading(peer['toolDetails']);
    if (row.kind !== 'tool_result' || !details || !row.toolId || !toolDetails.summary) throw invalid();
    invocation = { id: peerId(peer['id']), toolKind: nullable(peer['toolKind']), toolDetails };
  }
  return { ...row, ...(details ? { toolDetails: details } : {}),
    ...(receipt ? { receipt } : {}), ...(invocation ? { invocation } : {}) };
}

function toolReference(value: unknown): SessionChatToolReference {
  const raw = chatObject(value), id = chatText(raw['id']);
  if (!id) throw invalid();
  return { id, revision: contentRevision(raw['revision']) };
}

export function parseToolDetailsRead(value: unknown): SessionChatToolDetailsRead {
  const raw = chatObject(value);
  const item = toolReference(raw['item']);
  const result = raw['result'] === undefined ? undefined : toolReference(raw['result']);
  const turnId = raw['turnId'] === undefined ? undefined : chatText(raw['turnId']);
  if (item.id === result?.id || (turnId !== undefined && (!turnId || turnId === item.id || turnId === result?.id ||
    (result && result.revision !== item.revision)))) throw invalid();
  return {
    taskId: chatId(raw['taskId']), sessionId: chatId(raw['sessionId']),
    requestId: requestId(raw['requestId']), item, ...(result ? { result } : {}), ...(turnId ? { turnId } : {}),
  };
}

export function parseToolDetailsReply(value: unknown, input: SessionChatToolDetailsRead): SessionChatToolDetailsReply {
  const raw = chatObject(value);
  const { taskId, sessionId } = input;
  if (raw['taskId'] !== taskId || raw['sessionId'] !== sessionId || raw['turnId'] !== input.turnId ||
      !!input.result !== (raw['result'] !== undefined)) throw invalid();
  const evidence = (value: unknown, expected: SessionChatToolReference): SessionChatToolEvidence => {
    const valueRecord = chatObject(value);
    const { id, revision } = toolReference(valueRecord);
    const record = activityItem(valueRecord['record'], false);
    if (id !== expected.id || revision !== expected.revision || record.id !== id ||
      (record.kind !== 'tool_use' && record.kind !== 'tool_result') ||
      record.media || record.changes || record.text.length > 16000 || record.input.length > 16000) throw invalid();
    return { id, revision, record: { ...record, kind: record.kind } };
  };
  const call = evidence(raw['item'], input.item);
  const result = input.result ? evidence(raw['result'], input.result) : undefined;
  if (result && (call.record.kind !== 'tool_use' || result.record.kind !== 'tool_result' ||
    result.record.toolId !== (call.record.toolId ?? call.id))) throw invalid();
  return { taskId, sessionId, item: call, ...(result ? { result } : {}), ...(input.turnId ? { turnId: input.turnId } : {}) };
}

export function parseTurnWorkRead(value: unknown): SessionChatTurnWorkRead {
  const raw = chatObject(value);
  const turnId = chatText(raw['turnId']);
  const deferToolDetails = deferredToolDetails(raw['deferToolDetails']);
  const timeline = raw['timeline'];
  const limit = raw['limit'] === undefined ? undefined : workCount(raw['limit']);
  if (!turnId || (timeline !== undefined && (timeline !== true || !deferToolDetails)) || (limit !== undefined && (limit < 1 ||
    limit > (deferToolDetails ? SESSION_CHAT_TURN_WORK_MAX_LIMIT : SESSION_CHAT_TURN_WORK_LIMIT)))) throw invalid();
  return {
    taskId: chatId(raw['taskId']), sessionId: chatId(raw['sessionId']),
    requestId: requestId(raw['requestId']), turnId,
    revision: contentRevision(raw['revision']), offset: workCount(raw['offset']),
    ...(deferToolDetails ? { deferToolDetails } : {}),
    ...(timeline === true ? { timeline } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function timelineRow(value: unknown, turnId: string): SessionChatTurnTimelineRow {
  if (value === null) return null;
  const raw = chatObject(value);
  const kind = raw['kind'], id = chatText(raw['id']);
  if (!id || id === turnId) throw invalid();
  if (kind === 'call' || kind === 'result' || kind === 'media') {
    const media = raw['media'] === undefined ? undefined : mediaReferences(raw['media']);
    if (media?.some(value => !value.inline || value.kind === 'file')) throw invalid();
    if (kind === 'media') {
      const callId = chatText(raw['callId']);
      if (!callId || callId === id || callId === turnId || !media?.length) throw invalid();
      return { kind, id, callId, media };
    }
    const resultId = raw['resultId'] === undefined ? undefined : chatText(raw['resultId']);
    const shortLabel = chatText(raw['label'], SESSION_CHAT_TURN_TOOL_LABEL_LIMIT);
    const label = raw['fullLabel'] === undefined ? shortLabel : chatText(raw['fullLabel'], kind === 'call' ? SESSION_CHAT_TOOL_LABEL_LIMIT : undefined);
    const shortMeta = raw['meta'] === undefined ? undefined : chatText(raw['meta'], SESSION_CHAT_TURN_TOOL_META_LIMIT);
    const meta = raw['fullMeta'] === undefined ? shortMeta : chatText(raw['fullMeta'], SESSION_CHAT_TOOL_META_LIMIT);
    const error = raw['error'];
    if (!shortLabel.trim() || (error !== undefined && error !== true) ||
        (resultId !== undefined && (kind !== 'call' || !resultId || resultId === turnId || resultId === id))) throw invalid();
    return {
      kind, id, label, toolKind: nullable(raw['toolKind']),
      ...(raw['agent'] === undefined ? {} : { agent: parseAgentEntry(raw['agent'], kind === 'result', kind === 'call' ? id : undefined) }),
      ...(resultId ? { resultId } : {}), ...(error ? { error } : {}), ...(media ? { media } : {}),
      ...(meta === undefined ? {} : { meta }),
    };
  }
  const row = activityItem(raw, false);
  if (row.kind === 'user' || row.kind === 'tool_use' || row.kind === 'tool_result') throw invalid();
  return row;
}

export function parseTurnWorkPage(value: unknown, input: SessionChatTurnWorkRead): SessionChatTurnWorkReply {
  const raw = chatObject(value);
  const { taskId, sessionId, turnId, revision, offset } = input;
  if (raw['taskId'] !== taskId || raw['sessionId'] !== sessionId ||
    raw['turnId'] !== turnId || raw['revision'] !== revision || raw['offset'] !== offset) throw invalid();
  const total = workCount(raw['total']);
  if (raw['timeline'] !== undefined) {
    if (!input.timeline || raw['items'] !== undefined) throw invalid();
    const limit = offset === 0 && raw['nextOffset'] === null
      ? SESSION_CHAT_FULL_TIMELINE_SLOTS : SESSION_CHAT_TURN_TIMELINE_SLOTS;
    const timeline = array(raw['timeline'], limit, value => timelineRow(value, turnId));
    const end = offset + timeline.length;
    const nextOffset = end < total ? end : null;
    const ids = timeline.flatMap(row => row ? [row.id] : []);
    if (!timeline.length || end > total || raw['nextOffset'] !== nextOffset || new Set(ids).size !== ids.length) throw invalid();
    return { taskId, sessionId, turnId, revision, offset, timeline, total, nextOffset };
  }
  // A legacy engine may ignore the limit and return its ordinary 40-row page.
  const items = array(raw['items'], Math.max(SESSION_CHAT_TURN_WORK_LIMIT, input.limit ?? 0),
    value => activityItem(value, !!input.deferToolDetails, true));
  const end = offset + items.length;
  const nextOffset = end < total ? end : null;
  if (!items.length || end > total || raw['nextOffset'] !== nextOffset ||
    items.some(row => row.kind === 'user' || !row.id || row.id === turnId || row.receipt?.id === turnId || row.invocation?.id === turnId) ||
    new Set(items.map(row => row.id)).size !== items.length) throw invalid();
  return { taskId, sessionId, turnId, revision, offset, items, total, nextOffset };
}
function historyItem(value: unknown, summaryAllowed: boolean, detailsAllowed: boolean): SessionChatItem {
  const raw = chatObject(value), row = activityItem(raw, detailsAllowed);
  if (raw['completedTurn'] === undefined) {
    if (raw['turnChanges'] === undefined) return row;
    if (row.kind !== 'user') throw invalid();
    return { ...row, turnChanges: parseChangeSummary(raw['turnChanges'], SESSION_CHAT_TURN_FILES_LIMIT) };
  }
  if (!summaryAllowed || row.kind !== 'user') throw invalid();
  const turn = chatObject(raw['completedTurn']);
  const endId = chatText(turn['endId']);
  const total = workCount(turn['total']);
  const beforeReply = workCount(turn['beforeReply']);
  const failures = workCount(turn['failures']);
  const reply = array(turn['reply'], SESSION_CHAT_TURN_REPLY_LIMIT, item);
  const agents = turn['agents'] === undefined ? undefined : array(turn['agents'], 16, value => parseAgentEntry(value, false));
  if (!row.id || !endId || endId === row.id || !total || beforeReply > total ||
    reply.some(part => part.kind !== 'assistant' || !part.id || part.id === row.id) ||
    new Set(reply.map(part => part.id)).size !== reply.length ||
    (agents && (agents.length > total || agents.some(entry => entry.id === row.id) || new Set(agents.map(entry => entry.id)).size !== agents.length))) throw invalid();
  const categoryCounts = chatObject(turn['counts']);
  const counts: SessionChatCompletedTurn['counts'] = Object.fromEntries(SESSION_CHAT_TOOL_CATEGORIES.flatMap(category => {
    const value = categoryCounts[category];
    return value === undefined ? [] : [[category, workCount(value)]];
  }));
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) > total) throw invalid();
  return {
    ...row,
    completedTurn: {
      revision: contentRevision(turn['revision']), endId, total, beforeReply, failures, counts, reply,
      ...(agents?.length ? { agents } : {}),
      ...(turn['duration'] === undefined ? {} : { duration: number(turn['duration']) }),
      ...(turn['changes'] === undefined ? {} : { changes: parseChangeSummary(turn['changes'], SESSION_CHAT_TURN_FILES_LIMIT) }),
    },
  };
}
function mediaKind(value: unknown): "image" | "video" | "file" {
  if (value !== "image" && value !== "video" && value !== "file") throw invalid();
  return value;
}
const workKinds: readonly SessionChatWorkEvent["kind"][] = ["finished", "hook", "retry", "compaction", "notification", "transcript", "plugin"];
const workTones: readonly SessionChatWorkEvent["tone"][] = ["info", "success", "warning", "danger"];
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw invalid();
  return match;
}
function workTime(value: unknown): string | null {
  const time = nullable(value, 100);
  if (time !== null && !Number.isFinite(Date.parse(time))) throw invalid();
  return time;
}
function workCount(value: unknown): number {
  const count = number(value);
  if (!Number.isSafeInteger(count)) throw invalid();
  return count;
}
const agentStatuses: readonly SessionChatWorkStatus[] = ["pending", "running", "waiting", "paused", "completed", "interrupted", "stopped", "error", "closed", "unavailable"];
function agentContext(value: unknown): SessionChatAgentContext {
  const raw = chatObject(value);
  const tokens = workCount(raw["tokens"]), limit = workCount(raw["limit"]);
  if (!limit) throw invalid();
  return { tokens, limit, percentage: number(raw["percentage"], 100) };
}
export function parseChatAgentPage(value: unknown, agentId: string): SessionChatAgentPage {
  const raw = chatObject(value);
  if (raw["agentId"] !== agentId) throw invalid();
  return {
    agentId, label: chatText(raw["label"], 240), status: oneOf(raw["status"], agentStatuses),
    ...(raw["title"] === undefined ? {} : { title: chatText(raw["title"], 300) }),
    ...(raw["agentName"] === undefined ? {} : { agentName: chatText(raw["agentName"], 160) }),
    ...(raw["role"] === undefined ? {} : { role: chatText(raw["role"], 120) }),
    prompt: chatText(raw["prompt"], 4000), model: nullable(raw["model"], 160),
    context: raw["context"] === null ? null : agentContext(raw["context"]),
    items: array(raw["items"], 80, item), before: nullable(raw["before"], 2000),
    availability: oneOf(raw["availability"], ["available", "starting", "unavailable", "error"] as const),
    message: chatText(raw["message"], 1000),
  };
}
function work(value: unknown, sessionId?: number, taskId?: number): SessionChatWork {
  const raw = chatObject(value);
  return {
    ...(raw["totalRunning"] === undefined ? {} : { totalRunning: workCount(raw["totalRunning"]) }),
    ...(raw["sessions"] === undefined ? {} : { sessions: parseDelegatedWork(raw["sessions"], sessionId, taskId) }),
    ...(raw["totalSessionsRunning"] === undefined ? {} : { totalSessionsRunning: workCount(raw["totalSessionsRunning"]) }),
    running: array(raw["running"], 16, (value): SessionChatBackgroundWork => {
      const item = chatObject(value);
      const id = chatText(item["id"], 400);
      if (!/^(?:task|subagent):./.test(id)) throw invalid();
      return {
        id,
        kind: oneOf(item["kind"], ["agent", "task"] as const),
        label: chatText(item["label"], 300),
        ...(item["title"] === undefined ? {} : { title: chatText(item["title"], 300) }),
        ...(item["agentName"] === undefined ? {} : { agentName: chatText(item["agentName"], 160) }),
        ...(item["role"] === undefined ? {} : { role: chatText(item["role"], 120) }),
        detail: chatText(item["detail"], 300),
        startedAt: workTime(item["startedAt"]),
        stoppable: bool(item["stoppable"]),
        orphaned: bool(item["orphaned"]),
        ...(item["status"] === undefined ? {} : { status: oneOf(item["status"], agentStatuses) }),
        ...(item["background"] === undefined ? {} : { background: bool(item["background"]) }),
        ...(item["agentId"] === undefined ? {} : { agentId: chatText(item["agentId"], 256) }),
        ...(item["parentToolUseId"] === undefined ? {} : { parentToolUseId: chatText(item["parentToolUseId"]) }),
        ...(item["inspectable"] === undefined ? {} : { inspectable: bool(item["inspectable"]) }),
        ...(item["canBackground"] === undefined ? {} : { canBackground: bool(item["canBackground"]) }),
        ...(item["model"] === undefined ? {} : { model: chatText(item["model"], 160) }),
        ...(item["effort"] === undefined ? {} : { effort: chatText(item["effort"], 80) }),
        ...(item["context"] === undefined ? {} : { context: agentContext(item["context"]) }),
        ...(item["tokens"] === undefined ? {} : { tokens: workCount(item["tokens"]) }),
        ...(item["toolUses"] === undefined ? {} : { toolUses: workCount(item["toolUses"]) }),
      };
    }),
    recent: array(raw["recent"], 12, (value): SessionChatWorkEvent => {
      const event = chatObject(value);
      return {
        id: chatText(event["id"], 420),
        kind: oneOf(event["kind"], workKinds),
        tone: oneOf(event["tone"], workTones),
        title: chatText(event["title"], 300),
        detail: chatText(event["detail"], 1100),
        at: workTime(event["at"]),
        ...(event["agentId"] === undefined ? {} : { agentId: chatText(event["agentId"], 256) }),
        ...(event["agentStatus"] === undefined ? {} : { agentStatus: oneOf(event["agentStatus"], agentStatuses) }),
        ...(event["parentToolUseId"] === undefined ? {} : { parentToolUseId: chatText(event["parentToolUseId"]) }),
      };
    }),
  };
}
function planUsage(
  value: unknown,
  provider: unknown,
): SessionChatPlanUsage | null {
  if (value === null) return null;
  const raw = chatObject(value);
  const source = raw["provider"],
    status = raw["status"];
  if (
    (source !== "codex" && source !== "claude") ||
    source !== provider ||
    (status !== "available" && status !== "warning" && status !== "exhausted")
  )
    throw invalid();
  const updatedAt = chatText(raw["updatedAt"], 100);
  if (!Number.isFinite(Date.parse(updatedAt))) throw invalid();
  const windows = array(raw["windows"], 8, (value) => {
    const window = chatObject(value);
    const id = chatText(window["id"], 100),
      label = chatText(window["label"], 100);
    if (!id || !label) throw invalid();
    return {
      id,
      label,
      remainingPercentage: number(window["remainingPercentage"], 100),
      resetsAt:
        window["resetsAt"] === null
          ? null
          : number(window["resetsAt"], 8.64e12),
    };
  });
  if (
    !windows.length ||
    new Set(windows.map((window) => window.id)).size !== windows.length
  )
    throw invalid();
  return {
    provider: source,
    planName: nullable(raw["planName"], 100),
    status,
    windows,
    updatedAt,
  };
}
function modelQuota(
  value: unknown,
  provider: unknown,
): SessionChatModelQuota | null {
  if (value === null) return null;
  const raw = chatObject(value);
  const source = chatText(raw["provider"], 100);
  if (source !== provider) throw invalid();
  const updatedAt = chatText(raw["updatedAt"], 100);
  if (!Number.isFinite(Date.parse(updatedAt))) throw invalid();
  const models = array(raw["models"], 32, (value) => {
    const model = chatObject(value);
    const id = chatText(model["id"]),
      label = chatText(model["label"]);
    if (!id || !label) throw invalid();
    return {
      id,
      label,
      remainingPercentage:
        model["remainingPercentage"] === null
          ? null
          : number(model["remainingPercentage"], 100),
      exhausted: bool(model["exhausted"]),
      resetsAt:
        model["resetsAt"] === null ? null : number(model["resetsAt"], 8.64e12),
    };
  });
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw invalid();
  return {
    provider: source,
    tier: nullable(raw["tier"], 100),
    models,
    updatedAt,
  };
}
export function parseChatState(value: unknown, sessionId?: number, taskId?: number): SessionChatState {
  const raw = chatObject(value),
    phase = raw["phase"];
  if (
    phase !== "idle" &&
    phase !== "running" &&
    phase !== "waiting" &&
    phase !== "error"
  )
    throw invalid();
  const activePromptId = raw['activePromptId'] === undefined ? undefined : chatText(raw['activePromptId']);
  if (activePromptId !== undefined && (!activePromptId || (phase !== 'running' && phase !== 'waiting')))
    throw invalid();
  const permission =
    raw["permission"] === null ? null : chatObject(raw["permission"]);
  const question =
    raw["question"] === null ? null : chatObject(raw["question"]);
  const rawDecision = question?.["decision"];
  let decision: NonNullable<SessionChatState["question"]>["decision"];
  if (rawDecision !== undefined) {
    const value = chatObject(rawDecision);
    if (value["kind"] === "confirm") {
      decision = {
        kind: "confirm",
        title: chatText(value["title"]),
        source: chatText(value["source"]),
        description: chatText(value["description"], 4100),
      };
    } else if (value["kind"] === "unsupported") {
      decision = { kind: "unsupported" };
    } else throw invalid();
  }
  if (raw["presets"] !== undefined) {
    const presets = array(raw["presets"], 24, (value) =>
      presetId(chatObject(value)["id"]),
    );
    if (new Set(presets).size !== presets.length) throw invalid();
  }
  const context = raw["context"] === null ? null : chatObject(raw["context"]);
  return {
    provider: chatText(raw["provider"]),
    ...(activePromptId === undefined ? {} : { activePromptId }),
    ...(raw["browserElements"] === undefined ? {} : { browserElements: bool(raw["browserElements"]) }),
    ...(raw['historyRewrite'] === undefined ? {} : { historyRewrite: chatText(raw['historyRewrite'], 64) }),
    ...(raw["unseenCompletionAt"] === undefined ? {} : {
      unseenCompletionAt: raw["unseenCompletionAt"] === null ? null : completionAt(raw["unseenCompletionAt"]),
    }),
    ...(raw["attachments"] === undefined ? {} : { attachments: bool(raw["attachments"]) }),
    ...(raw["sessionMentions"] === undefined ? {} : { sessionMentions: bool(raw["sessionMentions"]) }),
    ...(raw["presetCatalogs"] === undefined
      ? {}
      : { presetCatalogs: bool(raw["presetCatalogs"]) }),
    ...(raw["presetEditing"] === undefined
      ? {}
      : { presetEditing: bool(raw["presetEditing"]) }),
    ...(raw["presetDefault"] === undefined
      ? {}
      : { presetDefault: parsePresetDefault(raw["presetDefault"]) }),
    ...(raw["presets"] === undefined
      ? {}
      : {
          presets: array(raw["presets"], 24, (value) => {
            const preset = chatObject(value);
            return {
              id: presetId(preset["id"]),
              name: chatText(preset["name"], 48),
              provider: chatText(preset["provider"]),
              providerLabel: chatText(preset["providerLabel"]),
              model: nullable(preset["model"]),
              modelLabel: chatText(preset["modelLabel"]),
              reasoning: nullable(preset["reasoning"]),
              fast: bool(preset["fast"]),
            };
          }),
        }),
    ...(raw["planUsage"] === undefined
      ? {}
      : {
          planUsage: planUsage(raw["planUsage"], raw["provider"]),
        }),
    ...(raw["work"] === undefined ? {} : { work: work(raw["work"], sessionId, taskId) }),
    ...(raw["delegation"] === undefined ? {} : { delegation: parseAgentContext(raw["delegation"], sessionId, taskId) }),
    ...(raw["nativeAgentInspection"] === undefined ? {} : { nativeAgentInspection: bool(raw["nativeAgentInspection"]) }),
    ...(raw["modelQuota"] === undefined
      ? {}
      : { modelQuota: modelQuota(raw["modelQuota"], raw["provider"]) }),
    ...(raw["providers"] === undefined
      ? {}
      : {
          providers: array(raw["providers"], 32, (value) => {
            const provider = chatObject(value);
            return {
              id: chatText(provider["id"]),
              label: chatText(provider["label"]),
            };
          }),
        }),
    ...(raw["providerLocked"] === undefined
      ? {}
      : { providerLocked: bool(raw["providerLocked"]) }),
    ...(raw["controls"] === undefined
      ? {}
      : {
          controls: {
            plan: bool(chatObject(raw["controls"])["plan"]),
            reasoning: bool(chatObject(raw["controls"])["reasoning"]),
            fast: bool(chatObject(raw["controls"])["fast"]),
          },
        }),
    ...(raw["fast"] === undefined ? {} : { fast: bool(raw["fast"]) }),
    phase,
    canInterrupt: bool(raw["canInterrupt"]),
    error: nullable(raw["error"]),
    model: nullable(raw["model"]),
    reasoning: nullable(raw["reasoning"]),
    plan: bool(raw["plan"]),
    permissionMode: nullable(raw["permissionMode"]),
    permissionModes: array(raw["permissionModes"], 20, (v) => chatText(v)),
    models: array(raw["models"], 100, (value) => {
      const m = chatObject(value);
      return {
        id: chatText(m["id"]),
        label: chatText(m["label"]),
        ...(m["reasoningEfforts"] === undefined
          ? {}
          : {
              reasoningEfforts: array(m["reasoningEfforts"], 20, (v) =>
                chatText(v),
              ),
            }),
        ...(m["supportsFastMode"] === undefined
          ? {}
          : { supportsFastMode: bool(m["supportsFastMode"]) }),
      };
    }),
    context: context && {
      tokens: number(context["tokens"]),
      limit: number(context["limit"]),
      percentage: number(context["percentage"], 100),
    },
    queue: array(raw["queue"], 50, (value) => {
      const q = chatObject(value);
      return { id: chatText(q["id"]), text: chatText(q["text"], 64000),
        ...(q['sender'] === undefined ? {} : { sender: parseAgentSender(q['sender']) }) };
    }),
    queuePaused: bool(raw["queuePaused"]),
    ...(raw["canSteer"] === undefined ? {} : { canSteer: bool(raw["canSteer"]) }),
    ...(raw["dispatchingPrompts"] === undefined ? {} : {
      dispatchingPrompts: array(raw["dispatchingPrompts"], 8, value => {
        const prompt = chatObject(value);
        const id = chatText(prompt["id"]), timestamp = chatText(prompt["timestamp"], 100);
        if (!id || !Number.isFinite(Date.parse(timestamp))) throw invalid();
        return {
          id, timestamp, text: chatText(prompt["text"], 64000),
          ...(prompt["mentions"] === undefined ? {} : { mentions: sessionMentions(prompt["mentions"]) }),
          ...(prompt["sender"] === undefined ? {} : { sender: parseAgentSender(prompt["sender"]) }),
          ...(prompt["media"] === undefined ? {} : { media: mediaReferences(prompt["media"]) }),
        };
      }),
    }),
    permission: permission && {
      id: chatText(permission["id"]),
      title: chatText(permission["title"]),
      description: chatText(permission["description"], 4100),
      input: chatText(permission["input"], 16100),
      allowAlways: bool(permission["allowAlways"]),
    },
    question: question && {
      id: chatText(question["id"]),
      message: chatText(question["message"], 4100),
      url: nullable(question["url"]),
      ...(decision ? { decision } : {}),
      questions: array(question["questions"], 20, (value) => {
        const q = chatObject(value);
        return {
          id: chatText(q["id"]),
          question: chatText(q["question"], 4100),
          multiple: bool(q["multiple"]),
          options: array(q["options"], 30, (value) => {
            const o = chatObject(value);
            return {
              label: chatText(o["label"]),
              detail: chatText(o["detail"], 2100),
            };
          }),
        };
      }),
    },
    activity: array(raw["activity"], 32, (value) => {
      const a = chatObject(value);
      return {
        id: chatText(a["id"]),
        label: chatText(a["label"], 2100),
        detail: chatText(a["detail"], 2100),
      };
    }),
  };
}
export function parseChatPage(
  value: unknown,
  taskId: number,
  sessionId: number,
  loadingMode?: 'window' | 'progressive',
  summarizeCompleted = false,
  deferToolDetails = false,
): SessionChatPage {
  const raw = chatObject(value);
  return { ...parseChatPageWindow(raw, taskId, sessionId, loadingMode, summarizeCompleted, deferToolDetails),
    state: parseChatState(raw['state'], sessionId, taskId) };
}

export function parseChatPageWindow(
  raw: Record<string, unknown>,
  taskId: number,
  sessionId: number,
  loadingMode?: 'window' | 'progressive',
  summarizeCompleted = false,
  deferToolDetails = false,
): Omit<SessionChatPage, 'state'> {
  if (raw["taskId"] !== taskId || raw["sessionId"] !== sessionId)
    throw invalid();
  const leadingPrompt = raw['leadingPrompt'] == null ? raw['leadingPrompt'] : item(raw['leadingPrompt']);
  if (leadingPrompt && leadingPrompt.kind !== 'user') throw invalid();
  return {
    taskId,
    sessionId,
    ...(leadingPrompt !== undefined ? { leadingPrompt } : {}),
    cursor: chatText(raw["cursor"], 200),
    reset: bool(raw["reset"]),
    before: nullable(raw["before"]),
    ...(raw["next"] !== undefined ? { next: nullable(raw["next"]) } : {}),
    items: array(raw["items"], loadingMode === 'window' ? 320 : 80, value => historyItem(value, summarizeCompleted, deferToolDetails)),
    events: array(raw["events"], loadingMode === 'window' ? 320 : 80, (value): SessionChatEvent => {
      const event = chatObject(value);
      if (event["type"] === "reset") return { type: "reset" };
      if (event["type"] === "item")
        return { type: "item", item: activityItem(event["item"], deferToolDetails) };
      if (event["type"] === "delta")
        return {
          type: "delta",
          id: chatText(event["id"]),
          text: chatText(event["text"], 16100),
        };
      throw invalid();
    }),
  };
}
export function parseChatAction(value: unknown): SessionChatAction {
  const raw = chatObject(value),
    type = raw["type"];
  switch (type) {
    case "mark-seen":
      return { type, completionAt: completionAt(raw["completionAt"]) };
    case "preset-reorder": {
      const ids = array(raw["ids"], 24, presetId);
      if (!ids.length || new Set(ids).size !== ids.length) throw invalid();
      return { type, ids, expectedRevision: defaultRevision(raw["expectedRevision"]) };
    }
    case "preset-delete":
      return {
        type, id: presetId(raw["id"]),
        expectedRevision: defaultRevision(raw["expectedRevision"]),
      };
    case "preset-update":
    case "preset-restore": {
      const name = chatText(raw["name"], 48).trim();
      if (!name) throw invalid();
      const preset = {
        id: presetId(raw["id"]), name, provider: presetId(raw["provider"]),
        model: nullable(raw["model"]), reasoning: nullable(raw["reasoning"]),
        fast: bool(raw["fast"]), expectedRevision: defaultRevision(raw["expectedRevision"]),
      };
      if (type === "preset-update") return { type, ...preset };
      const position = raw["position"];
      if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position >= 24)
        throw invalid();
      const defaultIds = array(raw["defaultIds"], 24, presetId);
      if (new Set(defaultIds).size !== defaultIds.length) throw invalid();
      return { type, ...preset, position, defaultProvider: presetId(raw["defaultProvider"]), defaultIds };
    }
    case "preset-default":
      return {
        type,
        id: presetId(raw["id"]),
        expectedProvider: presetId(raw["expectedProvider"]),
        expectedRevision: defaultRevision(raw["expectedRevision"]),
      };
    case "preset-default-restore": {
      const defaultIds = array(raw["defaultIds"], 24, presetId);
      if (new Set(defaultIds).size !== defaultIds.length) throw invalid();
      return {
        type,
        provider: presetId(raw["provider"]),
        defaultIds,
        expectedRevision: defaultRevision(raw["expectedRevision"]),
      };
    }
    case "preset": {
      const mix = raw["expectedMix"] === undefined ? undefined : chatObject(raw["expectedMix"]);
      return {
        type,
        id: presetId(raw["id"]),
        expectedProvider: chatText(raw["expectedProvider"]),
        ...(mix ? { expectedMix: {
          model: nullable(mix["model"]), reasoning: nullable(mix["reasoning"]),
          fast: bool(mix["fast"]), revision: defaultRevision(mix["revision"]),
        } } : {}),
      };
    }
    case "save-preset": {
      const name = chatText(raw["name"], 48).trim();
      if (
        !name ||
        (raw["makeDefault"] === true &&
          raw["expectedDefaultRevision"] === undefined)
      )
        throw invalid();
      return {
        type,
        id: presetId(raw["id"]),
        name,
        ...(raw["provider"] === undefined
          ? {}
          : { provider: presetId(raw["provider"]) }),
        ...(raw["makeDefault"] === undefined
          ? {}
          : { makeDefault: bool(raw["makeDefault"]) }),
        ...(raw["expectedDefaultRevision"] === undefined
          ? {}
          : {
              expectedDefaultRevision: defaultRevision(
                raw["expectedDefaultRevision"],
              ),
            }),
        expectedProvider: chatText(raw["expectedProvider"]),
        model: nullable(raw["model"]),
        reasoning: nullable(raw["reasoning"]),
        fast: bool(raw["fast"]),
      };
    }
    case "provider": {
      const provider = chatText(raw["provider"]),
        expectedProvider = chatText(raw["expectedProvider"]);
      if (!provider.trim() || !expectedProvider.trim()) throw invalid();
      return { type, provider, expectedProvider };
    }
    case "send": {
      const text = chatText(raw["text"], SESSION_CHAT_PROMPT_LIMIT);
      if (!text.trim()) throw invalid();
      const sessionIds = raw['sessionIds'] === undefined ? undefined : array(raw['sessionIds'], 8, value => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw invalid();
        return value;
      });
      if (sessionIds && new Set(sessionIds).size !== sessionIds.length) throw invalid();
      return { type, text, queue: bool(raw["queue"]), ...(sessionIds ? { sessionIds } : {}) };
    }
    case "edit-prompt": {
      const itemId = chatText(raw["itemId"]), text = chatText(raw["text"], SESSION_CHAT_PROMPT_LIMIT);
      if (!itemId.trim() || !text.trim()) throw invalid();
      return { type, itemId, revision: defaultRevision(raw["revision"]), text };
    }
    case "stop":
    case "resume-queue":
      return { type };
    case "cancel-queued":
    case "steer-queued":
      return { type, id: chatText(raw["id"]) };
    case "background-agent": {
      const id = chatText(raw["id"], 256);
      if (!/^[\w-]{1,256}$/.test(id)) throw invalid();
      return { type, id };
    }
    case "stop-background": {
      const id = chatText(raw["id"], 400);
      if (!/^(?:task|subagent):./.test(id)) throw invalid();
      return { type, id };
    }
    case "permission": {
      const decision = raw["decision"];
      if (
        decision !== "approved" &&
        decision !== "always" &&
        decision !== "denied"
      )
        throw invalid();
      return { type, id: chatText(raw["id"]), decision };
    }
    case "answer": {
      const answers = chatObject(raw["answers"]);
      if (Object.keys(answers).length > 20) throw invalid();
      return {
        type,
        id: chatText(raw["id"]),
        ...(raw["decline"] === undefined
          ? {}
          : { decline: bool(raw["decline"]) }),
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, value]) => [
            chatText(key),
            array(value, 30, (v) => chatText(v, 4000)),
          ]),
        ),
      };
    }
    case "model":
      return { type, model: nullable(raw["model"]) };
    case "plan":
    case "fast":
      return { type, enabled: bool(raw["enabled"]) };
    case "reasoning":
      return { type, effort: nullable(raw["effort"]) };
    case "permission-mode":
      return { type, mode: chatText(raw["mode"]) };
    default:
      throw invalid();
  }
}
