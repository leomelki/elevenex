import { ZardSkeletonComponent } from '@/shared/components/skeleton';
import { ChangeDetectionStrategy, Component } from '@angular/core';

/** A transcript-shaped placeholder shared by full-page and embedded agent chats. */
@Component({
  selector: 'cw-transcript-loading-skeleton',
  standalone: true,
  imports: [ZardSkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-h-48 flex-1 items-center',
    role: 'status',
    'aria-live': 'polite',
    'aria-busy': 'true',
  },
  templateUrl: './transcript-loading-skeleton.component.html',
})
export class TranscriptLoadingSkeletonComponent {}
