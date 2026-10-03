import { Directive } from '@angular/core';
import type { PairedTranscriptUnit } from './paired-transcript';
import type { TranscriptRenderItem } from './transcript-render-items';

interface TranscriptUnitContext {
  unit: PairedTranscriptUnit;
  turn: Extract<TranscriptRenderItem, { kind: 'collapsed-turn' }> | null;
}

/** Gives the reusable unit template its actual context type at compile time. */
@Directive({ selector: 'ng-template[cwTranscriptUnit]' })
export class TranscriptUnitTemplateDirective {
  static ngTemplateContextGuard(
    _directive: TranscriptUnitTemplateDirective,
    _context: unknown,
  ): _context is TranscriptUnitContext {
    return true;
  }
}
