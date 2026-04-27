import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { UpsertProjectBrowserStateDto } from './dto/upsert-project-browser-state.dto.js';

export interface ProjectBrowserTabState {
  tabId: string;
  url: string;
  position: number;
  customTitle: string | null;
}

export interface ProjectBrowserSnapshot {
  projectId: number;
  activeTabId: string | null;
  tabs: ProjectBrowserTabState[];
}

@Injectable()
export class ProjectBrowserStateService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findOne(projectId: number) {
    const rows = await this.db
      .select()
      .from(schema.projectBrowserState)
      .where(eq(schema.projectBrowserState.projectId, projectId))
      .orderBy(asc(schema.projectBrowserState.position));

    return this.toSnapshot(projectId, rows);
  }

  async upsert(dto: UpsertProjectBrowserStateDto) {
    this.validateSnapshot(dto);
    const timestamp = new Date().toISOString();
    const tabs = [...dto.tabs].sort((left, right) => left.position - right.position);

    this.db.transaction(tx => {
      tx
        .delete(schema.projectBrowserState)
        .where(eq(schema.projectBrowserState.projectId, dto.projectId))
        .run();

      if (tabs.length === 0) {
        return;
      }

      tx.insert(schema.projectBrowserState).values(
        tabs.map(tab => ({
          projectId: dto.projectId,
          tabId: tab.tabId,
          url: tab.url,
          position: tab.position,
          isActive: dto.activeTabId === tab.tabId,
          customTitle: tab.customTitle?.trim() ? tab.customTitle.trim() : null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      ).run();
    });

    return this.findOne(dto.projectId);
  }

  private toSnapshot(projectId: number, rows: Array<typeof schema.projectBrowserState.$inferSelect>): ProjectBrowserSnapshot {
    if (rows.length === 0) {
      return {
        projectId,
        activeTabId: null,
        tabs: [],
      };
    }

    const tabs = rows.map(row => ({
      tabId: row.tabId,
      url: row.url,
      position: row.position,
      customTitle: row.customTitle ?? null,
    }));

    return {
      projectId,
      activeTabId: rows.find(row => row.isActive)?.tabId ?? tabs[0]?.tabId ?? null,
      tabs,
    };
  }

  private validateSnapshot(dto: UpsertProjectBrowserStateDto): void {
    if (dto.tabs.length > 3) {
      throw new BadRequestException('A project can have at most 3 browser tabs');
    }

    const uniqueTabIds = new Set(dto.tabs.map(tab => tab.tabId));
    if (uniqueTabIds.size !== dto.tabs.length) {
      throw new BadRequestException('Browser tab IDs must be unique per project');
    }

    const positions = new Set(dto.tabs.map(tab => tab.position));
    if (positions.size !== dto.tabs.length) {
      throw new BadRequestException('Browser tab positions must be unique per project');
    }

    if (dto.tabs.length === 0 && dto.activeTabId !== null) {
      throw new BadRequestException('Active browser tab must be null when no tabs are open');
    }

    if (dto.tabs.length > 0 && !dto.tabs.some(tab => tab.tabId === dto.activeTabId)) {
      throw new BadRequestException('Active browser tab must match one of the open tabs');
    }
  }
}
