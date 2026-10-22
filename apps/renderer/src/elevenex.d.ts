import type { ElevenexBridge } from '@elevenex/shared';

declare global {
  interface Window {
    readonly elevenex: ElevenexBridge;
  }
}
