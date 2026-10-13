import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGlobe, lucideTerminal } from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { OptionSelectComponent, type OptionSelectItem } from '@/shared/components/option-select';
import type { McpServerDefinition } from '@/shared/models/agent-runtime.model';
import {
  editorArguments,
  editorPairs,
  parseEditorArguments,
  parseEditorPairs,
} from './mcp-editor-values';

@Component({
  selector: 'cw-mcp-server-editor',
  imports: [
    ReactiveFormsModule,
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    OptionSelectComponent,
  ],
  viewProviders: [provideIcons({ lucideGlobe, lucideTerminal })],
  templateUrl: './mcp-server-editor.component.html',
  host: { class: 'flex min-h-0 flex-1' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class McpServerEditorComponent {
  readonly definition = input.required<McpServerDefinition>();
  readonly editing = input(false);
  readonly busy = input(false);
  readonly browserAuth = input(true);
  readonly scopes = input<McpServerDefinition['scope'][]>(['project', 'user']);
  readonly transports = input<McpServerDefinition['transport'][]>(['http', 'stdio']);
  readonly save = output<McpServerDefinition>();
  readonly cancel = output<void>();
  readonly dirtyChange = output<boolean>();
  readonly error = signal<string | null>(null);
  readonly submitted = signal(false);
  readonly transport = signal<McpServerDefinition['transport']>('http');
  readonly scope = signal<McpServerDefinition['scope']>('project');
  readonly importText = signal('');
  readonly importOpen = signal(false);
  readonly advancedOpen = signal(false);
  readonly remoteOptions = computed(() =>
    this.options(
      this.transports().filter((transport) => transport !== 'stdio'),
      { http: 'Streamable HTTP', sse: 'Server-sent events (SSE)' },
    ),
  );
  private baseline = '';
  readonly nativeOptions = signal<Record<string, unknown> | undefined>(undefined);
  readonly enabled = signal(true);
  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/)],
    }),
    command: new FormControl('', { nonNullable: true }),
    args: new FormControl('', { nonNullable: true }),
    env: new FormControl('', { nonNullable: true }),
    url: new FormControl('', { nonNullable: true }),
    headers: new FormControl('', { nonNullable: true }),
  });
  readonly scopeLabels: Record<string, string> = {
    project: 'Project',
    local: 'Only this worktree',
    user: 'All projects',
  };

  constructor() {
    effect(() => {
      const definition = this.definition();
      untracked(() => this.fill(definition, true));
    });
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.reportDirty());
    effect(() => {
      if (this.busy()) this.form.disable({ emitEvent: false });
      else this.form.enable({ emitEvent: false });
    });
    effect(() => {
      this.transport();
      this.scope();
      this.importText();
      this.reportDirty();
    });
    const element = inject<ElementRef<HTMLElement>>(ElementRef);
    afterNextRender(() =>
      element.nativeElement.querySelector<HTMLInputElement>('input:not([readonly])')?.focus(),
    );
  }

  options(values: string[], labels: Record<string, string>): OptionSelectItem[] {
    return values.map((value) => ({ value, label: labels[value] }));
  }

  private reportDirty(): void {
    const current = JSON.stringify({
      ...this.form.getRawValue(),
      transport: this.transport(),
      scope: this.scope(),
      importText: this.importText(),
      nativeOptions: this.nativeOptions(),
      enabled: this.enabled(),
    });
    this.dirtyChange.emit(!!this.baseline && current !== this.baseline);
  }

  private fill(value: McpServerDefinition, initial = false): void {
    this.transport.set(value.transport);
    this.scope.set(value.scope);
    this.advancedOpen.set(
      value.transport === 'sse' ||
        !!Object.keys(value.env ?? {}).length ||
        !!Object.keys(value.headers ?? {}).length,
    );
    this.error.set(null);
    this.submitted.set(false);
    this.nativeOptions.set(value.nativeOptions);
    this.enabled.set(value.enabled !== false);
    this.form.reset(
      {
        name: value.name,
        command: value.command ?? '',
        args: editorArguments(value.args ?? []),
        env: editorPairs(value.env),
        url: value.url ?? '',
        headers: editorPairs(value.headers),
      },
      { emitEvent: false },
    );
    if (initial)
      this.baseline = JSON.stringify({
        ...this.form.getRawValue(),
        transport: value.transport,
        scope: value.scope,
        importText: '',
        nativeOptions: value.nativeOptions,
        enabled: value.enabled !== false,
      });
    this.reportDirty();
  }

  submit(): void {
    if (this.busy()) return;
    this.submitted.set(true);
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.error.set('Enter a server name using letters, numbers, dots, hyphens or underscores.');
      return;
    }
    const value = this.form.getRawValue();
    try {
      if (this.transport() === 'stdio' && !value.command.trim())
        throw new Error('Enter the executable to start this server.');
      if (this.transport() !== 'stdio') {
        let url: URL;
        try {
          url = new URL(value.url.trim());
        } catch {
          throw new Error('Enter a complete HTTP or HTTPS URL.');
        }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new Error('Use an HTTP or HTTPS URL. Put credentials in the headers field.');
      }
      this.error.set(null);
      this.save.emit({
        ...this.definition(),
        name: value.name.trim(),
        scope: this.scope(),
        transport: this.transport(),
        command: value.command.trim(),
        args: parseEditorArguments(value.args),
        env: parseEditorPairs(value.env, 'Environment variables'),
        url: value.url.trim(),
        headers: parseEditorPairs(value.headers, 'Headers'),
        nativeOptions: this.nativeOptions(),
        enabled: this.enabled(),
      });
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }

  importConfiguration(): void {
    if (this.busy() || this.editing()) return;
    try {
      const root = JSON.parse(this.importText());
      if (!root || typeof root !== 'object' || Array.isArray(root))
        throw new Error('Paste an MCP server configuration object.');
      const servers = root.mcpServers ?? root.mcp?.servers ?? root.mcp;
      const entries = servers ? Object.entries(servers) : null;
      if (entries && entries.length !== 1) throw new Error('Paste one server at a time.');
      const [name, config] = entries?.[0] ?? [this.form.controls.name.value, root];
      const value = config as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Paste an MCP server configuration object.');
      const command = Array.isArray(value['command']) ? value['command'] : null;
      const stringMap = (map: unknown): Record<string, string> => {
        if (map === undefined) return {};
        if (
          !map ||
          typeof map !== 'object' ||
          Array.isArray(map) ||
          Object.values(map).some((v) => typeof v !== 'string')
        )
          throw new Error('Environment variables and headers must contain string values.');
        return map as Record<string, string>;
      };
      const args = command ? command.slice(1) : (value['args'] ?? []);
      const executable = command ? command[0] : (value['command'] ?? '');
      if (
        !Array.isArray(args) ||
        args.some((arg) => typeof arg !== 'string') ||
        typeof executable !== 'string'
      )
        throw new Error('The command and every argument must be strings.');
      if (
        value['type'] !== undefined &&
        !['stdio', 'local', 'remote', 'http', 'sse'].includes(String(value['type']))
      )
        throw new Error('This server type cannot be imported.');
      const commonFields = new Set([
        'type',
        'command',
        'args',
        'env',
        'environment',
        'url',
        'headers',
        'http_headers',
        'enabled',
        'disabled',
      ]);
      const nativeOptions = Object.fromEntries(
        Object.entries(value).filter(([key]) => !commonFields.has(key)),
      );
      const transport = value['url'] ? (value['type'] === 'sse' ? 'sse' : 'http') : 'stdio';
      if (!this.transports().includes(transport))
        throw new Error('This transport is unavailable for the selected agent.');
      this.fill({
        ...this.definition(),
        name,
        scope: this.scope(),
        transport,
        command: executable,
        args,
        url: String(value['url'] ?? ''),
        env: stringMap(value['env'] ?? value['environment']),
        headers: stringMap(value['headers'] ?? value['http_headers']),
        enabled: value['enabled'] !== false && value['disabled'] !== true,
        nativeOptions: Object.keys(nativeOptions).length ? nativeOptions : undefined,
      });
      this.importText.set('');
      this.importOpen.set(false);
      this.reportDirty();
    } catch (error) {
      this.error.set(
        error instanceof SyntaxError
          ? 'This JSON is invalid. Check commas and quotation marks.'
          : (error as Error).message,
      );
    }
  }
}
