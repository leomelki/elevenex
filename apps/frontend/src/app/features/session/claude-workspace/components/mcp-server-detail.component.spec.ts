import { TestBed } from '@angular/core/testing';
import { McpServerDetailComponent } from './mcp-server-detail.component';

describe('MCP server actions', () => {
  it('retains a tool search during polling and clears removal confirmation when selecting another server', () => {
    TestBed.configureTestingModule({ imports: [McpServerDetailComponent] });
    const fixture = TestBed.createComponent(McpServerDetailComponent);
    const entry = {
      entryId: 'first',
      name: 'docs',
      scope: 'project',
      transport: 'http',
      enabled: true,
      connectionStatus: 'connected',
      configStatus: 'valid',
      configLocation: '/tmp/config.toml',
      tools: [{ name: 'search', displayName: 'Search docs' }],
      actions: {
        canToggle: false,
        canRemove: true,
        canRecheck: false,
        canAuth: false,
        canReauth: false,
        canViewTools: true,
      },
    };
    fixture.componentRef.setInput('entry', entry);
    fixture.detectChanges();
    fixture.componentInstance.toolQuery.set('search');
    fixture.componentInstance.removing.set(true);
    fixture.componentRef.setInput('entry', { ...entry });
    fixture.detectChanges();
    expect(fixture.componentInstance.toolQuery()).toBe('search');
    expect(fixture.componentInstance.removing()).toBe(true);
    fixture.componentRef.setInput('entry', { ...entry, entryId: 'second' });
    fixture.detectChanges();
    expect(fixture.componentInstance.removing()).toBe(false);
  });

  it('requires inline confirmation before removing a scoped server', () => {
    TestBed.configureTestingModule({ imports: [McpServerDetailComponent] });
    const fixture = TestBed.createComponent(McpServerDetailComponent);
    const entry = {
      entryId: 'codex:project:docs',
      name: 'docs',
      scope: 'project',
      transport: 'http',
      configLocation: '/tmp/config.toml',
      enabled: true,
      connectionStatus: 'unknown',
      configStatus: 'valid',
      actions: {
        canToggle: true,
        canRemove: true,
        canEdit: true,
        canRecheck: false,
        canAuth: false,
        canReauth: false,
        canViewTools: false,
      },
    };
    fixture.componentRef.setInput('entry', entry);
    const remove = vi.fn();
    fixture.componentInstance.remove.subscribe(remove);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[aria-label="Remove docs"]').click();
    fixture.detectChanges();
    expect(remove).not.toHaveBeenCalled();
    const confirm = [...fixture.nativeElement.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Remove server'),
    )!;
    confirm.click();
    expect(remove).toHaveBeenCalledWith(entry);
  });
});
