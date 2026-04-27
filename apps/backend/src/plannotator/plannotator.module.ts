import { Module, Global, OnModuleInit, Logger } from '@nestjs/common';
import { CookieProxyService } from './cookie-proxy.service.js';
import { PlannotatorGateway } from './plannotator.gateway.js';
import { PlannotatorController } from './plannotator.controller.js';
import { PlannotatorRegistryService } from './plannotator-registry.service.js';
import { IpcServerService } from './ipc-server.service.js';
import { PlannotatorSessionWatcher } from './session-watcher.service.js';

@Global()
@Module({
  controllers: [PlannotatorController],
  providers: [
    CookieProxyService,
    PlannotatorRegistryService,
    IpcServerService,
    PlannotatorSessionWatcher,
    PlannotatorGateway,
  ],
  exports: [
    CookieProxyService,
    PlannotatorRegistryService,
    IpcServerService,
    PlannotatorSessionWatcher,
    PlannotatorGateway,
  ],
})
export class PlannotatorModule implements OnModuleInit {
  private readonly logger = new Logger('PlannotatorModule');

  constructor(private readonly registry: PlannotatorRegistryService) {}

  async onModuleInit() {
    this.logger.log(
      `Plannotator services started: activePanels=${this.registry.getActivePanels().length}`,
    );
  }
}
