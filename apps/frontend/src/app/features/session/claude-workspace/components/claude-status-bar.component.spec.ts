import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ClaudeStatusBarComponent } from './claude-status-bar.component';

describe('ClaudeStatusBarComponent', () => {
  it('offers auto mode for Codex permission controls', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeStatusBarComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeStatusBarComponent);
    fixture.componentRef.setInput('currentProvider', 'codex');
    fixture.detectChanges();

    expect(fixture.componentInstance.permissionOptions().map((option) => option.id)).toContain('auto');
  });
});
