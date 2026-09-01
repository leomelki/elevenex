import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from 'ngx-sonner';

import { BackendRestartComponent } from './backend-restart.component';
import { ServerConnectionService } from '@/shared/services/server-connection.service';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const STATUS = {
  restartSupported: true,
  restarting: false,
  pid: 4242,
  startedAt: '2026-01-01T00:00:00.000Z',
};

describe('BackendRestartComponent', () => {
  let httpMock: HttpTestingController;
  const reconnectCount = signal(0);

  let confirmSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    reconnectCount.set(0);

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [BackendRestartComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ServerConnectionService,
          useValue: { reconnectCount: reconnectCount.asReadonly() },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    confirmSpy?.mockRestore();
    confirmSpy = null;
  });

  async function render(status: Record<string, unknown>) {
    const fixture = TestBed.createComponent(BackendRestartComponent);
    fixture.detectChanges();
    httpMock.expectOne('/api/runtime').flush(status);
    await Promise.resolve();
    fixture.detectChanges();
    return fixture;
  }

  function restartButton(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    const button = fixture.nativeElement.querySelector('button');
    expect(button).toBeTruthy();
    return button as HTMLButtonElement;
  }

  it('restarts the backend and settles once the socket reconnects', async () => {
    const fixture = await render(STATUS);
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    restartButton(fixture).click();
    fixture.detectChanges();

    const request = httpMock.expectOne('/api/runtime/restart');
    expect(request.request.method).toBe('POST');
    request.flush({ ...STATUS, restarting: true });
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Restarting');
    expect(restartButton(fixture).disabled).toBe(true);

    // The new process never answers the old request — the reconnect does.
    reconnectCount.set(1);
    fixture.detectChanges();
    httpMock.expectOne('/api/runtime').flush(STATUS);
    await Promise.resolve();
    fixture.detectChanges();

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Backend restarted.');
    expect(restartButton(fixture).disabled).toBe(false);
  });

  it('does nothing when the confirmation is dismissed', async () => {
    const fixture = await render(STATUS);
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    restartButton(fixture).click();
    fixture.detectChanges();

    httpMock.expectNone('/api/runtime/restart');
  });

  it('explains why the button is unavailable on an unsupervised backend', async () => {
    const fixture = await render({ ...STATUS, restartSupported: false });

    expect(restartButton(fixture).disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain(
      'without a launcher that can bring it back',
    );
  });

  it('hides the action when the backend has no runtime endpoint', async () => {
    const fixture = TestBed.createComponent(BackendRestartComponent);
    fixture.detectChanges();
    httpMock
      .expectOne('/api/runtime')
      .flush({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });
    await Promise.resolve();
    fixture.detectChanges();

    expect(restartButton(fixture).disabled).toBe(true);
    expect(fixture.nativeElement.textContent).not.toContain(
      'without a launcher that can bring it back',
    );
  });

  it('reports a backend that refuses the restart', async () => {
    const fixture = await render(STATUS);
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    restartButton(fixture).click();
    fixture.detectChanges();

    httpMock
      .expectOne('/api/runtime/restart')
      .flush({ message: 'nope' }, { status: 503, statusText: 'Service Unavailable' });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not restart the backend.');
    expect(restartButton(fixture).disabled).toBe(false);
  });
});
