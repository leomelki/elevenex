import type { EnvironmentContext, EnvironmentSelection, EnvironmentSnapshot } from '@elevenex/shared';
import { WorkspaceResume } from './workspace-resume';

const environment: EnvironmentSelection = { kind: 'local' };
const context: EnvironmentContext = { projectId: 1, taskId: 2, sessionId: 3, draft: 'input', cursor: null };
const snapshot = (context: EnvironmentContext): EnvironmentSnapshot => ({ selection: environment, context, connection: null, challenge: null, forwards: [] });

it('coalesces saves while a write is pending and dispatches the newest snapshot before exit', async () => {
  let complete!: (value: EnvironmentSnapshot) => void;
  const bridge = { environmentStatus: vi.fn(async () => snapshot(context)), saveEnvironmentContext: vi.fn(async () => snapshot(context)) };
  bridge.saveEnvironmentContext.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const resume = new WorkspaceResume(bridge);
  let active = true;
  await resume.load(environment, () => active);
  resume.save({ ...context, sessionId: 4 }, environment, () => active);
  resume.save({ ...context, sessionId: 5 }, environment, () => active);
  resume.save({ ...context, sessionId: 6 }, environment, () => active);
  expect(bridge.saveEnvironmentContext).toHaveBeenCalledTimes(1);
  resume.flushBeforeExit(); active = false;
  expect(bridge.saveEnvironmentContext).toHaveBeenCalledTimes(2);
  expect(bridge.saveEnvironmentContext).toHaveBeenLastCalledWith({ ...context, sessionId: 6 }, environment);
  complete(snapshot(context)); await Promise.resolve();
});

it('drops pending writes and late load replies when their backend owner is replaced', async () => {
  let complete!: (value: EnvironmentSnapshot) => void;
  let active = true;
  const bridge = { environmentStatus: vi.fn(() => new Promise<EnvironmentSnapshot>(resolve => { complete = resolve; })), saveEnvironmentContext: vi.fn(async () => snapshot(context)) };
  const resume = new WorkspaceResume(bridge);
  const loading = resume.load(environment, () => active);
  active = false; resume.reset(); complete(snapshot(context));
  expect(await loading).toBeNull();
  resume.save(context, environment, () => true);
  expect(bridge.saveEnvironmentContext).not.toHaveBeenCalled();
});
