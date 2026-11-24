import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectAppearanceComponent } from './project-appearance.component';
import type { ProjectAppearance } from './project.models';

describe('Project image picker', () => {
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAYAAACOEfKtAAAAm0lEQVR4nO3QMQ0AIADAMOQgG2k4AQ88ZEmP/UvHXPvovfF7oB5AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMB1AgADTAQQIMN0FBhVS3x1b1tkAAAAASUVORK5CYII=';
  const appearance: ProjectAppearance = { name: 'Checkout', look: 'icon', hue: 'pine', icon: 'repo' };
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const fixture = TestBed.createComponent(ProjectAppearanceComponent);
    fixture.componentRef.setInput('appearance', { ...appearance, image });
    const changed = vi.fn((value: ProjectAppearance) => fixture.componentRef.setInput('appearance', value));
    fixture.componentInstance.appearanceChange.subscribe(changed);
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input[type=file]');
    function choose() {
      const file = new File(['file'], 'icon.png');
      const header = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const slice = file.slice();
      Object.defineProperty(slice, 'arrayBuffer', { value: async () => header.buffer });
      vi.spyOn(file, 'slice').mockReturnValue(slice);
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
    }
    return { fixture, changed, choose };
  }

  it('previews the project image and restores the chosen face and focus on removal', () => {
    const { fixture, changed } = setup();
    expect(fixture.nativeElement.querySelector('ex-project-mark img').getAttribute('src')).toBe(image);
    const buttons = Array.from<HTMLButtonElement>(fixture.nativeElement.querySelectorAll('button'));
    buttons.find(button => button.textContent.trim() === 'Remove image')?.click();
    fixture.detectChanges();
    expect(changed).toHaveBeenLastCalledWith({ ...appearance, image: null });
    expect(fixture.nativeElement.querySelector('ex-project-mark img')).toBeNull();
    expect(fixture.nativeElement.querySelector('ex-project-mark ex-icon')).not.toBeNull();
    expect(document.activeElement?.textContent).toContain('Choose image');
  });

  it('keeps the previous icon after a failed replacement and discards a selection when closed', async () => {
    const { fixture, choose, changed } = setup();
    const decode = vi.fn().mockRejectedValueOnce(new Error('Invalid image'));
    vi.stubGlobal('createImageBitmap', decode);
    choose();
    expect(fixture.nativeElement.querySelector('[role=status]').textContent).toContain('Preparing image');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[role=alert]')?.textContent).toContain('This image could not be opened');
    });
    expect(fixture.nativeElement.querySelector('ex-project-mark img').getAttribute('src')).toBe(image);
    expect(changed).not.toHaveBeenCalled();

    const bitmap = { width: 80, height: 80, close: vi.fn() };
    let complete!: (value: typeof bitmap) => void;
    decode.mockReturnValueOnce(new Promise<typeof bitmap>(resolve => { complete = resolve; }));
    choose();
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    complete(bitmap);
    await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce());
    expect(changed).not.toHaveBeenCalled();
  });
});
