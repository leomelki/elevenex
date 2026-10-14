import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { getBackendServerId, isBackendOriginReady } from '../runtime/runtime-config';
import type {
  PortForwardRequest,
  PortForwardResponse,
  PortForwardHandle,
} from '../models/port-forwarding.model';
import type { SshForward } from '../models/ssh-forward.model';
import { getActiveOnboardingServer, readOnboardingStateSnapshot } from './onboarding-state.service';
import { SshForwardsService } from './ssh-forwards.service';

/** Applies agent requests through the same definitions and runtime used by the UI. */
@Injectable({ providedIn: 'root' })
export class PortForwardingOperationsService {
  private readonly forwards = inject(SshForwardsService);
  private readonly router = inject(Router);
  async execute(request: PortForwardRequest, signal: AbortSignal): Promise<PortForwardResponse> {
    signal.throwIfAborted();
    const environmentKey = getBackendServerId();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (environmentKey !== getBackendServerId() || !isBackendOriginReady())
        throw new Error(
          'The desktop switched or disconnected from this backend. Inspect forwards before retrying.',
        );
    };
    const { operation, args } = request;
    if (!Number.isSafeInteger(args.projectId) || args.projectId <= 0)
      throw new Error('A valid project ID is required.');
    if (operation === 'create') {
      if (!(await this.forwards.isSupported()))
        throw new Error('This desktop does not support port forwarding.');
      assertCurrent();
      const snapshot = readOnboardingStateSnapshot();
      const server = snapshot.mode === 'ssh' ? getActiveOnboardingServer(snapshot) : null;
      if (snapshot.mode === 'paired' && (args.sshHost || args.sshUser || args.sshPort))
        throw new Error('Paired forwarding does not use SSH settings. Omit SSH overrides.');
      if (snapshot.mode !== 'paired' && !args.sshHost && !server)
        throw new Error(
          'No default SSH connection. Supply sshHost, or use the service directly on localhost for a local backend.',
        );
      const usesActive = !args.sshHost || args.sshHost === server?.sshHost;
      const result = await this.forwards.ensure(
        args.projectId,
        {
          name: args.name ?? `Port ${args.remotePort}`,
          sshHost: args.sshHost ?? server?.sshHost ?? '',
          sshUser: args.sshUser ?? (usesActive ? (server?.sshUser ?? undefined) : undefined),
          sshPort: args.sshPort ?? (usesActive ? (server?.sshPort ?? 22) : 22),
          bindAddress: '127.0.0.1',
          localPort: args.localPort ?? args.remotePort!,
          remoteHost: args.remoteHost ?? 'localhost',
          remotePort: args.remotePort!,
          startImmediately: args.startImmediately ?? true,
        },
        signal,
        args.requestedBy,
      );
      assertCurrent();
      if (!result.reused)
        this.notify(
          args.projectId,
          result.forward,
          result.forward.status === 'error'
            ? 'Could not start port forward'
            : result.forward.running
              ? 'Agent started port forward'
              : 'Agent saved port forward',
        );
      return {
        forwards: [this.handle(result.forward)],
        total: 1,
        nextOffset: null,
        reused: result.reused,
      };
    }
    if (operation === 'list') {
      const offset = Math.max(0, args.offset ?? 0),
        limit = Math.min(100, Math.max(1, args.limit ?? 25));
      const page = await this.forwards.getPageByProject(args.projectId, limit, offset);
      assertCurrent();
      return { ...page, forwards: page.forwards.map((f) => this.handle(f)) };
    }
    if (!Number.isSafeInteger(args.forwardId) || args.forwardId! <= 0)
      throw new Error('A valid forward ID is required.');
    const forward = await this.forwards.findByProject(args.projectId, args.forwardId!);
    assertCurrent();
    if (!forward) {
      if (operation === 'remove')
        return { forwards: [], total: 0, nextOffset: null, removed: true };
      throw new Error(
        `Port forward ${args.forwardId} was not found in project ${args.projectId}. Use list_port_forwards.`,
      );
    }
    let updated = forward;
    switch (operation) {
      case 'get':
        break;
      case 'start':
        updated = await firstValueFrom(this.forwards.start(forward.id, signal));
        break;
      case 'stop':
        updated = await firstValueFrom(this.forwards.stop(forward.id, signal));
        break;
      case 'remove':
        updated = await firstValueFrom(this.forwards.remove(forward.id, signal));
        break;
      default:
        throw new Error('Unknown port-forward operation.');
    }
    assertCurrent();
    if (operation !== 'get')
      this.notify(
        args.projectId,
        updated,
        operation === 'remove'
          ? 'Agent removed port forward'
          : updated.status === 'error'
            ? 'Port forward needs attention'
            : operation === 'stop'
              ? updated.running
                ? 'Port forward is still listening'
                : 'Agent stopped port forward'
              : updated.status === 'connecting'
                ? 'Port forward is connecting'
                : 'Agent started port forward',
      );
    return {
      forwards: [this.handle(updated)],
      total: 1,
      nextOffset: null,
      ...(operation === 'remove' ? { removed: true } : {}),
    };
  }

  private handle(forward: SshForward): PortForwardHandle {
    const host =
      forward.bindAddress === '::1'
        ? '[::1]'
        : ['0.0.0.0', '::'].includes(forward.bindAddress)
          ? '127.0.0.1'
          : forward.bindAddress;
    return {
      id: forward.id,
      projectId: forward.projectId,
      name: forward.name.slice(0, 120),
      transport: forward.pairedDeviceId ? 'paired' : 'ssh',
      connectionLabel: forward.connectionLabel,
      bindAddress: forward.bindAddress,
      localPort: forward.localPort,
      remoteHost: forward.remoteHost,
      remotePort: forward.remotePort,
      status: forward.status,
      running: forward.running ?? false,
      localUrl: `http://${host}:${forward.localPort}`,
      lastError: forward.lastError?.slice(0, 4000) ?? null,
      ...(forward.createdBySession ? { createdBySession: forward.createdBySession } : {}),
    };
  }

  private notify(projectId: number, forward: SshForward, message: string): void {
    const notify =
      forward.status === 'error'
        ? toast.error
        : forward.status === 'connecting' || message.includes('still listening')
          ? toast.warning
          : toast.info;
    notify(`${message}: ${forward.name}`, {
      description:
        forward.lastError ??
        `${forward.bindAddress}:${forward.localPort} → ${forward.remoteHost}:${forward.remotePort}`,
      action: {
        label: 'View ports',
        onClick: () => void this.router.navigateByUrl(`/projects/${projectId}#ssh-forwarding`),
      },
    });
  }
}
