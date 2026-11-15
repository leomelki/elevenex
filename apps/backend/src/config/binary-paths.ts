import { accessSync, constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';

interface BinaryContext {
  readonly path: string;
  readonly extensions: string | undefined;
}
interface BinaryResolution extends BinaryContext {
  readonly binary: string;
  readonly validatedAt?: number;
}
const MAX_LOOKUPS = 128;
const VALIDATION_TTL_MS = 1000;

/** Owns bounded executable discovery, coalescing and cache invalidation. */
export class BinaryPathResolver {
  private readonly cache = new Map<string, BinaryResolution>();
  private readonly reads = new Map<string, Promise<string | null>>();
  private generation = 0;

  constructor(
    private readonly context: () => BinaryContext,
    private readonly windows: boolean,
  ) {}

  clear(): void {
    this.cache.clear();
    this.generation++;
  }

  /** Compatibility API. Fresh async results make subsequent sync reads cheap. */
  find(name: string): string | null {
    const context = this.context();
    const cached = this.match(name, context);
    if (cached) {
      if (this.fresh(cached)) return cached.binary;
      try {
        accessSync(cached.binary, constants.X_OK);
        return cached.binary;
      } catch {
        this.cache.delete(name);
      }
    }
    for (const binary of this.candidates(name, context)) {
      try {
        accessSync(binary, constants.X_OK);
        this.remember(name, { ...context, binary });
        return binary;
      } catch {
        /* Try the next installation. */
      }
    }
    return null;
  }

  async findAsync(name: string): Promise<string | null> {
    const context = this.context();
    const cached = this.match(name, context);
    if (cached && this.fresh(cached)) return cached.binary;
    const generation = this.generation;
    const key = JSON.stringify([
      name,
      context.path,
      context.extensions,
      generation,
    ]);
    const existing = this.reads.get(key);
    if (existing) return existing;
    if (this.reads.size >= MAX_LOOKUPS)
      throw new Error(
        'Executable discovery is busy. Retry after current lookups finish.',
      );
    const read = async (): Promise<string | null> => {
      for (const binary of this.candidates(name, context, cached?.binary)) {
        try {
          await access(binary, constants.X_OK);
          if (generation === this.generation)
            this.remember(name, {
              ...context,
              binary,
              validatedAt: performance.now(),
            });
          return binary;
        } catch {
          /* Broken/removed links fall through to the remaining PATH. */
        }
      }
      if (cached && this.cache.get(name) === cached) this.cache.delete(name);
      return null;
    };
    const pending = read();
    this.reads.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.reads.get(key) === pending) this.reads.delete(key);
    }
  }

  private match(
    name: string,
    context: BinaryContext,
  ): BinaryResolution | undefined {
    const cached = this.cache.get(name);
    return cached?.path === context.path &&
      cached.extensions === context.extensions
      ? cached
      : undefined;
  }

  private fresh(cached: BinaryResolution): boolean {
    return (
      cached.validatedAt !== undefined &&
      performance.now() - cached.validatedAt < VALIDATION_TTL_MS
    );
  }

  private remember(name: string, value: BinaryResolution): void {
    this.cache.delete(name);
    this.cache.set(name, value);
    if (this.cache.size > MAX_LOOKUPS) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
  }

  private *candidates(
    name: string,
    context: BinaryContext,
    preferred?: string,
  ): Generator<string> {
    if (preferred) yield preferred;
    const explicit =
      isAbsolute(name) ||
      name.includes('/') ||
      (this.windows && name.includes('\\'));
    const directories = explicit
      ? ['']
      : context.path.split(this.windows ? ';' : ':').filter(Boolean);
    const names =
      !this.windows || extname(name)
        ? [name]
        : [
            ...(context.extensions || '.COM;.EXE;.BAT;.CMD')
              .split(';')
              .map((extension) => extension.trim())
              .filter(Boolean)
              .map((extension) => name + extension),
            name,
          ];
    for (const directory of directories)
      for (const candidate of names) {
        const binary = directory ? join(directory, candidate) : candidate;
        if (binary !== preferred) yield binary;
      }
  }
}
