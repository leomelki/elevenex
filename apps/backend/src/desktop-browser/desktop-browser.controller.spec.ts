import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { DesktopBrowserController } from './desktop-browser.controller.js';
import { DesktopBrowserService } from './desktop-browser.service.js';
import { TaskBrowserServers } from './task-browser-servers.js';
import { TasksService } from '../tasks/tasks.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import type { Request } from 'express';
describe('Task browser boundaries', () => {
  it('rejects page-origin requests and handoffs outside the task or to archived conversations', async () => {
    const session = { id: 2, workspaceId: 1, status: 'active' };
    const module = await Test.createTestingModule({ controllers: [DesktopBrowserController], providers: [
      { provide: DesktopBrowserService, useValue: { poll: jest.fn() } },
      { provide: TaskBrowserServers, useValue: { ports: jest.fn() } },
      { provide: TasksService, useValue: { record: jest.fn(async () => ({ id: 1, taskState: 'ready', archivedAt: null })) } },
      { provide: SessionsService, useValue: { findOne: jest.fn(async () => session) } },
    ] }).compile();
    const controller = module.get(DesktopBrowserController);
    // Only headers are consumed by this boundary; the HTTP integration uses real Requests.
    const request = { headers: {} } as Request;
    await expect(controller.authorize(request, { taskId: 1, sessionId: 2 })).resolves.toEqual({ taskId: 1, sessionId: 2, available: true });
    await expect(controller.authorize({ headers: { origin: 'https://untrusted.example' } } as Request, { taskId: 1, sessionId: 2 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.poll({ headers: { 'sec-fetch-site': 'same-origin' } } as Request, {})).rejects.toBeInstanceOf(ForbiddenException);
    session.workspaceId = 3; await expect(controller.authorize(request, { taskId: 1, sessionId: 2 })).rejects.toBeInstanceOf(ForbiddenException);
    session.workspaceId = 1; session.status = 'archived'; await expect(controller.authorize(request, { taskId: 1, sessionId: 2 })).rejects.toBeInstanceOf(ForbiddenException);
    await module.close();
  });
});
