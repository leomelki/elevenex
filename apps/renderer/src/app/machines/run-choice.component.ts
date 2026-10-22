import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent, KbdComponent } from '../ui';
import { MachineKind } from './machine.models';

@Component({
  selector: 'ex-run-choice',
  imports: [IconComponent, KbdComponent],
  templateUrl: './run-choice.component.html',
  styleUrl: './run-choice.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunChoiceComponent {
  protected readonly groupName = `machine-kind-${crypto.randomUUID()}`;
  readonly value = input<MachineKind>('local');
  readonly disabled = input(false);
  readonly valueChange = output<MachineKind>();
  protected readonly choices: ReadonlyArray<{ id: MachineKind; icon: string; title: string; description: string }> = [
    { id: 'local', icon: 'laptop', title: 'This Mac', description: 'Agents run here, next to your files. Nothing to set up.' },
    { id: 'ssh', icon: 'server', title: 'A server, over SSH', description: 'A dev box or a cloud machine. Elevenex installs itself there and keeps itself up to date.' },
    { id: 'peer', icon: 'peer', title: 'Another computer', description: 'A Mac or PC running Elevenex. Pair it once by pasting its pairing text.' },
  ];
}
