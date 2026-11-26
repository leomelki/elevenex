import { Module } from '@nestjs/common';
import { AppHandoffController } from './app-handoff.controller.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { TaskAppController } from './task-app.controller.js';
import { TaskAppGateway } from './task-app.gateway.js';

@Module({
  imports: [TasksModule],
  controllers: [TaskAppController, AppHandoffController],
  providers: [TaskAppGateway],
})
export class TaskAppModule {}
