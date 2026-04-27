import { Module } from '@nestjs/common';
import { GitModule } from '../git/git.module.js';
import { GithubController } from './github.controller.js';
import { GithubService } from './github.service.js';
import { GhCommandRunnerService } from './gh-command-runner.service.js';
import { RepoContextResolverService } from './repo-context-resolver.service.js';

@Module({
  imports: [GitModule],
  controllers: [GithubController],
  providers: [GithubService, GhCommandRunnerService, RepoContextResolverService],
  exports: [GithubService, RepoContextResolverService],
})
export class GithubModule {}
