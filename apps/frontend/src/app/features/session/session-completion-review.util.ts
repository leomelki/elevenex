export function shouldAutoReviewSessionCompletion(
  activeSessionId: number | null,
  completionSessionId: number,
  hasUnreviewedCompletion: boolean,
): boolean {
  return hasUnreviewedCompletion && activeSessionId === completionSessionId;
}
