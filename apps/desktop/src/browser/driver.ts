/** Single synchronous authority for native input and automation. No queued input survives revocation. */
export class BrowserDriverLease {
  driver: 'you' | 'agent' | 'needs';
  generation = 1;
  waiting = false;
  constructor(readonly by: 'you' | 'agent', public agentSessionId: number | null = null) { this.driver = by; }
  takeOver(needs = false): void { this.waiting ||= this.driver === 'agent'; this.driver = needs ? 'needs' : 'you'; this.generation++; }
  handBack(sessionId: number): void { this.agentSessionId = sessionId; this.driver = 'agent'; this.waiting = false; this.generation++; }
  assert(generation: number, sessionId?: number): void {
    if (this.driver !== 'agent' || this.generation !== generation || (sessionId !== undefined && this.agentSessionId !== sessionId)) throw new Error('Browser control changed. Read state; wait for explicit handoff.');
  }
}
