/** Single synchronous authority for native input and automation. No queued input survives revocation. */
export class BrowserDriverLease {
  driver: 'you' | 'agent' | 'needs';
  generation = 1;
  waiting = false;
  ownership = 0;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { this.controlChanged(); for (const listener of this.listeners) listener(); }
  constructor(readonly by: 'you' | 'agent', public agentSessionId: number | null = null, private readonly releaseInput: () => void = () => undefined, private readonly controlChanged: () => void = () => undefined) { this.driver = by; }
  takeOver(needs = false): void { this.releaseInput(); this.ownership++; this.waiting ||= this.driver === 'agent'; this.driver = needs ? 'needs' : 'you'; this.generation++; this.changed(); }
  handBack(sessionId: number): void { this.releaseInput(); this.ownership++; this.agentSessionId = sessionId; this.driver = 'agent'; this.waiting = false; this.generation++; this.changed(); }
  assert(generation: number, sessionId?: number): void {
    if (this.driver !== 'agent' || this.generation !== generation || (sessionId !== undefined && this.agentSessionId !== sessionId)) throw new Error('Browser control changed. Read state; wait for explicit handoff.');
  }
}
