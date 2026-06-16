import { describe, expect, it } from 'vitest';
import { AgentControlStateService } from './agent-control-state.service';

describe('AgentControlStateService', () => {
  it('opens as a global controller from any contextual entry point', () => {
    const service = new AgentControlStateService();
    expect(service.isOpen()).toBe(false);

    service.openProject({ id: 7, name: 'Platform' });

    expect(service.isOpen()).toBe(true);
    expect(service.context()).toEqual({ kind: 'global', label: 'Elevenex' });
  });

  it('toggles and closes the drawer', () => {
    const service = new AgentControlStateService();

    service.toggle();
    expect(service.isOpen()).toBe(true);

    service.toggle();
    expect(service.isOpen()).toBe(false);

    service.openGlobal();
    service.close();
    expect(service.isOpen()).toBe(false);
  });
});
