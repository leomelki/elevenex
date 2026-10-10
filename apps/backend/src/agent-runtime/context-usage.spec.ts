import { contextPercentage } from './context-usage.js';

describe('contextPercentage', () => {
  it.each([
    [0, 200_000, 0],
    [25_000, 200_000, 13],
    [100_000, 200_000, 50],
    [210_000, 200_000, 100],
    [1, 0, null],
    [1, NaN, null],
    [Infinity, 200_000, null],
    [-1, 200_000, null],
  ])(
    'normalizes %s tokens in a %s window to %s',
    (tokens, window, expected) => {
      expect(contextPercentage(tokens, window)).toBe(expected);
    },
  );
});
