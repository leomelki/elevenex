import { AntigravityProcessClient } from './antigravity-process-client.js';
import type { AntigravityStreamEvent } from './antigravity-runtime.types.js';

/**
 * Verbatim stdout lines from a live `agy` 1.1.22 session run with
 * `--input-format stream-json --output-format stream-json`. The nesting is the
 * point: every payload sits under a key named after the event rather than
 * flattened onto the envelope, so a consumer reading `line.text_delta`
 * directly sees nothing at all.
 */
const LINES = {
  init: '{"event":"init","conversation_id":"221958ed-c934-4352-a715-39623149f9d2","init":{"cwd":"/private/tmp/ws","tools":["view_file","run_command"],"permission_mode":"request-review"}}',
  userInput:
    '{"event":"step_update","step_update":{"conversation_id":"221958ed","step_index":0,"state":"DONE","step_type":"user_input"}}',
  textDelta:
    '{"event":"step_update","step_update":{"conversation_id":"221958ed","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"hello from agy.\\n","usage":{"input_tokens":13769,"output_tokens":65,"total_tokens":13834}}}',
  toolActive:
    '{"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/ws/src/math.js"}}}}',
  toolDone:
    '{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/ws/src/math.js"},"output":"8 lines, 93 bytes"}}}',
  result:
    '{"event":"result","result":{"conversation_id":"221958ed","status":"SUCCESS","response":"hello from agy.\\n","duration_seconds":1.05,"num_turns":1}}',
  interruptResult:
    '{"event":"result","result":{"conversation_id":"221958ed","status":"ERROR","error":"timeout waiting for response","response":""}}',
};

function collect(client: AntigravityProcessClient, lines: string[]) {
  const events: AntigravityStreamEvent[] = [];
  client.on('step_event', (event: AntigravityStreamEvent) =>
    events.push(event),
  );
  for (const line of lines) {
    (client as unknown as { handleLine: (line: string) => void }).handleLine(
      line,
    );
  }
  return events;
}

describe('AntigravityProcessClient line parsing', () => {
  let client: AntigravityProcessClient;

  beforeEach(() => {
    client = new AntigravityProcessClient({ cwd: '/ws' });
  });

  it('flattens the nested payload onto the envelope', () => {
    const [init, step] = collect(client, [LINES.init, LINES.textDelta]);

    expect(init.type).toBe('init');
    // `conversation_id` lives on the envelope for `init`, the rest under the
    // payload key — both have to survive the flattening.
    expect((init as Record<string, unknown>)['conversation_id']).toBe(
      '221958ed-c934-4352-a715-39623149f9d2',
    );
    expect((init as Record<string, unknown>)['cwd']).toBe('/private/tmp/ws');
    expect((init as Record<string, unknown>)['permission_mode']).toBe(
      'request-review',
    );

    expect(step.type).toBe('step_update');
    expect((step as Record<string, unknown>)['text_delta']).toBe(
      'hello from agy.\n',
    );
    expect((step as Record<string, unknown>)['step_index']).toBe(1);
  });

  it('keeps tool_info intact through the flattening', () => {
    const [active, done] = collect(client, [LINES.toolActive, LINES.toolDone]);

    const activeInfo = (active as Record<string, unknown>)['tool_info'] as {
      name: string;
      parameters: Record<string, unknown>;
      output?: string;
    };
    expect(activeInfo.name).toBe('view_file');
    expect(activeInfo.parameters['AbsolutePath']).toBe('/ws/src/math.js');
    expect(activeInfo.output).toBeUndefined();

    const doneInfo = (done as Record<string, unknown>)['tool_info'] as {
      output?: string;
    };
    expect(doneInfo.output).toBe('8 lines, 93 bytes');
    // Both halves of the call share one step_index — that is the correlation
    // key the transcript uses to render a single card.
    expect((active as Record<string, unknown>)['step_index']).toBe(4);
    expect((done as Record<string, unknown>)['step_index']).toBe(4);
  });

  it('ignores blank and non-JSON lines instead of dying on them', () => {
    const events = collect(client, [
      '',
      '   ',
      'Fetching available models...',
      '[]',
      'null',
      LINES.userInput,
    ]);
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>)['step_type']).toBe(
      'user_input',
    );
  });

  it('resolves the in-flight turn on a result line', async () => {
    const stdin: string[] = [];
    // Minimal stand-in for the spawned child: prompt() only needs a writable
    // stdin, and handleLine is driven directly.
    (client as unknown as { child: unknown }).child = {
      stdin: {
        write: (line: string, cb: (error?: Error) => void) => {
          stdin.push(line);
          cb();
        },
      },
    };

    const turn = client.prompt('hi');
    collect(client, [LINES.textDelta, LINES.result]);
    const result = await turn;

    expect(result.status).toBe('SUCCESS');
    expect(result.response).toBe('hello from agy.\n');
    expect(JSON.parse(stdin[0])).toEqual({
      event: 'user',
      message: { content: 'hi' },
    });
  });

  it('resolves — not rejects — on the ERROR result a SIGINT produces', async () => {
    (client as unknown as { child: unknown }).child = {
      stdin: { write: (_l: string, cb: () => void) => cb() },
    };

    const turn = client.prompt('long task');
    collect(client, [LINES.interruptResult]);
    const result = await turn;

    // The caller decides whether this ERROR is an interrupt; the client just
    // hands it over.
    expect(result.status).toBe('ERROR');
    expect(result.error).toBe('timeout waiting for response');
  });

  it('rejects a prompt when there is no process', async () => {
    await expect(client.prompt('hi')).rejects.toThrow('is not running');
  });

  it('rejects a second concurrent turn on one process', async () => {
    (client as unknown as { child: unknown }).child = {
      stdin: { write: (_l: string, cb: () => void) => cb() },
    };
    const first = client.prompt('one');
    await expect(client.prompt('two')).rejects.toThrow('already in flight');

    collect(client, [LINES.result]);
    await first;
  });
});
