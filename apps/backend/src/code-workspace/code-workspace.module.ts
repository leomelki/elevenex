import { NavigationEventsModule } from '../navigation/navigation-events.module.js';
import { CodeTransfers } from './code-transfers.service.js';
import { CodeLifetimes } from './code-lifetimes.service.js';
import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module.js';
import { CodeAuthorization } from './code-authorization.service.js';
import { CodeAccessGuard, CodeWorkspaceController } from './code-workspace.controller.js';
import { CodeSearch } from './code-search.service.js';
import { CodeWatch } from './code-watch.service.js';
@Module({ imports: [TasksModule, NavigationEventsModule], controllers: [CodeWorkspaceController], providers: [CodeTransfers, CodeLifetimes, CodeAuthorization, CodeAccessGuard, CodeSearch, CodeWatch] })
export class CodeWorkspaceModule {}
