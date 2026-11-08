import {
  assertSubprocessEnvironment,
  ShellEnvironmentProjection,
} from './subprocess-environment.js';

describe('subprocess environment budget', () => {
  it('accepts ordinary tool configuration, credentials, Unicode and absent values unchanged', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      API_TOKEN: 'a-secret',
      CUSTOM: 'héllo 世界',
      MISSING: undefined,
    };
    const previous = { ...env };
    expect(() => assertSubprocessEnvironment(env)).not.toThrow();
    expect(env).toEqual(previous);
  });

  it('counts UTF-8 bytes and reports only bounded names and sizes for oversized values', () => {
    const secret = 'private-secret';
    const env = { API_TOKEN: secret.repeat(6000), SMALL: 'é'.repeat(33000) };
    expect(() => assertSubprocessEnvironment(env)).toThrow(
      /keys=2 bytes=\d+.*API_TOKEN:\d+.*SMALL:\d+/,
    );
    try {
      assertSubprocessEnvironment(env);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain('é');
    }
  });

  it('bounds aggregate environment size even with individually small entries', () => {
    const env = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `VALUE_${index}`,
        'x'.repeat(512),
      ]),
    );
    expect(() => assertSubprocessEnvironment(env)).toThrow(/launch budget/);
  });

  it('bounds and sanitizes diagnostic keys', () => {
    const env = {
      ['BAD\nKEY' + 'x'.repeat(200)]: 'do-not-print-this-value'.repeat(6000),
    };
    let message = '';
    try {
      assertSubprocessEnvironment(env);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('BAD?KEY');
    expect(message).not.toContain('\n');
    expect(message).not.toContain('do-not-print-this-value');
    expect(message.length).toBeLessThan(350);
  });
});

describe('shell environment ownership', () => {
  it('retains the last good projection atomically when the next one is too large', () => {
    const projection = new ShellEnvironmentProjection();
    const target: NodeJS.ProcessEnv = { PATH: '/launch/bin' };
    const baseline = projection.baseline(target);
    projection.apply(target, baseline, {
      PATH: '/launch/bin:/shell/bin',
      TOOL: 'previous',
    });
    const previous = { ...target };
    expect(() =>
      projection.apply(target, projection.baseline(target), {
        PATH: '/invalid',
        TOOL: 'x'.repeat(70000),
      }),
    ).toThrow(/launch budget/);
    expect(target).toEqual(previous);
    expect(projection.baseline(target)).toEqual(baseline);
  });

  it('preserves changes by other owners and restores inherited values for unchanged projections', () => {
    const projection = new ShellEnvironmentProjection();
    const target: NodeJS.ProcessEnv = { PATH: '/launch/bin' };
    projection.apply(target, projection.baseline(target), {
      PATH: '/launch/bin:/shell/bin',
      OWNED: 'shell',
      CHANGED: 'shell',
    });
    target.CHANGED = 'application';
    expect(projection.baseline(target)).toEqual({
      PATH: '/launch/bin',
      CHANGED: 'application',
    });
    projection.apply(target, projection.baseline(target), {
      PATH: '/launch/bin:/new-shell/bin',
      CHANGED: 'application',
    });
    expect(target).toEqual({
      PATH: '/launch/bin:/new-shell/bin',
      CHANGED: 'application',
    });
  });
});
