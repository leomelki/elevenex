import { NgTemplateOutlet } from '@angular/common';
import { InlineActionConfirmationComponent } from '@/shared/components/inline-action-confirmation/inline-action-confirmation.component';
import { Directive, NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { toast } from 'ngx-sonner';
import { of, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/shared/runtime/electron-window-controls', () => ({
  getElectronWindowControlsApi: () => undefined,
}));

import { AgentControlStateService } from '@/features/agent-control/agent-control-state.service';
import { PlannotatorStateService } from '@/features/plannotator';
import { TodosService } from '@/features/productivity/todos.service';
import { ComposerDraftService } from '@/shared/agent-chat/composer/composer-draft.service';
import { ZardDropdownImports, ZardDropdownService } from '@/shared/components/dropdown';
import { provideZard } from '@/shared/core/provider/providezard';
import { Project } from '@/shared/models/project.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { CursorService } from '@/shared/services/cursor.service';
import { PendingWorkspaceCreationsService } from '@/shared/services/pending-workspace-creations.service';
import { ReposService } from '@/shared/services/repos.service';
import { SessionFoldersService } from '@/shared/services/session-folders.service';
import { SshForwardsService } from '@/shared/services/ssh-forwards.service';
import { WorkspacesService } from '@/shared/services/workspaces.service';
import { BranchInfo } from '../../../shared/models/branch.model';
import {
  NavigationBranch,
  NavigationProject,
  NavigationWorkspace,
} from '../../../shared/models/navigation-tree.model';
import { NavigationService } from '../../../shared/services/navigation.service';
import { SessionsService } from '../../../shared/services/sessions.service';
import { TabColorService } from '../../../shared/services/tab-color.service';
import { Tab, TabService } from '../../session/tab-service';
import { Sidebar } from './sidebar';
import { TaskNavigationLabelComponent } from './task-navigation-label.component';
import { TaskUiService } from '@/features/tasks/task-ui.service';
import { TasksApiService } from '@/features/tasks/tasks-api.service';
import { TaskOperationsService } from '@/features/tasks/task-operations.service';

@Directive({
  selector: 'dialog[trackNativeModal]',
  standalone: true,
  exportAs: 'trackedNativeModal',
})
class MockTrackNativeModalDirective {
  close() {}
  open() {}
}
