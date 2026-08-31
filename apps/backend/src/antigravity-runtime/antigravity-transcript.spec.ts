import {
  canonicalizeAntigravityTool,
  toolInfoErrorMessage,
  toolInfoIsComplete,
  toolInfoResultText,
} from './antigravity-transcript.js';

/**
 * Every payload here was captured from a live `agy` 1.1.22 run driving
 * `--input-format stream-json --output-format stream-json`, so the parameter
 * spellings are the real ones rather than what the docs imply. `agy` uses
 * PascalCase keys (`AbsolutePath`, `CommandLine`) and its own tool names
 * (`view_file`, not `Read`), which is exactly what the mapping exists to
 * absorb — without it these all fell through to the `unknown` card.
 */
describe('canonicalizeAntigravityTool', () => {
  it.each([
    [
      'view_file',
      { AbsolutePath: '/ws/src/math.js' },
      'read',
      'Read',
      '/ws/src/math.js',
    ],
    ['list_dir', { DirectoryPath: '/ws' }, 'glob', 'List', undefined],
    [
      'find_by_name',
      { Pattern: '*.md', SearchDirectory: '/ws' },
      'glob',
      'Glob',
      undefined,
    ],
    [
      'grep_search',
      { Query: 'add', SearchPath: '/ws' },
      'grep',
      'Grep',
      undefined,
    ],
    ['run_command', { CommandLine: 'ls -1' }, 'bash', 'Bash', undefined],
    [
      'write_to_file',
      { TargetFile: '/ws/notes.md' },
      'write',
      'Write',
      '/ws/notes.md',
    ],
    [
      'replace_file_content',
      { TargetFile: '/ws/src/math.js' },
      'edit',
      'Edit',
      '/ws/src/math.js',
    ],
    [
      'sed_file',
      { TargetFile: '/ws/src/math.js' },
      'edit',
      'Edit',
      '/ws/src/math.js',
    ],
    [
      'read_url_content',
      { Url: 'https://example.com' },
      'web_fetch',
      'WebFetch',
      undefined,
    ],
    ['search_web', { query: 'node lts' }, 'web_search', 'WebSearch', undefined],
    ['ask_question', {}, 'ask_user_question', 'Question', undefined],
  ])(
    '%s maps onto the shared taxonomy',
    (name, parameters, kind, displayName, filePath) => {
      const result = canonicalizeAntigravityTool({ name, parameters });

      expect(result.toolKind).toBe(kind);
      expect(result.toolDisplayName).toBe(displayName);
      // The raw `agy` name is what the card shows as the provider tool, so it
      // survives the rewrite.
      expect(result.providerToolName).toBe(name);
      if (filePath !== undefined) {
        expect((result.toolInput as { file_path?: string }).file_path).toBe(
          filePath,
        );
      }
    },
  );

  it('renames parameters onto the keys the tool cards read', () => {
    const bash = canonicalizeAntigravityTool({
      name: 'run_command',
      parameters: { CommandLine: 'ls -1', Cwd: '/ws' },
    }).toolInput as Record<string, unknown>;
    expect(bash['command']).toBe('ls -1');
    expect(bash['cwd']).toBe('/ws');
    // Originals are kept so the raw parameter view stays complete.
    expect(bash['CommandLine']).toBe('ls -1');

    const grep = canonicalizeAntigravityTool({
      name: 'grep_search',
      parameters: { Query: 'add', SearchPath: '/ws' },
    }).toolInput as Record<string, unknown>;
    expect(grep['pattern']).toBe('add');
    expect(grep['path']).toBe('/ws');

    // `list_dir` has no pattern of its own; the directory doubles as the
    // card's one-line target.
    const list = canonicalizeAntigravityTool({
      name: 'list_dir',
      parameters: { DirectoryPath: '/ws' },
    }).toolInput as Record<string, unknown>;
    expect(list['path']).toBe('/ws');
    expect(list['pattern']).toBe('/ws');
  });

  it('leaves a tool with no shared counterpart as unknown, name intact', () => {
    const result = canonicalizeAntigravityTool({
      name: 'browser_click_element',
      parameters: { ElementIndex: 3 },
    });
    expect(result.toolKind).toBe('unknown');
    expect(result.toolDisplayName).toBe('browser_click_element');
    expect(result.providerToolName).toBe('browser_click_element');
  });

  it('survives a missing name and non-object parameters', () => {
    expect(canonicalizeAntigravityTool({}).providerToolName).toBe('Tool');
    expect(
      canonicalizeAntigravityTool({ name: 'view_file', parameters: 'nope' })
        .toolKind,
    ).toBe('read');
  });
});

describe('tool_info readers', () => {
  // `agy` reports failures as an object, not a string — the exact shape
  // captured from a failed `view_file`.
  const failure = {
    name: 'view_file',
    parameters: { AbsolutePath: '/ws/missing.js' },
    error: {
      type: 'TOOL_ERROR',
      message:
        'declaring permissions: cortex tool view_file: failed to read file: no such file or directory',
    },
  };

  it('reads the message out of an error object', () => {
    expect(toolInfoErrorMessage(failure)).toContain(
      'no such file or directory',
    );
    expect(toolInfoResultText(failure)).toContain('no such file or directory');
    expect(toolInfoIsComplete(failure)).toBe(true);
  });

  it('falls back to the error type when there is no message', () => {
    expect(toolInfoErrorMessage({ error: { type: 'TOOL_ERROR' } })).toBe(
      'TOOL_ERROR',
    );
    expect(toolInfoErrorMessage({ error: {} })).toBe('Tool call failed.');
  });

  it('still accepts a plain string error', () => {
    expect(toolInfoErrorMessage({ error: 'boom' })).toBe('boom');
  });

  it('treats an in-flight call as incomplete', () => {
    // The `ACTIVE` half of a tool step carries parameters only.
    expect(
      toolInfoIsComplete({
        name: 'view_file',
        parameters: { AbsolutePath: '/a' },
      }),
    ).toBe(false);
    expect(toolInfoErrorMessage({ name: 'view_file' })).toBeNull();
    expect(toolInfoResultText({ name: 'view_file' })).toBe('');
  });

  it('treats an empty output string as a settled call', () => {
    // `run_command` settles as DONE with `output: ""` for a silent command.
    expect(toolInfoIsComplete({ name: 'run_command', output: '' })).toBe(true);
  });
});
