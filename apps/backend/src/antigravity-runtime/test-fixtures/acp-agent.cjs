const readline = require('node:readline');
const { deepStrictEqual, match } = require('node:assert/strict');

const input = readline.createInterface({ input: process.stdin });
const sessionId = process.env.ACP_FIXTURE_NATIVE_ID || 'native-session';
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
let deferredWake;
let steeringId;
let fileReadCapability;
let conversation = 'new';
let model = 'default-model';
let mode = 'default';
const modes = ['default', 'accept-edits', 'plan', ...(process.env.ACP_FIXTURE_AUTO ? ['auto'] : [])];
const legacyModes = process.env.ACP_FIXTURE_LEGACY_MODES === '1';
const titleHelper = process.argv.includes('--include-default-customizations=false');
const httpMcp = process.argv.includes('--process-per-session') && !process.env.ACP_FIXTURE_NO_HTTP_MCP;
const checkMcp = servers => {
  if (!httpMcp) {
    deepStrictEqual(servers, []);
    return;
  }
  const authorization = servers[0]?.headers[0]?.value;
  const expectedToken = process.env.ACP_FIXTURE_EXPECT_MCP_TOKEN;
  if (expectedToken) deepStrictEqual(authorization, `Bearer ${expectedToken}`);
  else match(authorization, /^Bearer evx_[A-Za-z0-9_-]{32}$/);
  deepStrictEqual(servers, [{
    type: 'http', name: 'elevenex', url: process.env.ELEVENEX_MCP_URL,
    headers: [{ name: 'Authorization', value: authorization }],
  }]);
};
const modeOption = () => ({
  id: 'mode', type: 'select', category: 'mode', currentValue: mode,
  options: modes.map(value => ({ value, name: value })),
});
const options = () => [{
  id: 'model', type: 'select', category: 'model', currentValue: model,
  options: [{ value: 'default-model', name: 'Default model' }, { value: 'other-model', name: 'Other model' }],
}, {
  id: 'thinking_level', type: 'select', category: 'thought_level', currentValue: 'high',
  options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
}, ...(legacyModes ? [] : [modeOption()])];
const configuration = () => ({
  configOptions: options(),
  ...(legacyModes ? {
    modes: { currentModeId: mode, availableModes: modes.map(id => ({ id, name: id })) },
  } : {}),
});

input.on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      fileReadCapability = params.clientCapabilities.fs;
      result(id, { protocolVersion: 1, agentInfo: { version: '1.5.15' }, agentCapabilities: {
        promptCapabilities: { image: true, audio: true, embeddedContext: true }, sessionCapabilities: { resume: {}, close: {} },
        ...(httpMcp ? { mcpCapabilities: { http: true } } : {}),
      } });
      break;
    case 'session/new':
      checkMcp(params.mcpServers);
      if (process.env.ACP_FIXTURE_SIGNED_OUT === '1') {
        send({ id, error: { code: -32000, message: 'Secret login diagnostics' } });
        break;
      }
      // Mirrors the CLI: account tier in _meta, then an initial context report.
      result(id, {
        sessionId, ...configuration(),
        _meta: { antigravity: { tier: { name: 'Antigravity Starter Quota', id: 'starter' } } },
      });
      update({ sessionUpdate: 'usage_update', used: 0, size: 1048576 });
      update({ sessionUpdate: 'available_commands_update', availableCommands: [
        { name: 'compact', description: 'Compact conversation' },
        { name: 'goal', description: 'Keep working toward an objective', input: { hint: 'Objective' } },
      ] });
      break;
    case 'session/close':
      if (params.sessionId !== sessionId) throw new Error('Wrong session to close');
      result(id, {});
      break;
    case 'session/resume':
      checkMcp(params.mcpServers);
      if (params.sessionId !== sessionId) throw new Error('Wrong session to resume');
      conversation = 'resumed';
      result(id, configuration());
      break;
    case 'session/set_config_option':
      if (params.configId === 'mode') {
        if (legacyModes || !modes.includes(params.value)) throw new Error('Unexpected config mode');
        if (!process.env.ACP_FIXTURE_IGNORE_MODE) mode = params.value;
      } else if (params.configId === 'model') model = params.value;
      result(id, { configOptions: options() });
      break;
    case 'session/set_mode':
      if (!legacyModes || !modes.includes(params.modeId)) throw new Error('Unexpected legacy mode');
      mode = params.modeId;
      result(id, {});
      break;
    case 'session/prompt': {
      let prompt = params.prompt[0].text;
      if (prompt.startsWith('Conversation context retained before an edited message.')) {
        deepStrictEqual(JSON.parse(prompt.split('\n').at(-1)), [
          { role: 'user', content: 'keep this' },
          { role: 'assistant', content: 'new, default-model: keep this' },
        ]);
        prompt = params.prompt[1].text;
        deepStrictEqual(prompt, 'revised prompt');
      }
      if (prompt === 'steer now' && steeringId) {
        result(steeringId, { stopReason: 'cancelled' });
        text('Steered without cancellation.');
        result(id, { stopReason: 'end_turn' });
        steeringId = undefined;
        break;
      }
      promptId = id;
      if (titleHelper) {
        const { firstMessage } = JSON.parse(prompt.split('\n').at(-1));
        if (firstMessage === 'tool attempt') {
          update({ sessionUpdate: 'tool_call', ...permission, status: 'pending' });
          text('{"title":"Reject This Title"}');
        } else if (firstMessage === 'Review the session list layout') {
          text('{"title":"New session"}');
        } else {
          deepStrictEqual(firstMessage, 'visible prompt');
          text('```json\n{"title":');
          text('"Generated Antigravity Title"}\n```');
        }
        result(id, { stopReason: 'end_turn' });
      } else if (prompt === 'start steer') {
        steeringId = id;
        text('Ready to steer.');
      } else if (prompt === 'background wake' || prompt === 'background stop' || prompt === 'daemon wake') {
        update({ sessionUpdate: 'tool_call', toolCallId: 'command-1', kind: 'execute',
          status: 'in_progress', title: 'Run run_command', rawInput: { CommandLine: 'printf ready', IsDaemon: prompt === 'daemon wake' } });
        result(id, { stopReason: 'end_turn' });
        if (prompt !== 'background stop') deferredWake = setTimeout(() => {
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'command-1', status: 'completed',
            rawOutput: { combinedOutput: 'ready', exitCode: 0 } });
          send({ id: 'wake-permission', method: 'session/request_permission', params: {
            sessionId, toolCall: permission,
            options: [{ kind: 'allow_once', optionId: 'allow' }],
          } });
        }, 350);
      } else if (prompt === 'detached reply') {
        result(id, { stopReason: 'end_turn' });
        deferredWake = setTimeout(() => {
          text('Late native reply');
          update({ sessionUpdate: 'usage_update', used: 15000, size: 1048576 });
        }, 350);
      } else if (prompt === 'subagent') {
        update({ sessionUpdate: 'tool_call', toolCallId: 'native-child-launch', kind: 'other',
          title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Role: 'Reviewer', Prompt: 'Review layout' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'native-child-launch', status: 'completed' });
        result(id, { stopReason: 'end_turn' });
      } else if (prompt === 'update plan') {
        update({ sessionUpdate: 'plan', entries: [{ content: 'Inspect project', status: 'pending' }] });
        update({ sessionUpdate: 'plan', entries: [{ content: 'Inspect project', status: 'completed' }] });
        result(id, { stopReason: 'end_turn' });
      } else if (prompt.startsWith('read attachments\n')) {
        deepStrictEqual(params.prompt.slice(1).map(block => block.type), ['resource', 'resource_link', 'audio']);
        deepStrictEqual(params.prompt[1].resource.text, 'Owned text');
        deepStrictEqual(params.prompt[2].mimeType, 'application/pdf');
        deepStrictEqual(params.prompt[3].data, Buffer.from('Audio fixture').toString('base64'));
        text('Native attachments matched.');
        result(id, { stopReason: 'end_turn' });
      } else if (prompt === 'read client file') {
        deepStrictEqual(fileReadCapability, { readTextFile: true, writeTextFile: false });
        send({ id: 'read-line', method: 'fs/read_text_file',
          params: { sessionId, path: 'README.md', line: 1, limit: 1 } });
        send({ id: 'read-other-session', method: 'fs/read_text_file',
          params: { sessionId: 'another-session', path: 'README.md' } });
        send({ id: 'read-outside', method: 'fs/read_text_file',
          params: { sessionId, path: '../../package.json' } });
      } else if (prompt === 'native choice') {
        send({ id: 'native-choice', method: 'session/request_permission', params: {
          sessionId, toolCall: { toolCallId: 'interaction_123', title: 'Choose a layout?' },
          options: [
            { kind: 'allow_once', optionId: 'grid_id', name: 'Grid' },
            { kind: 'allow_once', optionId: 'list_id', name: 'List' },
          ],
        } });
      } else if (prompt === 'review' || prompt === 'stop') {
        text('Ready ');
        text('to review.');
        update({ sessionUpdate: 'tool_call', ...permission, status: 'pending' });
        send({ id: 'permission', method: 'session/request_permission', params: {
          sessionId, toolCall: permission,
          options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }],
        } });
      } else if (prompt === 'exit') {
        process.exit(1);
      } else if (prompt === 'quota') {
        send({ id, error: { code: -32603, message:
          'RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Your quota will reset after 2h30m0s.' } });
      } else {
        if (prompt === 'expanded prompt' || prompt === 'tool attempt')
          update({ sessionUpdate: 'session_info_update', title: 'Native Antigravity Title' });
        text(prompt === 'report mode' ? `${conversation} in ${mode}` : `${conversation}, ${model}: ${prompt}`);
        update({ sessionUpdate: 'usage_update', used: 12000, size: 1048576 });
        result(id, { stopReason: 'end_turn' });
      }
      break;
    }
    case 'session/cancel':
      clearTimeout(deferredWake);
      // Finish after receiving the cancellation response to the permission.
      break;
    default:
      if (id === 'read-line' || id === 'read-other-session' || id === 'read-outside') {
        if (id === 'read-line') deepStrictEqual(message.result, { content: '# Antigravity runtime' });
        else deepStrictEqual(message.error.code, -32603);
        fileReadCapability.answered = (fileReadCapability.answered ?? 0) + 1;
        if (fileReadCapability.answered === 3) {
          text('Scoped file read completed.');
          result(promptId, { stopReason: 'end_turn' });
        }
      } else if (id === 'wake-permission') {
        deepStrictEqual(message.result.outcome, { outcome: 'selected', optionId: 'allow' });
        text('Background wake handled.');
        update({ sessionUpdate: 'usage_update', used: 12000, size: 1048576 });
      } else if (id === 'native-choice') {
        deepStrictEqual(message.result.outcome, { outcome: 'selected', optionId: 'list_id' });
        text('Selected List.');
        result(promptId, { stopReason: 'end_turn' });
      } else if (id === 'permission' && message.result.outcome.outcome === 'cancelled') {
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
