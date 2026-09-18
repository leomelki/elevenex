import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ZardSkeletonComponent } from '@/shared/components/skeleton';

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
  template: `
    <span class="sr-only">Loading conversation…</span>
    <div class="mx-auto flex w-full max-w-[52rem] flex-col gap-5" aria-hidden="true">
      <div class="flex justify-end">
        <z-skeleton
          class="h-9 w-[min(55%,15rem)] rounded-[1rem_1rem_0.25rem_1rem] [animation-delay:-600ms] motion-reduce:animate-none"
        />
      </div>

      <div class="flex max-w-[38rem] flex-col gap-2">
        <z-skeleton class="h-3 w-[92%] [animation-delay:-450ms] motion-reduce:animate-none" />
        <z-skeleton class="h-3 w-[78%] [animation-delay:-450ms] motion-reduce:animate-none" />
        <z-skeleton class="h-3 w-[48%] [animation-delay:-450ms] motion-reduce:animate-none" />
      </div>

      <div class="flex max-w-[32rem] items-center gap-2">
        <z-skeleton
          class="size-6 shrink-0 rounded-md [animation-delay:-300ms] motion-reduce:animate-none"
        />
        <z-skeleton
          class="h-8 w-full rounded-lg [animation-delay:-300ms] motion-reduce:animate-none"
        />
      </div>

      <div class="flex max-w-[36rem] flex-col gap-2">
        <z-skeleton class="h-3 w-[84%] [animation-delay:-150ms] motion-reduce:animate-none" />
        <z-skeleton class="h-3 w-[58%] [animation-delay:-150ms] motion-reduce:animate-none" />
      </div>
    </div>
  `,
})
export class TranscriptLoadingSkeletonComponent {}
