import { RuntimeBrowserStream } from './runtime-stream.js';
import { RuntimeBrowserPersistence } from './runtime-persistence.js';
import { RuntimeBrowserController } from './runtime-browser.controller.js';
import { RuntimeBrowserService } from './runtime-browser.service.js';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { TaskBrowserServers } from './task-browser-servers.js';
import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module.js';
import { DesktopBrowserController } from './desktop-browser.controller.js';
import { DesktopBrowserService } from './desktop-browser.service.js';
@Module({ imports: [TasksModule, SessionsModule], controllers: [DesktopBrowserController, RuntimeBrowserController], providers: [RuntimeBrowserStream, RuntimeBrowserPersistence, RuntimeBrowserPool, RuntimeBrowserService, DesktopBrowserService, TaskBrowserServers], exports: [DesktopBrowserService, RuntimeBrowserService] })
export class DesktopBrowserModule {}
