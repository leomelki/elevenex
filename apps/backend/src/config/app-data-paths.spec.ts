import { homedir } from 'node:os';
import { join } from 'node:path';
import { getElevenexDataRoot } from './app-data-paths.js';

describe('application data ownership', () => {
  it('preserves the legacy default when no launcher selects a data directory', () => {
    expect(getElevenexDataRoot({})).toBe(join(homedir(), '.elevenex'));
  });

  it('isolates the new desktop without changing home or external tool data', () => {
    const directory = join(homedir(), '.elevenex', 'desktop', 'data');
    expect(getElevenexDataRoot({ ELEVENEX_DATA_ROOT: directory })).toBe(directory);
    expect(getElevenexDataRoot({})).toBe(join(homedir(), '.elevenex'));
  });

  it('rejects relative roots that could write application data into a checkout', () => {
    expect(() => getElevenexDataRoot({ ELEVENEX_DATA_ROOT: './data' })).toThrow('absolute');
  });
});
