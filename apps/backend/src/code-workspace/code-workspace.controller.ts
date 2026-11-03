import { CodeLifetimes } from './code-lifetimes.service.js';
import { BadRequestException, Body, CanActivate, Controller, ExecutionContext, Get, Injectable, Param, ParseIntPipe, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { dirname } from 'node:path';
import { CodeAuthorization } from './code-authorization.service.js';
import { codeObject, codeText } from './code-values.js';
import { codeDelete, codeDirectory, codeMkdir, codeRead, codeRename, codeStat, codeWrite, confinedPath, publicFileError } from './code-files.js';
import { CodeSearch } from './code-search.service.js';
import { CodeWatch } from './code-watch.service.js';

@Injectable()
export class CodeAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // Browsers contact the private desktop host, never backend endpoints directly.
    if (request.headers.origin || request.headers['sec-fetch-site']) throw new UnauthorizedException();
    if (process.env.ELEVENEX_DESKTOP_SOCKET && request.socket.remoteAddress === undefined) return true;
    const expected = process.env.ELEVENEX_CODE_ACCESS, supplied = request.headers['x-elevenex-code-access'];
    if (!expected || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new UnauthorizedException();
    return true;
  }
}
@Controller('code-workspaces')
@UseGuards(CodeAccessGuard)
export class CodeWorkspaceController {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly queued = new Map<string, number>();
  private pendingMutations = 0;
  constructor(private readonly authorization: CodeAuthorization, private readonly search: CodeSearch, private readonly watches: CodeWatch, private readonly lifetimes: CodeLifetimes) {}
  @Get(':taskId')
  async describe(@Param('taskId', ParseIntPipe) taskId: number, @Query('taskIncarnation') expectedStorage?: string) {
    if (expectedStorage !== undefined && !/^[a-f0-9]{64}$/.test(expectedStorage)) throw new BadRequestException('Invalid task identity.');
    const { identity, storageIdentity, name, branch } = await this.authorization.workspace(taskId, undefined, true, expectedStorage);
    return { version: 1, taskId, identity, storageIdentity, name, branch };
  }
  @Post(':taskId/:operation')
  async operation(@Param('taskId', ParseIntPipe) taskId: number, @Param('operation') operation: string, @Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<unknown> {
    const cancellation = new AbortController();
    const closed = () => { if (!response.writableEnded) cancellation.abort(); };
    response.once('close', closed); request.once('aborted', closed);
    try {
    const input = codeObject(body), identity = codeText(input.identity, 64);
    const workspace = await this.authorization.workspace(taskId, identity);
    this.lifetimes.touch(workspace);
    const execute = async () => {
      cancellation.signal.throwIfAborted();
      if (['write', 'mkdir', 'rename', 'delete'].includes(operation)) await this.authorization.assertCurrent(workspace);
      try {
        switch (operation) {
          case 'stat': return await codeStat(workspace, input.path);
          case 'read': {
            this.watches.observe(workspace, dirname(await confinedPath(workspace, input.path)));
            const value = await codeRead(workspace, input.path);
            return value;
          }
          case 'directory': {
            this.watches.observe(workspace, await confinedPath(workspace, input.path));
            const value = await codeDirectory(workspace, input.path, input.after === undefined ? '' : codeText(input.after, 4096), cancellation.signal); return value;
          }
          case 'write': return await codeWrite(workspace, input, async () => { cancellation.signal.throwIfAborted(); await this.authorization.assertCurrent(workspace); }, cancellation.signal);
          case 'mkdir': return await codeMkdir(workspace, input.path, cancellation.signal);
          case 'rename': return await codeRename(workspace, input, cancellation.signal);
          case 'delete': return await codeDelete(workspace, input, cancellation.signal);
          case 'filenames': return await this.search.filenames(workspace, input, cancellation.signal);
          case 'search': return await this.search.start(workspace, input, cancellation.signal);
          case 'search-page': return await this.search.page(workspace, codeText(input.id, 36));
          case 'search-cancel': this.search.cancel(workspace, codeText(input.id, 36)); return { accepted: true };
          case 'changes': {
            if (typeof input.after !== 'number' || !Number.isSafeInteger(input.after) || input.after < 0) throw new BadRequestException('Invalid event cursor.');
            return { ...this.watches.changes(workspace, input.after), taskName: workspace.name, branch: workspace.branch };
          }
          default: throw new BadRequestException('Unsupported Code operation.');
        }
      } catch (error) { return publicFileError(error); }
    };
    if (!['write', 'mkdir', 'rename', 'delete'].includes(operation)) {
      const value = await execute(); cancellation.signal.throwIfAborted();
      try { await this.authorization.workspace(taskId, identity); }
      catch (error) { this.search.release(identity); this.watches.release(identity); throw error; }
      return value;
    }
    if (this.mutations.size >= 32 && !this.mutations.has(identity)) throw new BadRequestException('Too many editor writes.');
    const queued = this.queued.get(identity) ?? 0;
    if (queued >= 32 || this.pendingMutations >= 128) throw new BadRequestException('Editor writes are busy. Wait for current saves to finish.');
    this.queued.set(identity, queued + 1); this.pendingMutations++;
    const previous = this.mutations.get(identity) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => this.authorization.mutate(taskId, execute));
    this.mutations.set(identity, result);
    try { const reply = await result; this.search.invalidate(identity); return reply; }
    finally { this.pendingMutations--; const remaining = (this.queued.get(identity) ?? 1) - 1; if (remaining) this.queued.set(identity, remaining); else this.queued.delete(identity); if (this.mutations.get(identity) === result) this.mutations.delete(identity); }
    } finally { response.off('close', closed); request.off('aborted', closed); }
  }
}
