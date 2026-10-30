import { chatPlanUsage } from './desktop-chat-usage.js';

const usage = {
  provider: 'codex',
  planName: 'Plus',
  status: 'warning',
  updatedAt: '2026-10-30T10:00:00Z',
  windows: [
    {
      id: 'primary',
      label: '5-hour limit',
      remainingPercentage: 12,
      resetsAt: 1793368800,
    },
  ],
};
describe('desktop subscription allowance', () => {
  it('projects only subscription facts and drops secrets and unsupported providers', () => {
    const raw = {
      planUsage: { ...usage, secret: 'private' },
      authStatus: { authMethod: 'oauth' },
    };
    expect(chatPlanUsage(raw, 'codex')).toEqual(usage);
    expect(chatPlanUsage(raw, 'claude')).toBeNull();
    expect(chatPlanUsage(raw, 'pi')).toBeNull();
    expect(
      chatPlanUsage({ ...raw, authStatus: { authMethod: 'api-key' } }, 'codex'),
    ).toBeNull();
    expect(chatPlanUsage({ ...raw, authStatus: null }, 'codex')).toBeNull();
    expect(
      chatPlanUsage(
        {
          sessionMetadata: { apiKeySource: 'oauth' },
          planUsage: { ...usage, provider: 'claude' },
        },
        'claude',
      )?.provider,
    ).toBe('claude');
  });
  it('bounds windows, rejects invalid percentages and never invents quota for unknown windows', () => {
    const project = (windows: unknown[]) =>
      chatPlanUsage(
        {
          authStatus: { authMethod: 'oauth' },
          planUsage: { ...usage, windows },
        },
        'codex',
      );
    expect(
      project([{}, { ...usage.windows[0], remainingPercentage: NaN }]),
    ).toBeNull();
    expect(
      project([{ ...usage.windows[0], remainingPercentage: -1 }]),
    ).toBeNull();
    expect(
      project([{ ...usage.windows[0], resetsAt: Infinity }])?.windows[0]
        .resetsAt,
    ).toBeNull();
    expect(
      project(
        Array.from({ length: 100 }, (_, i) => ({
          ...usage.windows[0],
          id: String(i),
        })),
      )?.windows,
    ).toHaveLength(8);
    expect(project([usage.windows[0], usage.windows[0]])?.windows).toHaveLength(
      1,
    );
  });
});
