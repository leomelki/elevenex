import { TestBed } from '@angular/core/testing';
import { McpServerEditorComponent } from './mcp-server-editor.component';

describe('MCP server editor', () => {
  const create = () => {
    TestBed.configureTestingModule({ imports: [McpServerEditorComponent] });
    const fixture = TestBed.createComponent(McpServerEditorComponent);
    fixture.componentRef.setInput('definition', {
      name: 'docs',
      scope: 'project',
      transport: 'stdio',
      command: 'npx',
    });
    fixture.detectChanges();
    return fixture.componentInstance;
  };

  it('preserves spaces in arguments and equals signs in secrets', () => {
    const editor = create();
    const save = vi.fn();
    editor.save.subscribe(save);
    editor.form.controls.args.setValue('-y\na directory with spaces');
    editor.form.controls.env.setValue('TOKEN=abc==');
    editor.submit();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['-y', 'a directory with spaces'], env: { TOKEN: 'abc==' } }),
    );
  });

  it('reports duplicate environment variable keys before submitting', () => {
    const editor = create();
    const save = vi.fn();
    editor.save.subscribe(save);
    editor.form.controls.env.setValue('TOKEN=a\nTOKEN=b');
    editor.submit();
    expect(save).not.toHaveBeenCalled();
    expect(editor.error()).toContain('unique KEY=value');
  });

  it('imports an OpenCode command array without shell splitting', () => {
    const editor = create();
    editor.importText.set(
      '{"mcp":{"docs":{"type":"local","command":["node","a script.js"],"environment":{"TOKEN":"key"}}}}',
    );
    editor.importConfiguration();
    expect(editor.form.controls.command.value).toBe('node');
    expect(editor.form.controls.args.value).toBe('a script.js');
    expect(editor.form.controls.env.value).toBe('TOKEN=key');
  });

  it('rejects multi-server snippets instead of silently losing configuration', () => {
    const editor = create();
    editor.importText.set('{"mcpServers":{"a":{},"b":{}}}');
    editor.importConfiguration();
    expect(editor.error()).toBe('Paste one server at a time.');
  });

  it('retains entered fields across transport changes and reports reverted edits as clean', () => {
    const editor = create();
    const dirty = vi.fn();
    editor.dirtyChange.subscribe(dirty);
    editor.form.controls.name.setValue('changed');
    expect(dirty).toHaveBeenLastCalledWith(true);
    editor.transport.set('http');
    TestBed.tick();
    expect(editor.form.controls.name.value).toBe('changed');
    editor.transport.set('stdio');
    editor.form.controls.name.setValue('docs');
    TestBed.tick();
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it('roundtrips empty/newline arguments, quoted literals and multiline environment values', () => {
    TestBed.configureTestingModule({ imports: [McpServerEditorComponent] });
    const fixture = TestBed.createComponent(McpServerEditorComponent);
    const args = ['', 'one\ntwo', '"quoted"', ' leading space', 'last\rvalue'];
    const env = { EMPTY: '', KEY: 'first\nsecond', QUOTED: '"literal"' };
    fixture.componentRef.setInput('definition', {
      name: 'docs',
      scope: 'project',
      transport: 'stdio',
      command: 'node',
      args,
      env,
    });
    fixture.detectChanges();
    const save = vi.fn();
    fixture.componentInstance.save.subscribe(save);
    fixture.componentInstance.submit();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ args, env }));
  });

  it('preserves native options and disabled state from an imported configuration', () => {
    const editor = create();
    const save = vi.fn();
    editor.save.subscribe(save);
    editor.importText.set(
      '{"mcp":{"docs":{"type":"remote","url":"https://example.com/mcp","oauth":false,"timeout":12000,"enabled":false}}}',
    );
    editor.importConfiguration();
    editor.submit();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ nativeOptions: { oauth: false, timeout: 12000 }, enabled: false }),
    );
  });

  it('rejects non-string imported arguments and environment values without changing the form', () => {
    const editor = create();
    editor.importText.set('{"command":"node","args":[5]}');
    editor.importConfiguration();
    expect(editor.error()).toContain('must be strings');
    expect(editor.form.controls.command.value).toBe('npx');
    editor.importText.set('{"command":"node","env":{"KEY":5}}');
    editor.importConfiguration();
    expect(editor.error()).toContain('must contain string values');
    expect(editor.form.controls.command.value).toBe('npx');
  });
});
