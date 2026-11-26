import type { TaskAppSetupIssue } from '@elevenex/shared';

export class AppSetupError extends Error {
  constructor(readonly issue: TaskAppSetupIssue, message: string) {
    super(message);
  }
}
