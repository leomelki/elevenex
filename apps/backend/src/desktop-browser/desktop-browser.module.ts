import { SessionsModule } from '../sessions/sessions.module.js';
import { TaskBrowserServers } from './task-browser-servers.js';
import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module.js';
import { DesktopBrowserController } from './desktop-browser.controller.js';
import { DesktopBrowserService } from './desktop-browser.service.js';
@Module({ imports: [TasksModule, SessionsModule], controllers: [DesktopBrowserController], providers: [DesktopBrowserService, TaskBrowserServers], exports: [DesktopBrowserService] })
export class DesktopBrowserModule {}
