import { CdkMenuModule } from '@angular/cdk/menu';
import { OverlayContainer } from '@angular/cdk/overlay';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ProjectMenuComponent, type ProjectMenuAction } from './project-menu.component';

@Component({
  selector: 'ex-project-menu-test',
  imports: [CdkMenuModule, ProjectMenuComponent],
  template: `<button [cdkMenuTriggerFor]="menu">Project</button><ng-template #menu><ex-project-menu [project]="project" [repoCount]="3" machine="dev-box" [closed]="24" (action)="last = $event" /></ng-template>`,
})
class MenuHost {
  readonly project = { name: 'Checkout', initials: 'CO' };
  last: ProjectMenuAction | null = null;
}

describe('Project menu window overlay', () => {
  it('supports keyboard traversal, intent, dismissal and focus restoration', async () => {
    const fixture = TestBed.createComponent(MenuHost);
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector('button');
    trigger.focus(); trigger.click();
    fixture.detectChanges(); await fixture.whenStable();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const menu = overlay.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.getAttribute('aria-label')).toBe('Checkout');
    expect(menu?.textContent).toContain('3 repositories · dev-box');
    const items = overlay.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items[0]?.focus();
    // CDK's key manager reads the native keyCode alongside key.
    items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', keyCode: 35, bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toContain('Delete project');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', keyCode: 38, bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toContain('Archive project');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.last).toBe('archive');
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.click(); fixture.detectChanges();
    overlay.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
