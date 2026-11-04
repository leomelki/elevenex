import { privateBrowserLoggingEnabled } from './runtime-browser-pool.js';
describe('Browser protocol logging privacy', () => {
  it('withholds a browser when debug settings would expose input or frame payloads', () => {
    expect(privateBrowserLoggingEnabled({ DEBUG: 'pw:protocol' })).toBe(true);
    expect(privateBrowserLoggingEnabled({ DEBUG: 'pw:*' })).toBe(true);
    expect(privateBrowserLoggingEnabled({ DEBUG: '*' })).toBe(true);
    expect(privateBrowserLoggingEnabled({ PWDEBUG: 'console' })).toBe(true);
  });
  it('preserves unrelated logging and honors explicit exclusions', () => {
    expect(privateBrowserLoggingEnabled({})).toBe(false);
    expect(privateBrowserLoggingEnabled({ DEBUG: 'project:*' })).toBe(false);
    expect(privateBrowserLoggingEnabled({ DEBUG: '*,-pw:*' })).toBe(false);
  });
});
