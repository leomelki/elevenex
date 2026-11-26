import { APP_INPUT_GUIDANCE } from '@elevenex/shared';
import { actionProblem, inputNotice, readProblem, streamProblem } from './app-recovery';

const remote = { machine: 'Studio Mac', remote: true };
const local = { machine: 'MacBook', remote: false };

describe('App recovery guidance', () => {
  it('keeps the host guidance exact when Electron prefixes the IPC error', () => {
    const prefixed = 'Error invoking remote method \'task-app:input\': Error: ' + APP_INPUT_GUIDANCE.permission;
    expect(inputNotice(prefixed, remote).message).toBe(APP_INPUT_GUIDANCE.permission);
    expect(inputNotice(prefixed, remote).next).toContain('keep watching');
    expect(inputNotice(APP_INPUT_GUIDANCE.foreground, remote).next).toContain('Studio Mac');
    expect(inputNotice('Something else', remote)).toEqual({ message: 'Something else', next: '' });
  });

  it('tells the person to check the refreshed status when a mutation has an unknown outcome', () => {
    const unknown = { code: 'outcome-unknown', message: 'The operation may have completed.' } as const;
    for (const kind of ['launch', 'decline', 'stop'] as const) {
      const problem = actionProblem(kind, unknown, { name: 'Dev app', place: remote });
      expect(problem.title).toMatch(/confirm/);
      expect(problem.body).toMatch(/refreshed/);
    }
    expect(actionProblem('launch', unknown, { name: 'Dev app', place: remote }).body).toMatch(/only if the request is still waiting/);
    // A refusal means the host answered, so the wording must not suggest the action may have happened.
    expect(actionProblem('launch', { code: 'http', status: 409, message: 'Conflict' }, { name: 'Dev app', place: remote }).body).toContain('Nothing was launched');
  });

  it('separates local from remote wording and attaches a diagnostic only for transport failures', () => {
    const error = { code: 'transport', message: 'Backend connection failed.' } as const;
    expect(readProblem(error, remote).title).toBe('Can\'t reach Studio Mac');
    expect(readProblem(error, local).title).toContain('this computer');
    expect(readProblem(error, remote).diagnostic).toBe('transport · Backend connection failed.');
    expect(readProblem('interrupted', remote).diagnostic).toBeUndefined();
  });

  it('explains known display endings with the machine and an unknown reason without hiding it', () => {
    const locked = streamProblem('The host screen is locked or capture permission changed.', 'Dev app', remote);
    expect(locked.body).toContain('Studio Mac');
    expect(locked.body).toContain('Screen Recording');
    expect(streamProblem('Display disconnected.', 'Dev app', remote).body).toContain('Display disconnected.');
    expect(streamProblem({ code: 'http', status: 404, message: 'The selected resource no longer exists.' }, 'Dev app', remote).title).toBe('This app is no longer available');
  });
  it('distinguishes host capture/encoding failure from a lost connection or Accessibility', () => {
    const problem = streamProblem('The host could not capture or encode the app window.', 'Dev app', remote);
    expect(problem.title).toBe("Studio Mac couldn't prepare the picture");
    expect(problem.body).toContain('still running');
    expect(problem.body).toContain('Resize its window');
    expect(problem.body).not.toContain('Accessibility');
  });
  it('does not attribute a local decoding failure to a slow connection', () => {
    const problem = streamProblem('The app display was interrupted.', 'Dev app', remote);
    expect(problem.body).toContain("couldn't decode or draw");
    expect(problem.body).not.toContain('connection may be slow');
  });
});
