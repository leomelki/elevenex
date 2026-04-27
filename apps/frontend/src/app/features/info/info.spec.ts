import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Info } from './info';

describe('Info', () => {
  beforeEach(() => {
    window.__ELEVENEX_ELECTRON__ = undefined;
  });

  it('renders the app name, logo, developer handle, and project link', async () => {
    await TestBed.configureTestingModule({
      imports: [Info],
    }).compileComponents();

    const fixture = TestBed.createComponent(Info);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const logo = element.querySelector('img') as HTMLImageElement | null;
    const links = Array.from(element.querySelectorAll('a'));

    expect(element.textContent).toContain('Elevenex');
    expect(element.textContent).toContain('@leomelki');
    expect(logo?.getAttribute('src')).toBe('/11x.png');
    expect(links.some(link => link.getAttribute('href') === 'https://x.com/leomelki')).toBe(true);
    expect(links.some(link => link.getAttribute('href') === 'https://github.com/leomelki/elevenex')).toBe(true);
  });

  it('opens external links with the Electron bridge when available', async () => {
    const open = vi.fn(() => Promise.resolve());
    window.__ELEVENEX_ELECTRON__ = {
      externalLinks: { open },
    };

    await TestBed.configureTestingModule({
      imports: [Info],
    }).compileComponents();

    const fixture = TestBed.createComponent(Info);
    fixture.detectChanges();

    const link = fixture.nativeElement.querySelector('a[href="https://github.com/leomelki/elevenex"]') as HTMLAnchorElement;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(open).toHaveBeenCalledWith('https://github.com/leomelki/elevenex');
  });
});
