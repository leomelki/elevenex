import { RemoteLinkService } from '@/features/remote-link/remote-link.service';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserTabsStateService } from '../../features/browser-panel/browser-tabs-state.service';
import { BrowserViewStateService } from '../../features/browser-panel/browser-view-state.service';
import { TabService } from '../../features/session/tab-service';

import { EnvironmentConnectionManagerService } from './environment-connection-manager.service';
import { NavigationService } from './navigation.service';
import { OnboardingConnectionService } from './onboarding-connection.service';
import { OnboardingStartupService } from './onboarding-startup.service';
import { OnboardingStateService } from './onboarding-state.service';
import { OpenWindowsService } from './open-windows.service';
import { SshRuntimeRecoveryService } from './ssh-runtime-recovery.service';
import { OnboardingStateSnapshot } from '../models/onboarding.model';
