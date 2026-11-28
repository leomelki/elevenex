import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ProjectMarkComponent } from './project-mark.component';

describe('Project mark face precedence', () => {
  it('prefers logo, emoji, icon then initials and recovers from a failed logo', () => {
    const fixture = TestBed.createComponent(ProjectMarkComponent);
    fixture.componentRef.setInput('name', 'Checkout');
    fixture.componentRef.setInput('logo', '/project.svg');
    fixture.componentRef.setInput('emoji', '🛒');
    fixture.componentRef.setInput('icon', 'repo');
    fixture.componentRef.setInput('initials', 'CO');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).not.toBeNull();
    fixture.nativeElement.querySelector('img')?.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('🛒');
    expect(fixture.nativeElement.querySelector('ex-icon')).toBeNull();
    fixture.componentRef.setInput('emoji', undefined); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ex-icon')).not.toBeNull();
    fixture.componentRef.setInput('icon', undefined); fixture.detectChanges();
    expect(fixture.nativeElement.textContent.trim()).toBe('CO');
    expect(fixture.nativeElement.getAttribute('aria-label')).toBe('Checkout');
  });
});
