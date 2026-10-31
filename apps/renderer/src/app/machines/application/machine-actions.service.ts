import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { ToastNotice } from '../../ui';
import type { Machine, MachineEditPatch, MachineMenuAction, MachineMenuEvent } from '../index';
import { MachineConnectionService } from './machine-connection.service';
import { MachineLauncherService } from './machine-launcher.service';
import { machineSelection } from './machine-presentation';

/** Owns retained edit drafts, optimistic removal and window-scoped Undo notices. */
@Injectable()
export class MachineActionsService {
  private readonly connection = inject(MachineConnectionService);
  private readonly launcher = inject(MachineLauncherService);
  private readonly destroy = inject(DestroyRef);
  readonly menu = signal<MachineMenuEvent | null>(null);
  readonly editOpen = signal(false);
  readonly detailsOpen = signal(false);
  readonly details = signal<{ readonly name: string; readonly message: string; readonly from: HTMLElement } | null>(null);
  readonly draft = signal<{ readonly machine: Machine; readonly from: HTMLElement; readonly step: 'edit' | 'remove'; readonly id: number } | null>(null);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly identity = signal<string | null | undefined>(undefined);
  readonly identityLabel = computed(() => this.identity()?.split(/[\\/]/).pop() ?? '');
  readonly notices = signal<readonly ToastNotice[]>([]);
  private readonly hidden = signal<readonly string[]>([]);
  readonly machines = computed(() => this.launcher.machines().filter(machine => !this.hidden().includes(machine.id)));
  private readonly restoring = new Set<string>();
  private nextDraft = 0;

  async act({ event, action }: { readonly event: MachineMenuEvent; readonly action: MachineMenuAction }): Promise<void> {
    this.menu.set(null);
    const machine = this.machines().find(machine => machine.id === event.machine.id);
    if (!machine) return;
    if (action === 'details') {
      if (machine.error && machine.last) {
        this.details.set({ name: machine.name, message: machine.last, from: event.card });
        this.detailsOpen.set(true);
      }
    } else if (action === 'edit' || action === 'remove' && machine.windows) {
      this.draft.set({ machine, from: event.card, step: action === 'remove' ? 'remove' : 'edit', id: ++this.nextDraft });
      this.error.set(''); this.identity.set(undefined); this.editOpen.set(true);
    } else if (action === 'remove') await this.remove(machine, false);
    else if (action === 'new-window') await this.launcher.openMachine({ machine, newWindow: true });
    else {
      if (this.launcher.pendingId() === machine.id || this.launcher.currentId() === machine.id) this.launcher.home();
      try { await this.connection.disconnectMachine(machine.id); }
      catch { if (!this.destroy.destroyed) this.launcher.error.set('The machine could not be disconnected. Try again.'); }
    }
  }

  cancel(): void { if (!this.saving()) this.editOpen.set(false); }
  async chooseIdentity(): Promise<void> {
    const draft = this.draft();
    try {
      const path = await this.connection.chooseIdentity();
      if (!this.destroy.destroyed && this.editOpen() && this.draft() === draft && path) this.identity.set(path);
    } catch { if (!this.destroy.destroyed && this.draft() === draft) this.error.set('The SSH key could not be selected. Try again.'); }
  }

  async save(patch: MachineEditPatch): Promise<void> {
    const draft = this.draft();
    if (!draft || !this.editOpen() || this.saving()) return;
    this.saving.set(true); this.error.set('');
    const machine = draft.machine;
    try {
      if (machine.kind === 'ssh' && (patch.host !== machine.host || patch.user !== machine.user || patch.port !== machine.port || this.identity() !== undefined)) this.launcher.home();
      await this.connection.edit(machineSelection(machine.id), { name: patch.name, hue: patch.hue,
        ...(machine.kind === 'ssh' ? { host: patch.host, user: patch.user || undefined, port: patch.port, identityFile: patch.key === 'default' ? null : patch.key === 'identity' ? this.identity() : undefined } : {}) });
      if (!this.destroy.destroyed && this.draft() === draft) this.editOpen.set(false);
    } catch {
      if (!this.destroy.destroyed && this.draft() === draft) this.error.set('The machine could not be saved. Check the host, user and SSH key, then try again.');
    } finally { if (!this.destroy.destroyed && this.draft() === draft) this.saving.set(false); }
  }

  async removeDraft(): Promise<void> {
    const draft = this.draft();
    if (draft && this.editOpen() && !this.saving()) await this.remove(draft.machine, true);
  }

  private async remove(machine: Machine, confirmWindows: boolean): Promise<void> {
    if (machine.kind === 'local' || this.hidden().includes(machine.id)) return;
    this.editOpen.set(false); this.hidden.update(ids => [...ids, machine.id]);
    if (this.launcher.pendingId() === machine.id || this.launcher.currentId() === machine.id) this.launcher.home();
    try {
      const token = await this.connection.remove(machine.id, confirmWindows);
      if (this.destroy.destroyed) return;
      const notices = this.notices();
      if (notices.length >= 3) this.dismiss(notices[0]!.id);
      this.notices.update(rows => [...rows, { id: token, title: `${machine.kind === 'peer' ? 'Unpaired' : 'Removed'} ${machine.name}`, detail: 'Nothing on it was touched', action: 'Undo' }]);
    } catch {
      if (!this.destroy.destroyed) this.launcher.error.set('The machine could not be removed. It has been restored; if another window opened it, choose Remove again to confirm.');
    } finally { if (!this.destroy.destroyed) this.hidden.update(ids => ids.filter(id => id !== machine.id)); }
  }

  dismiss(token: string): void {
    if (this.restoring.has(token) || !this.notices().some(notice => notice.id === token)) return;
    this.notices.update(rows => rows.filter(row => row.id !== token));
    void this.connection.dismissRemoval(token).catch(() => undefined);
  }

  async undo(token: string): Promise<void> {
    if (this.restoring.has(token)) return;
    const notice = this.notices().find(row => row.id === token);
    if (!notice) return;
    this.restoring.add(token); this.notices.update(rows => rows.filter(row => row.id !== token));
    try { await this.connection.undoRemoval(token); }
    catch {
      if (!this.destroy.destroyed) { this.launcher.error.set('The machine could not be restored. Try Undo again.'); this.notices.update(rows => [...rows, notice]); }
    } finally { this.restoring.delete(token); }
  }
}
