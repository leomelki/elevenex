import { inferLogLevelFromMessage } from './log-interceptor.js';

describe('inferLogLevelFromMessage', () => {
  it.each([
    ['LOG', 'log'],
    ['ERROR', 'error'],
    ['WARN', 'warn'],
    ['DEBUG', 'debug'],
    ['VERBOSE', 'verbose'],
    ['FATAL', 'fatal'],
  ] as const)('infers Nest %s output as %s', (nestLevel, expectedLevel) => {
    expect(
      inferLogLevelFromMessage(
        `[Nest] 12345  - 05/06/2026, 10:00:00 AM     ${nestLevel} [TestContext] message`,
      ),
    ).toBe(expectedLevel);
  });

  it('infers levels from colorized Nest output', () => {
    expect(
      inferLogLevelFromMessage(
        '\u001b[32m[Nest] 12345  - \u001b[39m05/06/2026, 10:00:00 AM \u001b[95m  DEBUG\u001b[39m message',
      ),
    ).toBe('debug');
  });

  it('infers levels from structured JSON output', () => {
    expect(
      inferLogLevelFromMessage('{"level":"warning","message":"heads up"}'),
    ).toBe('warn');
  });

  it('does not infer a level from unrelated output', () => {
    expect(inferLogLevelFromMessage('plain process output')).toBeNull();
  });
});
