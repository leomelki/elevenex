import { describe, expect, it } from 'vitest';
import { buildElevenexToolView, elevenexLink } from './elevenex-tool-view';
import { desktopHttpUrl } from './port-forwarding-receipt';
import { describeAgentTool } from './agent-tool-format';

const forward = {
  id: 12,
  projectId: 5,
  name: 'Preview',
  bindAddress: '127.0.0.1',
  localPort: 5174,
  remoteHost: 'localhost',
  remotePort: 5173,
  connectionLabel: 'Dev server',
  status: 'active',
  running: true,
  localUrl: 'http://127.0.0.1:5174',
  lastError: null,
  createdBySession: { sessionId: 42, sessionName: 'Preview agent' },
};
const view = (tool = 'create_port_forward', data: Record<string, unknown> = {}, extra = {}) =>
  buildElevenexToolView(
    { toolName: `mcp__elevenex__${tool}`, toolInput: { remotePort: 5173, localPort: 5174 } },
    {
      content: JSON.stringify({
        data: { projectId: 5, forwards: [forward], total: 1, nextOffset: null, ...data },
        deepLink: '/projects/5#ssh-forwarding',
        ...extra,
      }),
    },
  );

describe('Port-forwarding chat receipts', () => {
  it('names the operation, shows the route and links to the correct project section', () => {
    expect(
      describeAgentTool({
        toolName: 'mcp__elevenex__create_port_forward',
        toolInput: { remotePort: 5173 },
      }),
    ).toMatchObject({ verb: 'Create port forward', target: '5173 → localhost:5173' });
    expect(view()).toMatchObject({
      summary: { text: 'Listening', tone: 'ok' },
      target: '127.0.0.1:5174 → localhost:5173',
      link: '/projects/5#ssh-forwarding',
      linkLabel: 'Open Ports',
    });
    expect(view()?.portForwarding?.forwards[0]).toMatchObject({
      localAddress: '127.0.0.1:5174',
      remoteAddress: 'localhost:5173',
      creator: { name: 'Preview agent', link: '/sessions/42' },
    });
  });
  it('shows saved, reused, failed, stopped and removed outcomes accurately', () => {
    expect(view('create_port_forward', { reused: true })?.summary?.text).toBe(
      'Existing forward · listening',
    );
    expect(
      view('create_port_forward', {
        forwards: [{ ...forward, status: 'inactive', running: false }],
      })?.summary?.text,
    ).toBe('Saved · Not started');
    const failed = view('create_port_forward', {
      forwards: [{ ...forward, status: 'error', running: false, lastError: 'Port occupied' }],
    });
    expect(failed?.summary).toEqual({ text: 'Could not start', tone: 'error' });
    expect(failed?.portForwarding?.forwards[0]).toMatchObject({
      error: 'Port occupied',
      httpUrl: undefined,
    });
    expect(
      view('stop_port_forward', { forwards: [{ ...forward, status: 'inactive', running: false }] })
        ?.summary?.text,
    ).toBe('Forward stopped');
    expect(view('remove_port_forward', { removed: true, forwards: [] })?.summary).toEqual({
      text: 'Forward removed',
      tone: 'ok',
    });
  });
  it('distinguishes a running listener with connection errors from a failed start', () => {
    expect(
      view('get_port_forward', { forwards: [{ ...forward, status: 'error' }] })?.portForwarding
        ?.forwards[0].status.text,
    ).toBe('Listener needs attention');
    expect(
      view('get_port_forward', { forwards: [{ ...forward, status: 'connecting' }] })?.summary?.tone,
    ).toBe('warn');
  });
  it('does not report a stop as successful when the listener remains open', () => {
    expect(view('stop_port_forward')?.summary).toEqual({ text: 'Still listening', tone: 'warn' });
  });
  it('shows desktop discovery and empty lists without claiming forwarding succeeded', () => {
    expect(view('list_port_forwards', { available: false, forwards: [] })?.summary).toEqual({
      text: 'Desktop not connected',
      tone: 'warn',
    });
    expect(
      view('list_port_forwards', {
        selectionRequired: true,
        forwards: [],
        desktops: [{ desktopId: 'a', connectionLabel: 'Studio', mode: 'paired' }],
      })?.portForwarding?.desktops,
    ).toEqual([{ id: 'a', label: 'Studio', mode: 'Paired desktop' }]);
    expect(view('list_port_forwards', { forwards: [] })?.portForwarding?.emptyText).toContain(
      'No port forwards',
    );
  });
  it('bounds receipt rows while retaining total counts and pagination', () => {
    const result = view('list_port_forwards', {
      forwards: Array.from({ length: 25 }, (_, id) => ({ ...forward, id })),
      total: 100,
      nextOffset: 25,
    });
    expect(result?.portForwarding?.forwards).toHaveLength(20);
    expect(result?.summary?.text).toBe('25 of 100 forwards');
    expect(result?.more).toBe(true);
    const errorsBeyondPreview = view('list_port_forwards', { forwards: Array.from({ length: 25 }, (_, id) => ({ ...forward, id, status: id === 24 ? 'error' : 'active' })) });
    expect(errorsBeyondPreview?.portForwarding?.needsAttention).toBe(true);
  });
  it('keeps recovery and the Ports link available when a default-scoped request fails', () => {
    const failed = buildElevenexToolView(
      { toolName: 'mcp__elevenex__start_port_forward' },
      {
        isError: true,
        content: {
          error: { code: 'desktop_timeout', message: 'No response', details: { projectId: 5 } },
        },
      },
    );
    expect(failed).toMatchObject({
      link: '/projects/5#ssh-forwarding',
      summary: { tone: 'error' },
      error: { remediation: expect.stringContaining('Check Ports') },
    });
  });
  it('allows known application fragments and only matching loopback HTTP links', () => {
    expect(elevenexLink('/projects/5#ssh-forwarding')).toBe('/projects/5#ssh-forwarding');
    expect(elevenexLink('/projects/5#unknown')).toBeUndefined();
    expect(elevenexLink('javascript:alert(1)')).toBeUndefined();
    expect(desktopHttpUrl('http://[::1]:5174', 5174)).toBe('http://[::1]:5174');
    for (const url of [
      'javascript:alert(1)',
      'https://evil.com:5174',
      'http://evil.com:5174',
      'http://user@localhost:5174',
      'http://localhost:5174/path',
      'http://localhost:5175',
    ])
      expect(desktopHttpUrl(url, 5174)).toBeUndefined();
  });
});
