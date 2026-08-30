import { Injectable, Logger } from '@nestjs/common';
import { basename } from 'node:path';
import simpleGit from 'simple-git';
import { MAX_KEYTERMS } from './speech-to-text.types.js';

/**
 * Vocabulary bias is the single biggest accuracy lever for dictating code, but
 * it must not cost latency: this repo targets checkouts with thousands of files
 * where `git status` is not instant. So terms are cached per worktree and
 * served stale while a refresh runs in the background — the first dictation in
 * a worktree gets path- and branch-derived terms, and later ones get file names
 * too.
 */
const TTL_MS = 30_000;

/** A stuck git call must never hold up a transcription. */
const GIT_TIMEOUT_MS = 3_000;

/** ElevenLabs rejects terms longer than this, and they never help anyway. */
const MAX_TERM_LENGTH = 50;

interface CacheEntry {
  terms: string[];
  expiresAt: number;
  refreshing: boolean;
}

@Injectable()
export class KeytermService {
  private readonly logger = new Logger(KeytermService.name);
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Never throws and never blocks on git for more than one already-running
   * refresh — callers can treat this as free.
   */
  async collect(
    worktreePath: string | null,
    branch: string | null,
  ): Promise<string[]> {
    const staticTerms = this.staticTerms(worktreePath, branch);
    if (!worktreePath) {
      return staticTerms;
    }

    const entry = this.cache.get(worktreePath);
    const now = Date.now();

    if (!entry) {
      // Nothing cached: seed synchronously with what we can derive for free and
      // populate file names for the next dictation.
      const seeded: CacheEntry = {
        terms: [],
        expiresAt: now + TTL_MS,
        refreshing: false,
      };
      this.cache.set(worktreePath, seeded);
      void this.refresh(worktreePath);
      return staticTerms;
    }

    if (entry.expiresAt <= now) {
      void this.refresh(worktreePath);
    }

    return dedupe([...staticTerms, ...entry.terms]).slice(0, MAX_KEYTERMS);
  }

  /** Drops cached terms for a worktree, e.g. after it is removed. */
  forget(worktreePath: string): void {
    this.cache.delete(worktreePath);
  }

  private async refresh(worktreePath: string): Promise<void> {
    const entry = this.cache.get(worktreePath);
    if (entry?.refreshing) {
      return;
    }
    if (entry) {
      entry.refreshing = true;
    }

    try {
      const git = simpleGit({ baseDir: worktreePath, timeout: { block: GIT_TIMEOUT_MS } });
      const status = await git.raw([
        'status',
        '--porcelain=1',
        '--untracked-files=all',
        '--no-renames',
      ]);

      const terms = dedupe(
        status
          .split('\n')
          .map((line) => line.slice(3).trim())
          .filter(Boolean)
          .flatMap((filePath) => termsFromPath(filePath)),
      ).slice(0, MAX_KEYTERMS);

      this.cache.set(worktreePath, {
        terms,
        expiresAt: Date.now() + TTL_MS,
        refreshing: false,
      });
    } catch (error) {
      // Not a git repo, git missing, timeout — dictation still works, just
      // without file-name biasing.
      this.logger.debug(
        `Keyterm refresh failed for ${worktreePath}: ${(error as Error).message}`,
      );
      this.cache.set(worktreePath, {
        terms: entry?.terms ?? [],
        expiresAt: Date.now() + TTL_MS,
        refreshing: false,
      });
    }
  }

  private staticTerms(
    worktreePath: string | null,
    branch: string | null,
  ): string[] {
    const terms: string[] = [];
    if (worktreePath) {
      terms.push(basename(worktreePath));
    }
    if (branch) {
      terms.push(branch);
      // `feat/speech-to-text` also biases towards "speech" and "text".
      terms.push(...branch.split(/[/\-_.]+/));
    }
    return dedupe(terms);
  }
}

/**
 * A path yields the full name, the stem, and any camelCase/kebab words — a
 * speaker saying "the composer component" should bias towards
 * `claude-composer.component.ts` without having to say the extension.
 */
function termsFromPath(filePath: string): string[] {
  const name = basename(filePath);
  const stem = name.replace(/\.[^.]+$/, '');
  return [name, stem, ...stem.split(/[-_.]+/)];
}

function dedupe(terms: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (
      term.length < 3 ||
      term.length > MAX_TERM_LENGTH ||
      // ElevenLabs caps terms at five words.
      term.split(/\s+/).length > 5
    ) {
      continue;
    }
    const key = term.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(term);
  }
  return result;
}
