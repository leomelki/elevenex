import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBadgeAlert,
  lucideCircleCheck,
  lucideKeyRound,
  lucideLoaderCircle,
  lucidePlugZap,
  lucideRefreshCcw,
  lucideShieldAlert,
  lucideTriangleAlert,
  lucideWrench,
  lucideX,
} from '@ng-icons/lucide';
import {
  ClaudeMcpDiagnosticGroup,
  ClaudeMcpServerEntry,
  ClaudeMcpSnapshot,
} from '@/shared/models/claude-runtime.model';

@Component({
  selector: 'cw-mcp-drawer',
  standalone: true,
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideBadgeAlert,
      lucideCircleCheck,
      lucideKeyRound,
      lucideLoaderCircle,
      lucidePlugZap,
      lucideRefreshCcw,
      lucideShieldAlert,
      lucideTriangleAlert,
      lucideWrench,
      lucideX,
    }),
  ],
  template: `
    @if (open()) {
      <div class="cw-mcp__backdrop" (click)="close.emit()"></div>
      <aside class="cw-mcp">

        <header class="cw-mcp__head">
          <div class="cw-mcp__head-title">
            <div class="cw-mcp__head-icon">
              <ng-icon name="lucidePlugZap" size="14" />
            </div>
            <div>
              <h3>MCP Servers</h3>
              @if (snapshot(); as current) {
                <p>Updated {{ current.lastUpdatedAt | date:'shortTime' }}</p>
              } @else {
                <p>Model Context Protocol</p>
              }
            </div>
          </div>
          <div class="cw-mcp__head-actions">
            <button type="button" class="cw-mcp__icon-btn" (click)="refresh.emit()" [disabled]="loading()" title="Refresh">
              <ng-icon name="lucideRefreshCcw" size="13" [class.animate-spin]="loading()" />
            </button>
            <button type="button" class="cw-mcp__icon-btn" (click)="close.emit()" title="Close">
              <ng-icon name="lucideX" size="13" />
            </button>
          </div>
        </header>

        <div class="cw-mcp__body">
          @if (loading() && !snapshot()) {
            <div class="cw-mcp__loading">
              <div class="cw-mcp__skeleton cw-mcp__skeleton--summary"></div>
              <div class="cw-mcp__skeleton"></div>
              <div class="cw-mcp__skeleton cw-mcp__skeleton--sm"></div>
              <div class="cw-mcp__skeleton"></div>
            </div>
          } @else if (snapshot(); as current) {

            <div class="cw-mcp__summary">
              <div class="cw-mcp__metric" [class.cw-mcp__metric--connected]="current.summary.connected > 0">
                <strong>{{ current.summary.connected }}</strong>
                <span>Connected</span>
              </div>
              <div class="cw-mcp__metric" [class.cw-mcp__metric--warn]="current.summary.needsAuth > 0">
                <strong>{{ current.summary.needsAuth }}</strong>
                <span>Auth needed</span>
              </div>
              <div class="cw-mcp__metric" [class.cw-mcp__metric--error]="current.summary.failed > 0">
                <strong>{{ current.summary.failed }}</strong>
                <span>Failed</span>
              </div>
              <div class="cw-mcp__metric">
                <strong>{{ current.summary.disabled }}</strong>
                <span>Disabled</span>
              </div>
            </div>

            @for (group of groupedServers(); track group.scope) {
              <section class="cw-mcp__section">
                <div class="cw-mcp__section-head">
                  <span class="cw-mcp__section-label">{{ group.label }}</span>
                  <span class="cw-mcp__section-count">{{ group.servers.length }}</span>
                </div>
                @for (server of group.servers; track server.entryId) {
                  <article class="cw-mcp__card" [attr.data-status]="server.connectionStatus">
                    <div class="cw-mcp__card-top">
                      <div class="cw-mcp__status-dot" [attr.data-status]="server.connectionStatus"></div>
                      <div class="cw-mcp__card-info">
                        <div class="cw-mcp__card-name">{{ server.name }}</div>
                        <div class="cw-mcp__card-badges">
                          <span class="cw-mcp__badge cw-mcp__badge--transport">{{ server.transport }}</span>
                          <span class="cw-mcp__badge cw-mcp__badge--status" [attr.data-status]="server.connectionStatus">
                            {{ statusLabel(server) }}
                          </span>
                          @if (server.configStatus !== 'valid') {
                            <span class="cw-mcp__badge cw-mcp__badge--config-warn">{{ server.configStatus }}</span>
                          }
                        </div>
                      </div>
                    </div>

                    <div class="cw-mcp__location">{{ server.configLocation }}</div>

                    @if (server.error) {
                      <div class="cw-mcp__error">
                        <ng-icon name="lucideTriangleAlert" size="11" style="flex-shrink:0;margin-top:0.05rem" />
                        {{ server.error }}
                      </div>
                    }

                    @if (server.counts; as counts) {
                      @if (counts.tools > 0 || counts.prompts > 0 || counts.loadedContextTools > 0) {
                        <div class="cw-mcp__counts">
                          @if (counts.tools > 0) { <span>{{ counts.tools }} tools</span> }
                          @if (counts.prompts > 0) { <span>{{ counts.prompts }} prompts</span> }
                          @if (counts.loadedContextTools > 0) { <span>{{ counts.loadedContextTools }} in ctx</span> }
                        </div>
                      }
                    }

                    @if (server.tools?.length) {
                      <details class="cw-mcp__tools">
                        <summary>
                          <ng-icon name="lucideWrench" size="10" />
                          {{ server.tools!.length }} tool{{ server.tools!.length === 1 ? '' : 's' }}
                        </summary>
                        <div class="cw-mcp__tool-list">
                          @for (tool of server.tools; track tool.name) {
                            <div class="cw-mcp__tool-item">
                              <span class="cw-mcp__tool-name">{{ tool.displayName || tool.name }}</span>
                              <code class="cw-mcp__tool-code">{{ tool.name }}</code>
                            </div>
                          }
                        </div>
                      </details>
                    }

                    @if (server.actions.canAuth || server.actions.canReauth || server.actions.canToggle || server.actions.canRecheck) {
                      <div class="cw-mcp__card-actions">
                        @if (server.actions.canAuth) {
                          <button
                            type="button"
                            class="cw-mcp__btn cw-mcp__btn--auth"
                            (click)="auth.emit(server)"
                            [disabled]="busyServerName() === server.name"
                          >
                            <ng-icon name="lucideKeyRound" size="11" />
                            Authenticate
                          </button>
                        }
                        @if (server.actions.canReauth) {
                          <button
                            type="button"
                            class="cw-mcp__btn cw-mcp__btn--ghost"
                            (click)="auth.emit(server)"
                            [disabled]="busyServerName() === server.name"
                          >
                            <ng-icon name="lucideKeyRound" size="11" />
                            Re-authenticate
                          </button>
                        }
                        @if (server.actions.canToggle) {
                          <button
                            type="button"
                            class="cw-mcp__btn"
                            [class.cw-mcp__btn--disable]="server.enabled"
                            [class.cw-mcp__btn--enable]="!server.enabled"
                            (click)="toggle.emit(server)"
                            [disabled]="busyServerName() === server.name"
                          >
                            {{ server.enabled ? 'Disable' : 'Enable' }}
                          </button>
                        }
                        @if (server.actions.canRecheck) {
                          <button
                            type="button"
                            class="cw-mcp__btn cw-mcp__btn--ghost"
                            (click)="recheck.emit(server)"
                            [disabled]="busyServerName() === server.name"
                          >
                            <ng-icon name="lucideRefreshCcw" size="10" />
                            Recheck
                          </button>
                        }
                      </div>
                    }
                  </article>
                }
              </section>
            }

            @if (current.diagnostics.length) {
              <section class="cw-mcp__section">
                <div class="cw-mcp__section-head">
                  <span class="cw-mcp__section-label">Diagnostics</span>
                  <span class="cw-mcp__section-count cw-mcp__section-count--warn">{{ current.diagnostics.length }}</span>
                </div>
                @for (diagnostic of current.diagnostics; track diagnostic.scope + diagnostic.configLocation) {
                  <article class="cw-mcp__diag">
                    <div class="cw-mcp__diag-head">
                      <strong>{{ scopeLabel(diagnostic.scope) }}</strong>
                      <span>{{ diagnostic.configLocation }}</span>
                    </div>
                    @for (error of diagnostic.errors; track diagnosticKey(error)) {
                      <div class="cw-mcp__diag-msg cw-mcp__diag-msg--error">{{ diagnosticMessage(error) }}</div>
                    }
                    @for (warning of diagnostic.warnings; track diagnosticKey(warning)) {
                      <div class="cw-mcp__diag-msg cw-mcp__diag-msg--warning">{{ diagnosticMessage(warning) }}</div>
                    }
                  </article>
                }
              </section>
            }

          } @else {
            <div class="cw-mcp__empty">
              <ng-icon name="lucidePlugZap" size="26" />
              <span>No MCP servers configured</span>
            </div>
          }
        </div>

      </aside>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      @keyframes mcpBackdropIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes mcpSlideIn {
        from { transform: translateX(100%); }
        to { transform: translateX(0); }
      }
      @keyframes shimmer {
        from { background-position: -200% 0; }
        to { background-position: 200% 0; }
      }

      .cw-mcp__backdrop {
        position: fixed;
        inset: 0;
        background: color-mix(in oklab, #000 30%, transparent);
        z-index: 42;
        animation: mcpBackdropIn 0.15s ease-out;
      }

      .cw-mcp {
        position: fixed;
        top: 0;
        right: 0;
        width: min(34rem, 96vw);
        height: 100dvh;
        z-index: 43;
        display: flex;
        flex-direction: column;
        background: var(--background);
        border-left: 1px solid var(--border);
        box-shadow: -20px 0 60px -20px color-mix(in oklab, #000 40%, transparent);
        animation: mcpSlideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      }

      /* ─── Header ─────────────────────────────────────── */
      .cw-mcp__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.9rem 1.1rem;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }
      .cw-mcp__head-title {
        display: flex;
        align-items: center;
        gap: 0.65rem;
      }
      .cw-mcp__head-icon {
        width: 2rem;
        height: 2rem;
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--primary) 12%, transparent);
        color: var(--primary);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .cw-mcp__head h3 {
        margin: 0;
        font-size: 0.875rem;
        font-weight: 700;
        color: var(--foreground);
        line-height: 1.2;
      }
      .cw-mcp__head p {
        margin: 0.15rem 0 0;
        font-size: 0.72rem;
        color: var(--muted-foreground);
      }
      .cw-mcp__head-actions {
        display: inline-flex;
        gap: 0.3rem;
        flex-shrink: 0;
      }
      .cw-mcp__icon-btn {
        width: 1.75rem;
        height: 1.75rem;
        border: 0;
        border-radius: 0.4rem;
        background: transparent;
        color: var(--muted-foreground);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.1s, color 0.1s;
      }
      .cw-mcp__icon-btn:hover {
        background: color-mix(in oklab, var(--foreground) 8%, transparent);
        color: var(--foreground);
      }
      .cw-mcp__icon-btn:disabled {
        opacity: 0.4;
        cursor: default;
      }

      /* ─── Body ───────────────────────────────────────── */
      .cw-mcp__body {
        flex: 1;
        overflow: auto;
        padding: 1rem 1.1rem 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }

      /* ─── Summary ────────────────────────────────────── */
      .cw-mcp__summary {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.45rem;
      }
      .cw-mcp__metric {
        padding: 0.6rem 0.7rem;
        border: 1px solid var(--border);
        border-radius: 0.75rem;
        background: color-mix(in oklab, var(--card) 96%, white 4%);
        transition: border-color 0.15s;
      }
      .cw-mcp__metric strong {
        display: block;
        font-size: 1.05rem;
        font-weight: 700;
        color: var(--muted-foreground);
        line-height: 1.25;
      }
      .cw-mcp__metric span {
        font-size: 0.65rem;
        color: var(--muted-foreground);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        opacity: 0.7;
      }
      .cw-mcp__metric--connected {
        border-color: color-mix(in oklab, oklch(0.62 0.18 150) 30%, var(--border));
      }
      .cw-mcp__metric--connected strong { color: oklch(0.62 0.18 150); }
      .cw-mcp__metric--warn {
        border-color: color-mix(in oklab, oklch(0.65 0.16 65) 30%, var(--border));
      }
      .cw-mcp__metric--warn strong { color: oklch(0.62 0.16 65); }
      .cw-mcp__metric--error {
        border-color: color-mix(in oklab, var(--destructive) 30%, var(--border));
      }
      .cw-mcp__metric--error strong { color: var(--destructive); }

      /* ─── Section ────────────────────────────────────── */
      .cw-mcp__section {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .cw-mcp__section-head {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0 0.1rem;
        margin-bottom: 0.1rem;
      }
      .cw-mcp__section-label {
        font-size: 0.7rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: var(--muted-foreground);
      }
      .cw-mcp__section-count {
        font-size: 0.65rem;
        padding: 0.05rem 0.35rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
        color: var(--muted-foreground);
      }
      .cw-mcp__section-count--warn {
        background: color-mix(in oklab, oklch(0.65 0.16 65) 15%, transparent);
        color: oklch(0.58 0.16 65);
      }

      /* ─── Cards ──────────────────────────────────────── */
      .cw-mcp__card {
        padding: 0.75rem 0.85rem;
        border: 1px solid var(--border);
        border-radius: 0.8rem;
        background: var(--card);
        position: relative;
        overflow: hidden;
        transition: border-color 0.12s;
      }
      .cw-mcp__card::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 3px;
        height: 100%;
        background: transparent;
        border-radius: 0.8rem 0 0 0.8rem;
        transition: background 0.12s;
      }
      .cw-mcp__card[data-status='connected']::before {
        background: oklch(0.62 0.18 150);
      }
      .cw-mcp__card[data-status='needs-auth']::before {
        background: oklch(0.65 0.16 65);
      }
      .cw-mcp__card[data-status='failed']::before {
        background: var(--destructive);
      }

      .cw-mcp__card-top {
        display: flex;
        align-items: flex-start;
        gap: 0.55rem;
      }

      /* Status dot */
      .cw-mcp__status-dot {
        width: 0.42rem;
        height: 0.42rem;
        border-radius: 999px;
        flex-shrink: 0;
        margin-top: 0.3rem;
        background: color-mix(in oklab, var(--foreground) 18%, transparent);
      }
      .cw-mcp__status-dot[data-status='connected'] {
        background: oklch(0.62 0.18 150);
        box-shadow: 0 0 0 2px color-mix(in oklab, oklch(0.62 0.18 150) 20%, transparent);
      }
      .cw-mcp__status-dot[data-status='needs-auth'] {
        background: oklch(0.65 0.16 65);
        box-shadow: 0 0 0 2px color-mix(in oklab, oklch(0.65 0.16 65) 20%, transparent);
      }
      .cw-mcp__status-dot[data-status='failed'] {
        background: var(--destructive);
        box-shadow: 0 0 0 2px color-mix(in oklab, var(--destructive) 20%, transparent);
      }

      .cw-mcp__card-info {
        flex: 1;
        min-width: 0;
      }
      .cw-mcp__card-name {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--foreground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cw-mcp__card-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 0.28rem;
        margin-top: 0.28rem;
      }

      /* Badges */
      .cw-mcp__badge {
        font-size: 0.65rem;
        padding: 0.1rem 0.38rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        color: var(--muted-foreground);
        line-height: 1.4;
      }
      .cw-mcp__badge--transport {
        background: color-mix(in oklab, var(--primary) 10%, transparent);
        color: var(--primary);
      }
      .cw-mcp__badge--status[data-status='connected'] {
        background: color-mix(in oklab, oklch(0.62 0.18 150) 12%, transparent);
        color: oklch(0.55 0.18 150);
      }
      .cw-mcp__badge--status[data-status='needs-auth'] {
        background: color-mix(in oklab, oklch(0.65 0.16 65) 12%, transparent);
        color: oklch(0.58 0.16 65);
      }
      .cw-mcp__badge--status[data-status='failed'] {
        background: color-mix(in oklab, var(--destructive) 12%, transparent);
        color: var(--destructive);
      }
      .cw-mcp__badge--config-warn {
        background: color-mix(in oklab, oklch(0.65 0.16 65) 12%, transparent);
        color: oklch(0.58 0.16 65);
      }

      /* Config location */
      .cw-mcp__location {
        margin-top: 0.55rem;
        font-size: 0.68rem;
        font-family: ui-monospace, 'Cascadia Code', monospace;
        color: var(--muted-foreground);
        word-break: break-all;
        opacity: 0.65;
        line-height: 1.4;
      }

      /* Error box */
      .cw-mcp__error {
        display: flex;
        align-items: flex-start;
        gap: 0.4rem;
        margin-top: 0.55rem;
        padding: 0.45rem 0.6rem;
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--destructive) 8%, transparent);
        border: 1px solid color-mix(in oklab, var(--destructive) 18%, transparent);
        font-size: 0.73rem;
        color: var(--destructive);
        line-height: 1.45;
      }

      /* Counts */
      .cw-mcp__counts {
        display: flex;
        flex-wrap: wrap;
        gap: 0.28rem;
        margin-top: 0.55rem;
      }
      .cw-mcp__counts span {
        font-size: 0.65rem;
        padding: 0.1rem 0.38rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
        color: var(--muted-foreground);
      }

      /* Tools */
      .cw-mcp__tools {
        margin-top: 0.6rem;
      }
      .cw-mcp__tools summary {
        cursor: pointer;
        font-size: 0.73rem;
        color: var(--muted-foreground);
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        user-select: none;
        list-style: none;
        transition: color 0.1s;
      }
      .cw-mcp__tools summary::-webkit-details-marker { display: none; }
      .cw-mcp__tools summary:hover { color: var(--foreground); }
      .cw-mcp__tool-list {
        margin-top: 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.28rem;
      }
      .cw-mcp__tool-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.32rem 0.5rem;
        border-radius: 0.45rem;
        background: color-mix(in oklab, var(--foreground) 3%, transparent);
      }
      .cw-mcp__tool-name {
        font-size: 0.78rem;
        color: var(--foreground);
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cw-mcp__tool-code {
        font-size: 0.65rem;
        font-family: ui-monospace, 'Cascadia Code', monospace;
        color: var(--muted-foreground);
        flex-shrink: 0;
      }

      /* Action buttons */
      .cw-mcp__card-actions {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin-top: 0.7rem;
        flex-wrap: wrap;
      }
      .cw-mcp__btn {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        border: 1px solid var(--border);
        border-radius: 0.45rem;
        background: transparent;
        color: var(--foreground);
        font-size: 0.72rem;
        padding: 0.3rem 0.65rem;
        cursor: pointer;
        transition: background 0.1s, border-color 0.1s, color 0.1s;
        font-family: inherit;
      }
      .cw-mcp__btn:hover {
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
      }
      .cw-mcp__btn:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .cw-mcp__btn--auth {
        background: color-mix(in oklab, oklch(0.65 0.16 65) 10%, transparent);
        border-color: color-mix(in oklab, oklch(0.65 0.16 65) 28%, transparent);
        color: oklch(0.58 0.16 65);
        font-weight: 500;
      }
      .cw-mcp__btn--auth:hover:not(:disabled) {
        background: color-mix(in oklab, oklch(0.65 0.16 65) 18%, transparent);
      }
      .cw-mcp__btn--disable {
        color: var(--muted-foreground);
      }
      .cw-mcp__btn--enable {
        background: color-mix(in oklab, oklch(0.62 0.18 150) 10%, transparent);
        border-color: color-mix(in oklab, oklch(0.62 0.18 150) 28%, transparent);
        color: oklch(0.55 0.18 150);
      }
      .cw-mcp__btn--enable:hover:not(:disabled) {
        background: color-mix(in oklab, oklch(0.62 0.18 150) 18%, transparent);
      }
      .cw-mcp__btn--ghost {
        border-color: transparent;
        color: var(--muted-foreground);
      }
      .cw-mcp__btn--ghost:hover:not(:disabled) {
        border-color: var(--border);
        color: var(--foreground);
        background: color-mix(in oklab, var(--foreground) 4%, transparent);
      }

      /* ─── Diagnostics ────────────────────────────────── */
      .cw-mcp__diag {
        padding: 0.65rem 0.75rem;
        border: 1px solid color-mix(in oklab, oklch(0.65 0.16 65) 25%, var(--border));
        border-radius: 0.75rem;
        background: color-mix(in oklab, oklch(0.65 0.16 65) 4%, var(--card));
      }
      .cw-mcp__diag-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.8rem;
      }
      .cw-mcp__diag-head strong {
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--foreground);
      }
      .cw-mcp__diag-head span {
        font-size: 0.68rem;
        font-family: ui-monospace, 'Cascadia Code', monospace;
        color: var(--muted-foreground);
        word-break: break-all;
        text-align: right;
      }
      .cw-mcp__diag-msg {
        margin-top: 0.4rem;
        font-size: 0.73rem;
        line-height: 1.45;
        padding: 0.32rem 0.5rem;
        border-radius: 0.4rem;
      }
      .cw-mcp__diag-msg--error {
        background: color-mix(in oklab, var(--destructive) 8%, transparent);
        color: var(--destructive);
      }
      .cw-mcp__diag-msg--warning {
        background: color-mix(in oklab, oklch(0.65 0.16 65) 8%, transparent);
        color: oklch(0.58 0.16 65);
      }

      /* ─── Empty ──────────────────────────────────────── */
      .cw-mcp__empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        min-height: 14rem;
        color: var(--muted-foreground);
        font-size: 0.84rem;
        opacity: 0.5;
      }

      /* ─── Loading skeleton ───────────────────────────── */
      .cw-mcp__loading {
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
      }
      .cw-mcp__skeleton {
        height: 5rem;
        border-radius: 0.8rem;
        background: linear-gradient(
          90deg,
          color-mix(in oklab, var(--foreground) 4%, transparent) 25%,
          color-mix(in oklab, var(--foreground) 9%, transparent) 50%,
          color-mix(in oklab, var(--foreground) 4%, transparent) 75%
        );
        background-size: 200% 100%;
        animation: shimmer 1.6s infinite;
      }
      .cw-mcp__skeleton--summary {
        height: 3.5rem;
      }
      .cw-mcp__skeleton--sm {
        height: 3rem;
      }

      @media (max-width: 640px) {
        .cw-mcp__summary {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    `,
  ],
})
export class ClaudeMcpDrawerComponent {
  readonly open = input<boolean>(false);
  readonly loading = input<boolean>(false);
  readonly snapshot = input<ClaudeMcpSnapshot | null>(null);
  readonly busyServerName = input<string | null>(null);

  readonly close = output<void>();
  readonly refresh = output<void>();
  readonly toggle = output<ClaudeMcpServerEntry>();
  readonly recheck = output<ClaudeMcpServerEntry>();
  readonly auth = output<ClaudeMcpServerEntry>();

  readonly groupedServers = computed(() => {
    const servers = this.snapshot()?.servers ?? [];
    return [
      { scope: 'project', label: 'Project', servers: servers.filter((s) => s.scope === 'project') },
      { scope: 'local', label: 'Local', servers: servers.filter((s) => s.scope === 'local') },
      { scope: 'user', label: 'User', servers: servers.filter((s) => s.scope === 'user') },
      { scope: 'enterprise', label: 'Enterprise', servers: servers.filter((s) => s.scope === 'enterprise') },
      { scope: 'runtime', label: 'Runtime / Other', servers: servers.filter((s) => s.scope === 'runtime') },
    ].filter((g) => g.servers.length > 0);
  });

  readonly expandedTools = signal<Record<string, boolean>>({});

  statusLabel(server: ClaudeMcpServerEntry): string {
    return server.connectionStatus.replace('-', ' ');
  }

  scopeLabel(scope: ClaudeMcpDiagnosticGroup['scope']): string {
    const labels: Record<string, string> = {
      project: 'Project',
      local: 'Local',
      user: 'User',
      enterprise: 'Enterprise',
    };
    return labels[scope] ?? 'Runtime / Other';
  }

  diagnosticKey(message: { serverName?: string; path?: string; message: string }): string {
    return `${message.serverName ?? 'file'}:${message.path ?? ''}:${message.message}`;
  }

  diagnosticMessage(message: { serverName?: string; path?: string; message: string }): string {
    return [message.serverName, message.path, message.message].filter(Boolean).join(' · ');
  }
}
