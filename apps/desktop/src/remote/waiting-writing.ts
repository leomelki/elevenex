import type { SavedWaitingChat, SavedWaitingSession, SavedWaitingTask, WaitingWriting, WaitingWritingStatus } from '@elevenex/shared';
import { parseChatAction } from '../backend-client/session-chat-validation';
import { object, text } from './validation';

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid waiting resource.');
  return value;
}
function status(value: unknown): WaitingWritingStatus {
  if (value !== 'waiting' && value !== 'sending' && value !== 'unknown' && value !== 'failed') throw new Error('Invalid waiting status.');
  return value;
}
/** Disk and renderer input use the same bounded allowlist. SSH challenges cannot be journaled. */
export function waitingWriting(value: unknown): WaitingWriting {
  const raw = object(value, ['chat', 'tasks', 'sessions']);
  if (!Array.isArray(raw['chat']) || raw['chat'].length > 20 || !Array.isArray(raw['tasks']) || raw['tasks'].length > 10) throw new Error('Waiting writing exceeds its limit.');
  const chat = raw['chat'].map((value: unknown): SavedWaitingChat => {
    const raw = object(value, ['id', 'taskId', 'sessionId', 'action', 'label', 'turnId', 'status', 'error']);
    const action = parseChatAction(raw['action']);
    if (action.type !== 'send' && action.type !== 'stop' && action.type !== 'answer' && action.type !== 'permission') throw new Error('This action cannot wait.');
    return { id: text(raw['id'], 100), taskId: id(raw['taskId']), sessionId: id(raw['sessionId']), action, label: text(raw['label'], 64000),
      turnId: raw['turnId'] === null ? null : text(raw['turnId'], 2000), status: status(raw['status']), ...(raw['error'] === undefined ? {} : { error: text(raw['error'], 2000) }) };
  });
  const tasks = raw['tasks'].map((value: unknown): SavedWaitingTask => {
    const raw = object(value, ['id', 'projectId', 'input', 'planned', 'status', 'error']);
    const input = object(raw['input'], ['repoId', 'name', 'branchName', 'mode', 'baseRef', 'requestId']);
    const requestId = text(raw['id'], 100), mode = input['mode'];
    if (input['requestId'] !== requestId || (mode !== 'new' && mode !== 'existing') || typeof raw['planned'] !== 'boolean') throw new Error('Invalid waiting task.');
    return { id: requestId, projectId: id(raw['projectId']), planned: raw['planned'], status: status(raw['status']),
      input: { repoId: id(input['repoId']), name: text(input['name'], 240), branchName: text(input['branchName'], 1024), mode, requestId,
        ...(input['baseRef'] === undefined ? {} : { baseRef: text(input['baseRef'], 1024) }) }, ...(raw['error'] === undefined ? {} : { error: text(raw['error'], 2000) }) };
  });
  const rawSessions = raw['sessions'] ?? [];
  if (!Array.isArray(rawSessions) || rawSessions.length > 10) throw new Error('Too many waiting sessions.');
  const sessions = rawSessions.map((value: unknown): SavedWaitingSession => {
    const raw = object(value, ['id', 'taskId', 'taskName', 'status', 'error']);
    return { id: text(raw['id'], 100), taskId: id(raw['taskId']), taskName: text(raw['taskName'], 240), status: status(raw['status']), ...(raw['error'] === undefined ? {} : { error: text(raw['error'], 2000) }) };
  });
  const ids = [...chat, ...tasks, ...sessions].map(item => item.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !id.trim())) throw new Error('Duplicate or empty waiting identity.');
  const result = { chat, tasks, ...(raw['sessions'] === undefined ? {} : { sessions }) };
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('Waiting writing exceeds its byte limit.');
  return result;
}
