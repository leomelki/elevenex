import type { BackendResult, WorkspaceRevision } from '@elevenex/shared';
import { WorkspaceAppReveal } from './workspace-app-reveal';

const reply = (revision: number): BackendResult<WorkspaceRevision> => ({
  ok: true, value: { revision, version: 1, appOpens: [
    { revision: revision - 1, taskId: 3, sessionId: 9, runId: 'older' },
    { revision, taskId: 3, sessionId: 17, runId: 'unrelated' },
    { revision, taskId: 3, sessionId: 9, runId: 'newest' },
  ] },
});
it('reveals matching fresh app launches once across foreground waits, skipping past or background events', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  let selected = { scopeId: 'scope', taskId: 3, sessionId: 9 };
  const open = vi.fn(), read = vi.fn(async () => reply(4));
  const reveal = new WorkspaceAppReveal(document, () => selected, open);
  try {
    await reveal.wait('scope', 1, read, async () => reply(2));
    expect(open).not.toHaveBeenCalled();
    await reveal.wait('scope', 4, read, async () => reply(6));
    await reveal.wait('scope', 4, read, async () => reply(6));
    expect(open).toHaveBeenCalledExactlyOnceWith({ ...selected, runId: 'newest' });
    const loseFocus = async () => { window.dispatchEvent(new Event('blur')); return reply(7); };
    await reveal.wait('scope', 6, read, loseFocus);
    await reveal.wait('scope', 7, read, async () => reply(8));
    selected = { ...selected, sessionId: 17 };
    await reveal.wait('scope', 7, read, async () => reply(9));
    expect(read).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenCalledTimes(1);
  } finally { reveal.dispose(); vi.restoreAllMocks(); }
});
