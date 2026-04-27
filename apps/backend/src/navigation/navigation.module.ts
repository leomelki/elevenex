import { Module } from '@nestjs/common';
import { NavigationController } from './navigation.controller.js';
import { NavigationService } from './navigation.service.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReposModule } from '../repos/repos.module.js';
import { BranchesModule } from '../branches/branches.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';

@Module({
  imports: [ProjectsModule, ReposModule, BranchesModule, SessionsModule],
  controllers: [NavigationController],
  providers: [NavigationService],
})
export class NavigationModule {}