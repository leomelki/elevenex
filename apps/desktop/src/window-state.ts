import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { screen, type BrowserWindow, type Rectangle } from 'electron';

interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

const DEFAULT_BOUNDS = { width: 1440, height: 960 };
const MIN_WIDTH = 880;
const MIN_HEIGHT = 600;

export class WindowStateStore {
  private latest: WindowState | undefined;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !('bounds' in parsed)) return;
      const bounds = parsed.bounds;
      if (!bounds || typeof bounds !== 'object') return;
      if (!['x', 'y', 'width', 'height'].every((key) => key in bounds && typeof bounds[key as keyof typeof bounds] === 'number' && Number.isFinite(bounds[key as keyof typeof bounds]))) return;
      const rect = bounds as Rectangle;
      if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return;
      this.latest = { bounds: rect, maximized: 'maximized' in parsed && parsed.maximized === true };
    } catch {
      // Missing or corrupt state should never prevent opening the app.
    }
  }

  options(): { x?: number; y?: number; width: number; height: number; minWidth: number; minHeight: number } {
    const bounds = this.latest?.bounds;
    if (bounds) {
      const area = screen.getDisplayMatching(bounds).workArea;
      const width = Math.max(MIN_WIDTH, Math.min(bounds.width, area.width));
      const height = Math.max(MIN_HEIGHT, Math.min(bounds.height, area.height));
      return {
        x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
        width, height, minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT,
      };
    }
    return { ...DEFAULT_BOUNDS, minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT };
  }

  attach(window: BrowserWindow): void {
    if (this.latest?.maximized) window.maximize();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = () => {
      if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
      this.latest = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    };
    const schedule = () => {
      capture();
      clearTimeout(timer);
      timer = setTimeout(() => void this.save(), 250);
    };
    window.on('resize', schedule);
    window.on('move', schedule);
    window.on('maximize', schedule);
    window.on('unmaximize', schedule);
    window.on('close', () => {
      clearTimeout(timer);
      capture();
      void this.save();
    });
  }

  save(): Promise<void> {
    if (!this.latest) return this.pending;
    const value = JSON.stringify(this.latest);
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, value, 'utf8');
      await rename(`${this.path}.tmp`, this.path);
    }).catch((error: unknown) => console.error('Could not save window state:', error));
    return this.pending;
  }
}
