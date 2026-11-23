const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin });
const sessionId = 'native-session';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (id, value) => send({ id, result: value });
const update = value => send({ method: 'session/update', params: { sessionId, update: value } });
const text = value => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const permission = {
  toolCallId: 'test-tool',
  title: 'Read a file',
  kind: 'read',
  locations: [{ path: 'README.md' }],
};
let promptId;
let mode = 'new';
let model = 'default-model';
const options = () => [{
  id: 'model', type: 'select', category: 'model', currentValue: model,
  options: [{ value: 'default-model', name: 'Default model' }, { value: 'other-model', name: 'Other model' }],
}];

input.on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      result(id, { protocolVersion: 1, agentCapabilities: {
        promptCapabilities: { image: true }, sessionCapabilities: { resume: {} },
      } });
      break;
    case 'session/new':
      if (process.env.ACP_FIXTURE_SIGNED_OUT === '1') {
        send({ id, error: { code: -32000, message: 'Secret login diagnostics' } });
        break;
      }
      result(id, { sessionId, configOptions: options() });
      break;
    case 'session/resume':
      if (params.sessionId !== sessionId) throw new Error('Wrong session to resume');
      mode = 'resumed';
      result(id, { configOptions: options() });
      break;
    case 'session/set_config_option':
      model = params.value;
      result(id, { configOptions: options() });
      break;
    case 'session/prompt': {
      promptId = id;
      const prompt = params.prompt[0].text;
      if (prompt === 'review' || prompt === 'stop') {
        text('Ready ');
        text('to review.');
        update({ sessionUpdate: 'tool_call', ...permission, status: 'pending' });
        send({ id: 'permission', method: 'session/request_permission', params: {
          sessionId, toolCall: permission,
          options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }],
        } });
      } else if (prompt === 'exit') {
        process.exit(1);
      } else {
        text(`${mode}, ${model}: ${prompt}`);
        result(id, { stopReason: 'end_turn' });
      }
      break;
    }
    case 'session/cancel':
      // Finish after receiving the cancellation response to the permission.
      break;
    default:
      if (id === 'permission' && message.result.outcome.outcome === 'cancelled') {
        result(promptId, { stopReason: 'cancelled' });
      } else if (id === 'permission') {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'test-tool', status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: message.result.outcome.optionId } }],
        });
        send({ id: 'question', method: 'elicitation/create', params: { sessionId, mode: 'form', message: 'Proceed?',
          requestedSchema: { type: 'object', properties: { reply: { type: 'string' } } },
        } });
      } else if (id === 'question') {
        text(message.result.content?.reply ?? message.result.action);
        result(promptId, { stopReason: 'end_turn' });
      }
  }
});
