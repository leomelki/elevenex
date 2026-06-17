import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { notifyUserTool } from '../tools/human/notify-user.tool.js';
import { showUserTool } from '../tools/human/show-user.tool.js';
import { requestApprovalTool } from '../tools/human/request-approval.tool.js';
import { escalateToUserTool } from '../tools/human/escalate-to-user.tool.js';
import type { ToolContext } from '../tool-registry/tool.types.js';

function makeCtx(
  channel: AgentHumanChannelService,
  opts: { agentSessionId?: number | null; canUseHumanChannel?: boolean } = {},
): ToolContext {
  const agentSessionId = opts.agentSessionId ?? 42;
  return {
    services: {} as never,
    agentSessionId,
    caps: {
      isAgent: agentSessionId !== null,
      canMutate: true,
      canDestroy: agentSessionId !== null,
      canUseHumanChannel: opts.canUseHumanChannel ?? agentSessionId !== null,
    },
    cursors: new DeltaCursorStore(),
    deepLink: new DeepLinkBuilder(),
    human: channel.bindFor({
      agentSessionId,
      canUseHumanChannel: opts.canUseHumanChannel ?? agentSessionId !== null,
    }),
    signal: new AbortController().signal,
    mcpSessionId: 't',
  };
}

describe('human-channel tools', () => {
  it('notify_user emits a notification and returns non-blocking', async () => {
    const channel = new AgentHumanChannelService();
    const events: unknown[] = [];
    channel.on('notification', (n) => events.push(n));
    const ctx = makeCtx(channel);

    const result = await notifyUserTool.handler(
      { message: 'done', level: 'success', sessionId: 7 } as never,
      ctx,
    );
    expect((result.data as { notified: boolean }).notified).toBe(true);
    expect(result.deepLink).toBe('/sessions/7');
    expect(events).toHaveLength(1);
  });

  it('show_user emits a show card', async () => {
    const channel = new AgentHumanChannelService();
    const shows: unknown[] = [];
    channel.on('show', (s) => shows.push(s));
    const ctx = makeCtx(channel);

    await showUserTool.handler({ title: 'Summary', body: 'x' } as never, ctx);
    expect(shows).toHaveLength(1);
  });

  it('request_approval blocks until the human answers, then returns the decision', async () => {
    const channel = new AgentHumanChannelService();
    const ctx = makeCtx(channel);

    // Resolve the approval as soon as it is raised.
    channel.on('approval', (a: { id: string }) =>
      channel.resolveApproval({ id: a.id, decision: 'approve' }),
    );

    const result = await requestApprovalTool.handler(
      { title: 'Push branch', timeoutMs: 5000 } as never,
      ctx,
    );
    const data = result.data as { decision: string; approved: boolean };
    expect(data.decision).toBe('approve');
    expect(data.approved).toBe(true);
  });

  it('request_approval resolves to denied on timeout', async () => {
    const channel = new AgentHumanChannelService();
    const ctx = makeCtx(channel);
    const result = await requestApprovalTool.handler(
      { title: 'risky', timeoutMs: 1000 } as never,
      ctx,
    );
    expect((result.data as { approved: boolean }).approved).toBe(false);
    expect((result.data as { decision: string }).decision).toBe('denied');
  });

  it('escalate_to_user returns the chosen direction', async () => {
    const channel = new AgentHumanChannelService();
    const ctx = makeCtx(channel);
    channel.on('approval', (a: { id: string }) =>
      channel.resolveApproval({ id: a.id, decision: 'proceed' }),
    );
    const result = await escalateToUserTool.handler(
      { blockedOn: 'which repo?', options: ['proceed', 'stop'], timeoutMs: 5000 } as never,
      ctx,
    );
    expect((result.data as { choice: string }).choice).toBe('proceed');
  });

  it('denies the human channel to anonymous (no agent session) callers', async () => {
    const channel = new AgentHumanChannelService();
    const ctx = makeCtx(channel, { agentSessionId: null, canUseHumanChannel: false });
    await expect(
      notifyUserTool.handler({ message: 'x', level: 'info' } as never, ctx),
    ).rejects.toMatchObject({ code: 'human_channel_unavailable' });
  });

  it('pendingApprovals tracks unresolved escalations for panel replay', async () => {
    const channel = new AgentHumanChannelService();
    const ctx = makeCtx(channel);
    // Start an approval but don't resolve it yet.
    const pending = requestApprovalTool.handler(
      { title: 'wait', timeoutMs: 5000 } as never,
      ctx,
    );
    // Give the microtask queue a tick so the request registers.
    await Promise.resolve();
    const open = channel.pendingApprovals(42);
    expect(open).toHaveLength(1);
    channel.resolveApproval({ id: open[0].id, decision: 'approve' });
    await pending;
    expect(channel.pendingApprovals(42)).toHaveLength(0);
  });
});
