import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshLocalMediaUrl } from './local-media-url';

const api = 'http://backend.test/api';
describe('freshLocalMediaUrl', () => {
  beforeEach(() => {
    window.__ELEVENEX_RUNTIME__ = { apiBaseUrl: api };
  });
  afterEach(() => {
    delete window.__ELEVENEX_RUNTIME__;
  });

  it.each([
    `${api}/filesystem/media?path=%2Ftmp%2Fmy%20shot.png#t=2`,
    `${api}/worktrees/%2Ftmp%2Frepo/raw/shot.png?existing=value#detail`,
  ])('refreshes local media and preserves its path, query, and fragment', (src) => {
    const result = new URL(freshLocalMediaUrl(src, 'first'));
    const original = new URL(src);
    expect(result.pathname).toBe(original.pathname);
    expect(result.hash).toBe(original.hash);
    for (const [key, value] of original.searchParams)
      expect(result.searchParams.get(key)).toBe(value);
    expect(result.searchParams.get('_media')).toBe('first');
    const refreshed = new URL(freshLocalMediaUrl(result.href, 'second'));
    expect(refreshed.searchParams.getAll('_media')).toEqual(['second']);
  });

  it.each([
    'https://cdn.test/shot.png?signature=keep-me',
    'https://cdn.test/api/filesystem/media?path=shot.png',
    'data:image/png;base64,AAA',
    'blob:http://backend.test/attachment',
  ])('preserves remote and embedded image URLs: %s', (src) => {
    expect(freshLocalMediaUrl(src, 'first')).toBe(src);
  });
});
