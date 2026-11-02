import review from './repository-review.mjs';

/** Source selection in both supported layouts, plus real dirty/clean defaults. */
export default async function* (capture) {
  yield* review(capture, { sourcesOnly: true });
}
