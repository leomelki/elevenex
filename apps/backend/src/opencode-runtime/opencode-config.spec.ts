import { mergeOpenCodeConfig } from './opencode-config.js';

describe('OpenCode inline configuration', () => {
  it('preserves user models, plugins, and MCP servers when adding mission configuration', () => {
    const result: unknown = JSON.parse(
      mergeOpenCodeConfig(
        JSON.stringify({
          model: 'local/model',
          plugins: ['custom'],
          mcp: { servers: { project: { type: 'local', command: ['tool'] } } },
        }),
        {
          mcp: {
            servers: { elevenex: { type: 'remote', url: 'http://localhost' } },
          },
        },
      ),
    );
    expect(result).toEqual({
      model: 'local/model',
      plugins: ['custom'],
      mcp: {
        servers: {
          project: { type: 'local', command: ['tool'] },
          elevenex: { type: 'remote', url: 'http://localhost' },
        },
      },
    });
  });
  it('replaces permission arrays and reports invalid inherited config', () => {
    expect(
      JSON.parse(
        mergeOpenCodeConfig('{"permissions":["old"]}', {
          permissions: ['new'],
        }),
      ) as { permissions: string[] },
    ).toEqual({ permissions: ['new'] });
    expect(() => mergeOpenCodeConfig('invalid', {})).toThrow();
  });
});
