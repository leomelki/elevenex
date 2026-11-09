import type { BrowserCodeImage, BrowserHumanRequest } from '@elevenex/shared';

export type PlaywrightCallback = (
  id: number,
  args: unknown[],
  updates: unknown[],
) => Promise<unknown>;
export interface BrowserWorkerReply {
  readonly value: unknown;
  readonly images: BrowserCodeImage[];
  readonly requests: BrowserHumanRequest[];
  readonly retained: boolean;
}

/** Structured messages between two trusted threads. Agent source and closures
 * never run in either the privileged adapter or the Playwright worker. */
export interface BrowserHostSnapshot {
  readonly rows: readonly {
    id: string;
    owned: boolean;
    url?: string;
    populated?: boolean;
    generation?: number;
  }[];
  readonly documents: readonly [string, string | undefined][];
}
