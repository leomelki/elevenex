import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service.js';
import { ReposService } from '../repos/repos.service.js';
import { TaskGitService } from '../tasks/task-git.service.js';
import {
  RepositoryReviewReader,
  reviewGit,
  reviewQuery,
} from './repository-review-reader.js';

@Injectable()
export class DesktopRepositoryReviewService {
  private readonly lifetime = new AbortController();
  private readonly reader = new RepositoryReviewReader();
  constructor(
    private readonly tasks: TasksService,
    private readonly repos: ReposService,
    private readonly taskGit: TaskGitService,
  ) {}
  onModuleDestroy(): void {
    this.lifetime.abort();
    this.reader.clear();
  }
  private async task(id: number) {
    const task = await this.tasks.record(id);
    if (
      task.taskState !== 'ready' ||
      task.linkStatus !== 'linked' ||
      !task.path
    )
      throw new ConflictException({
        code: 'review-task',
        message:
          'This task workspace is unavailable. Reopen the task to review repository changes.',
      });
    return task;
  }
  async read(id: number, body: Record<string, unknown>, signal?: AbortSignal) {
    const input = reviewQuery(body);
    if (input.taskId !== id)
      throw new BadRequestException(
        'Review task identity does not match the route.',
      );
    const task = await this.task(id);
    let defaultBase: string | null = null;
    if (input.source === 'branch' && !input.revision && !input.baseRef) {
      const repo = await this.repos.findOne(task.repoId);
      // sourceRef is the task branch, not its comparison target. Creation records
      // retain the requested base separately, including explicit starting commits.
      const taskBranch = task.taskBranch ?? task.sourceRef;
      const createdFrom = task.createdFromRef;
      const self = (ref: string | null) =>
        ref?.replace(/^refs\/heads\//, '') ===
        taskBranch?.replace(/^refs\/heads\//, '');
      defaultBase =
        createdFrom && !self(createdFrom)
          ? createdFrom
          : repo.taskBaseRef && !self(repo.taskBaseRef)
            ? repo.taskBaseRef
            : await this.taskGit.defaultBase(task.path);
      if (defaultBase && self(defaultBase)) defaultBase = task.startingCommit;
      defaultBase ??= task.startingCommit;
    }
    return this.reader.read(task.path, id, input, defaultBase, signal);
  }
  async branches(id: number, query: unknown) {
    if (
      typeof query !== 'string' ||
      query.length > 240 ||
      /[\0\r\n]/.test(query)
    )
      throw new BadRequestException('Invalid branch search.');
    const task = await this.task(id);
    // Hundreds of refs remain backend-owned; only the filtered 50-row window crosses transport.
    const raw = await reviewGit(
      task.path,
      ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/'],
      this.lifetime.signal,
    );
    const refs = raw
      .split('\n')
      .filter(
        (ref) =>
          ref &&
          !ref.endsWith('/HEAD') &&
          ref.toLowerCase().includes(query.toLowerCase()),
      );
    return { taskId: id, refs: refs.slice(0, 50), hasMore: refs.length > 50 };
  }
}
