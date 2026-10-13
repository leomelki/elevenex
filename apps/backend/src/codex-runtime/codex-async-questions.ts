import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';

export function codexAsyncQuestionCall(
  toolUseId: string,
  questions: unknown[],
  timestamp: string,
): ClaudeTranscriptItem {
  const input = { questions };
  return {
    id: `${toolUseId}:tool_use`,
    kind: 'tool_use',
    toolUseId,
    toolName: 'AskUserQuestion',
    providerToolName: 'request_user_input_async',
    ...canonicalizeAgentTool('AskUserQuestion', input),
    providerToolInput: input,
    sourceMessageId: toolUseId,
    timestamp,
    receivedAt: timestamp,
  };
}

// Async replies are sent through turn/start or turn/steer as plain text.
// Recognize the complete question sequence, rather than hiding arbitrary
// user messages containing "Answer:".
export function codexAsyncQuestionAnswers(
  call: ClaudeTranscriptItem,
  prompt: string,
): Record<string, { answers: string[] }> | null {
  const input = call.toolInput as { questions?: Record<string, unknown>[] };
  const questions = input?.questions;
  if (!Array.isArray(questions) || !questions.length) return null;
  if (questions.some((question) => !question || typeof question !== 'object'))
    return null;
  const prefixes = questions.map((question) => {
    const label = question.question ?? question.title;
    return typeof label === 'string' && label ? `${label}\nAnswer: ` : null;
  });
  if (prefixes.some((prefix) => !prefix)) return null;
  const answers: Record<string, { answers: string[] }> = {};
  let remaining = prompt;
  for (const [index, question] of questions.entries()) {
    const prefix = prefixes[index]!;
    // turn/start trims the prompt, including the space after an empty answer.
    if (index === questions.length - 1 && remaining === prefix.trimEnd())
      remaining = prefix;
    if (!remaining.startsWith(prefix)) return null;
    remaining = remaining.slice(prefix.length);
    const next = prefixes[index + 1];
    const end = next
      ? remaining.indexOf(`\n\n${next.trimEnd()}`)
      : remaining.length;
    if (end < 0) return null;
    const answer = remaining.slice(0, end);
    const key = String(question.id ?? question.question ?? question.title);
    answers[key] = { answers: answer ? [answer] : [] };
    remaining = remaining.slice(end + (next ? 2 : 0));
  }
  return answers;
}

export function codexAsyncQuestionResult(
  toolUseId: string,
  answers: Record<string, { answers: string[] }>,
  timestamp: string,
): ClaudeTranscriptItem {
  return {
    id: `${toolUseId}:tool_result`,
    kind: 'tool_result',
    toolUseId,
    content: JSON.stringify({ answers }),
    timestamp,
    authoredAt: timestamp,
  };
}
