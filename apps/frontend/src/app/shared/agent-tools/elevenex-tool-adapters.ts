import type { ResultSummary } from './agent-tool-format';
import type { ElevenexField } from './elevenex-tool-view';

type Receipt = Record<string, unknown>;
interface ResultAdapter {
  summary?: ResultSummary;
  notice?: string;
  content?: string;
  fields?: ElevenexField[];
}
const taskResults = new Set([
  'get_task',
  'create_task',
  'retry_task',
  'reopen_task',
  'rename_task',
  'finish_task',
  'await_task_ready',
]);
const commandResults = new Set([
  'run_action',
  'stop_action',
  'poll_action_status',
  'read_action_output',
  'set_action',
]);
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Interpret domain-specific outcomes before the generic receipt fallback. */
export function adaptElevenexResult(tool: string, data: Receipt): ResultAdapter {
  if (tool === 'set_action')
    return {
      summary: {
        text:
          data['created'] === false && data['updated'] === false
            ? 'Already saved'
            : 'Command saved',
        tone: 'ok',
      },
      content: string(data['command']),
      notice: 'Saving a command does not run it. Its previous run status is separate.',
    };
  if (taskResults.has(tool)) {
    if (data['finishedAt'])
      return {
        summary: { text: 'Finished', tone: 'ok' },
        notice:
          data['linkStatus'] === 'unlinked'
            ? 'Checkout released. Branch and conversation history are preserved.'
            : 'Checkout retained. Branch and conversation history are preserved.',
      };
    if (data['timedOut'] === true)
      return {
        summary: { text: 'Setup continuing', tone: 'warn' },
        notice: 'The wait ended; task setup continues in the background.',
      };
  }
  if (commandResults.has(tool)) {
    const failed =
      data['status'] === 'failed' ||
      (typeof data['exitCode'] === 'number' && data['exitCode'] !== 0);
    if (failed) return { summary: { text: 'Command failed', tone: 'error' } };
    if (data['status'] === 'stopped') return { summary: { text: 'Command stopped', tone: 'warn' } };
    if (data['status'] === 'success') return { summary: { text: 'Command succeeded', tone: 'ok' } };
  }
  if (tool === 'change_review') {
    const totals =
      data['totals'] && typeof data['totals'] === 'object' ? (data['totals'] as Receipt) : {};
    const fields: ElevenexField[] = [];
    for (const [key, label] of [
      ['files', 'Changed files'],
      ['additions', 'Added lines'],
      ['deletions', 'Removed lines'],
    ]) {
      if (typeof totals[key] === 'number') fields.push({ label, value: String(totals[key]) });
    }
    if (data['blocked'] === true)
      return {
        summary: { text: 'Review limited', tone: 'warn' },
        notice:
          string(data['reason']) || 'The diff exceeded the size limit. Narrow the review scope.',
        fields:
          typeof data['totalFiles'] === 'number'
            ? [...fields, { label: 'Changed files', value: String(data['totalFiles']) }]
            : fields,
      };
    return { fields };
  }
  if (tool === 'poll_session_status') return { content: string(data['transcriptSummary']) };
  if (tool === 'ask_session' && data['running'] === true)
    return {
      summary: { text: 'Answer pending', tone: 'warn' },
      notice: 'The question is still being answered in a separate conversation.',
    };
  if (tool === 'get_session_config')
    return { summary: { text: 'Configuration resolved', tone: 'neutral' } };
  return {};
}

/** Normalize each actual backend row contract into display fields. */
export function adaptElevenexRow(tool: string, row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const data = row as Receipt;
  if (tool === 'text_search')
    return { ...data, line: data['lineNumber'], snippet: data['lineText'] };
  if (tool === 'grep_session')
    return {
      ...data,
      name: `Line ${data['lineNumber']}`,
      line: data['lineNumber'],
      snippet: data['context'] ?? data['line'],
    };
  if (tool === 'change_review')
    return {
      ...data,
      status: undefined,
      description: [
        string(data['status']),
        typeof data['additions'] === 'number' ? `+${data['additions']}` : '',
        typeof data['deletions'] === 'number' ? `−${data['deletions']}` : '',
        data['binary'] === true ? 'Binary file' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    };
  if (tool === 'list_scratchpad')
    return {
      ...data,
      description: [`Note #${data['sectionId']}`, string(data['description'])]
        .filter(Boolean)
        .join(' · '),
    };
  if (tool === 'list_todos') return { ...data, description: `Todo #${data['todoId']}` };
  if (tool === 'list_actions') return { ...data, description: `Command #${data['actionId']}` };
  if (tool === 'get_session_config') return { ...data, ref: data['id'] };
  return data;
}
