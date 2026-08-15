import {
  canonicalizeGeminiTool,
  contentBlockToText,
  isModeUpdateChunk,
  planEntriesToMarkdown,
  stripSessionContext,
  toolCallContentToText,
  toolCallPaths,
} from './gemini-transcript.js';
import type { AcpToolCall } from './gemini-runtime.types.js';

describe('isModeUpdateChunk', () => {
  // session/set_mode echoes this synthetic chunk; it is not model output.
  it('detects the synthetic mode echo', () => {
    expect(isModeUpdateChunk('[MODE_UPDATE] plan')).toBe(true);
    expect(isModeUpdateChunk('  [MODE_UPDATE] yolo')).toBe(true);
  });

  it('leaves ordinary prose alone', () => {
    expect(isModeUpdateChunk('Here is the plan:')).toBe(false);
    expect(isModeUpdateChunk('We updated [MODE_UPDATE] handling')).toBe(false);
  });
});

describe('stripSessionContext', () => {
  it('removes the injected context preamble and keeps the real prompt', () => {
    const text =
      '<session_context>\nToday is...\nDirectory Structure:\n- a\n</session_context>\nfix the login bug';
    expect(stripSessionContext(text)).toBe('fix the login bug');
  });

  it('removes every occurrence', () => {
    expect(
      stripSessionContext(
        '<session_context>a</session_context>hi<session_context>b</session_context>',
      ),
    ).toBe('hi');
  });

  it('is a no-op when there is no preamble', () => {
    expect(stripSessionContext('just a prompt')).toBe('just a prompt');
  });
});

describe('contentBlockToText', () => {
  it('reads text blocks', () => {
    expect(contentBlockToText({ type: 'text', text: 'hello' })).toBe('hello');
  });

  it('renders a resource link as markdown', () => {
    expect(
      contentBlockToText({
        type: 'resource_link',
        uri: 'file:///a',
        name: 'a',
      }),
    ).toBe('[a](file:///a)');
  });

  it('returns empty for blocks with no text, rather than throwing', () => {
    expect(
      contentBlockToText({ type: 'image', mimeType: 'image/png', data: 'x' }),
    ).toBe('');
    expect(contentBlockToText(undefined)).toBe('');
  });
});

describe('canonicalizeGeminiTool', () => {
  it("maps Gemini's own tool names onto the shared taxonomy", () => {
    const call: AcpToolCall = {
      toolCallId: '1',
      title: 'read_file',
      kind: 'read',
      rawInput: { path: '/repo/a.ts' },
    };
    const result = canonicalizeGeminiTool(call);
    expect(result.toolKind).toBe('read');
    expect(result.providerToolName).toBe('read_file');
    expect((result.toolInput as Record<string, unknown>)['file_path']).toBe(
      '/repo/a.ts',
    );
  });

  it("maps Gemini's `replace` edit tool onto the edit card", () => {
    expect(
      canonicalizeGeminiTool({
        toolCallId: '1',
        title: 'replace',
        kind: 'edit',
      }).toolKind,
    ).toBe('edit');
  });

  it('maps run_shell_command onto the bash card', () => {
    expect(
      canonicalizeGeminiTool({
        toolCallId: '1',
        title: 'run_shell_command',
        kind: 'execute',
        rawInput: { command: 'ls' },
      }).toolKind,
    ).toBe('bash');
  });

  it('falls back to the ACP kind when the title is a human sentence', () => {
    const result = canonicalizeGeminiTool({
      toolCallId: '1',
      title: 'Searching the workspace for TODOs',
      kind: 'search',
    });
    expect(result.toolKind).toBe('grep');
    // The human title is still what the card shows.
    expect(result.toolDisplayName).toBe('Searching the workspace for TODOs');
  });

  it('prefers an explicit tool name in _meta over the title', () => {
    const call = {
      toolCallId: '1',
      title: 'Reading a file',
      kind: 'other',
      _meta: { toolName: 'read_file' },
    } as unknown as AcpToolCall;
    expect(canonicalizeGeminiTool(call).toolKind).toBe('read');
  });

  it('degrades to unknown rather than guessing', () => {
    const result = canonicalizeGeminiTool({
      toolCallId: '1',
      title: 'Thinking about it',
      kind: 'think',
    });
    expect(result.toolKind).toBe('unknown');
  });
});

describe('toolCallContentToText', () => {
  it('joins content blocks', () => {
    expect(
      toolCallContentToText([
        { type: 'content', content: { type: 'text', text: 'a' } },
        { type: 'content', content: { type: 'text', text: 'b' } },
      ]),
    ).toBe('a\n\nb');
  });

  it('renders a diff with its path header', () => {
    const text = toolCallContentToText([
      { type: 'diff', path: '/repo/a.ts', oldText: 'old', newText: 'new' },
    ]);
    expect(text).toContain('--- /repo/a.ts');
    expect(text).toContain('-old');
    expect(text).toContain('+new');
  });

  it('returns empty for no content', () => {
    expect(toolCallContentToText(undefined)).toBe('');
    expect(toolCallContentToText([])).toBe('');
  });
});

describe('toolCallPaths', () => {
  it('collects paths from locations and diffs without duplicates', () => {
    expect(
      toolCallPaths({
        toolCallId: '1',
        locations: [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }],
        content: [{ type: 'diff', path: '/repo/a.ts', newText: 'x' }],
      }),
    ).toEqual(['/repo/a.ts', '/repo/b.ts']);
  });
});

describe('planEntriesToMarkdown', () => {
  it('renders statuses as a checklist', () => {
    expect(
      planEntriesToMarkdown([
        { content: 'done thing', status: 'completed' },
        { content: 'doing thing', status: 'in_progress' },
        { content: 'todo thing', status: 'pending' },
      ]),
    ).toBe('- [x] done thing\n- [~] doing thing\n- [ ] todo thing');
  });

  it('returns empty for an empty plan', () => {
    expect(planEntriesToMarkdown([])).toBe('');
  });
});
