import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import { AgentControlDrawerComponent } from './agent-control-drawer.component';
import { AgentControlStateService } from './agent-control-state.service';
import { AgentMissionsApiService } from './agent-missions-api.service';

describe('AgentControlDrawerComponent', () => {
  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [AgentControlDrawerComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        // No missions → the drawer shows the new-mission composer (no embedded
        // workspace), keeping this a light render test.
        { provide: AgentMissionsApiService, useValue: { list: vi.fn(() => of([])) } },
      ],
    }).compileComponents();
  });

  it('renders the new-mission composer when opened with no missions', async () => {
    const service = TestBed.inject(AgentControlStateService);
    service.openGlobal();

    const fixture = TestBed.createComponent(AgentControlDrawerComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Elevenex agent');
    expect(root.textContent).toContain('Start a mission');
    expect(root.querySelector('.agent-drawer')?.getAttribute('role')).toBe('complementary');
    expect(root.querySelector('textarea')).not.toBeNull();
  });

  it('is hidden when the drawer is closed', () => {
    const service = TestBed.inject(AgentControlStateService);
    service.close();

    const fixture = TestBed.createComponent(AgentControlDrawerComponent);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.agent-drawer')).toBeNull();
  });
});
