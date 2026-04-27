import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ModalOverlayStateService } from './modal-overlay-state.service';

describe('ModalOverlayStateService', () => {
  let service: ModalOverlayStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ModalOverlayStateService);
  });

  it('marks modal state active when the first modal opens', () => {
    expect(service.hasOpenModal()).toBe(false);

    const release = service.openModal();

    expect(service.hasOpenModal()).toBe(true);

    release();
    expect(service.hasOpenModal()).toBe(false);
  });

  it('keeps modal state active until the last modal closes', () => {
    const releaseFirst = service.openModal('first');
    const releaseSecond = service.openModal('second');

    expect(service.hasOpenModal()).toBe(true);

    releaseFirst();
    expect(service.hasOpenModal()).toBe(true);

    releaseSecond();
    expect(service.hasOpenModal()).toBe(false);
  });

  it('ignores duplicate release calls', () => {
    const release = service.openModal('duplicate');

    release();
    release();

    expect(service.hasOpenModal()).toBe(false);
  });
});
