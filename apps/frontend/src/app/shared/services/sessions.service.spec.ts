import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../models/session.model';
import { SessionsService } from './sessions.service';

describe('Session creation handoff', () => {
  let service: SessionsService;
  let http: HttpTestingController;
  const session = { id: 86, projectId: 4, workspaceName: 'New task' } as Session;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SessionsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('opens from the creation response once, then fetches fresh session data', () => {
    service.create({ repoId: 1 }).subscribe();
    http.expectOne('/api/sessions').flush(session);
    let opened: Session | undefined;
    service.getOne(86).subscribe((value) => opened = value);
    expect(opened).toEqual(session);
    http.expectNone('/api/sessions/86');
    service.getOne(86).subscribe();
    http.expectOne('/api/sessions/86').flush(session);
  });

  it('fetches fresh data if navigation happens much later', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    service.create({ repoId: 1 }).subscribe();
    http.expectOne('/api/sessions').flush(session);
    now.mockReturnValue(11_001);
    service.getOne(86).subscribe();
    http.expectOne('/api/sessions/86').flush(session);
  });
});
