import { windowScopedKey } from '@/shared/services/scoped-storage';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Component, NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { SessionContainer } from './session-container';
import { TabService, type Tab } from '../tab-service';
import { SessionsService } from '../../../shared/services/sessions.service';
import { NavigationService } from '../../../shared/services/navigation.service';
import { ProductivityStateService } from '@/features/productivity/productivity-state.service';
import { PlannotatorService, PlannotatorStateService } from '@/features/plannotator';
import { ActionsStateService } from '@/features/actions';
import { TodosService } from '@/features/productivity/todos.service';
import { UserTerminalStateService } from '@/features/user-terminal';
import { BrowserViewStateService } from '@/features/browser-panel/browser-view-state.service';
import { BrowserTabsStateService } from '@/features/browser-panel/browser-tabs-state.service';
import { BrowserIsolationService } from '@/shared/services/browser-isolation.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { ModalOverlayStateService } from '@/shared/services/modal-overlay-state.service';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import type { AppSettings } from '@/shared/models/app-settings.model';
import {
  DEFAULT_MAX_WORKTREES_PER_REPO,
  DEFAULT_SPEECH_TO_TEXT_SETTINGS,
} from '@/shared/models/app-settings.model';
import { Session } from '@/shared/models/session.model';
import { toast } from 'ngx-sonner';

@Component({
  standalone: true,
  template: '',
})
class DummyRouteComponent {}

function makeAppSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultClaudeSessionSurface: 'claude-ui',
    defaultAgentProvider: 'claude',
    sessionToolbarButtons: null,
    defaultModelByProvider: {},
    defaultReasoningEffortByProvider: {},
    agentModelPresets: [],
    maxWorktreesPerRepo: DEFAULT_MAX_WORKTREES_PER_REPO,
    runTimeLimitHours: 0,
    speechToText: DEFAULT_SPEECH_TO_TEXT_SETTINGS,
    speechToTextApiKeyConfigured: false,
    speechToTextApiKeyFromEnv: false,
    speechToTextRequiresApiKey: false,
    onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}
