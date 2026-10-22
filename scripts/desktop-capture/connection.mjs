/** Owns the Electron debugger attachment and bounded renderer diagnostics. */
export class CaptureConnection {
  constructor(debuggerConnection, report) {
    this.debugger = debuggerConnection;
    this.report = report;
    this.debugger.attach('1.3');
    this.message = (_event, method, params) => {
      if (method === 'Runtime.exceptionThrown') this.record('error', params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
      if (method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(params.type)) {
        this.record(params.type === 'error' ? 'error' : 'warning', params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' '));
      }
      if (method === 'Log.entryAdded' && ['error', 'warning'].includes(params.entry.level)) this.record(params.entry.level, params.entry.text);
      if (method === 'Network.responseReceived' && params.response.status >= 400) this.record('error', `HTTP ${params.response.status}: ${params.response.url}`);
      if (method === 'Network.loadingFailed' && !params.canceled) this.record('error', `${params.errorText} (${params.type})`);
    };
    this.debugger.on('message', this.message);
  }

  record(level, message) {
    const list = level === 'error' ? this.report.errors : this.report.warnings;
    if (list.length < 200) list.push(String(message).slice(0, 8000));
    else this.report.droppedDiagnostics++;
  }

  async initialize() {
    for (const domain of ['Runtime', 'Log', 'Network']) await this.send(`${domain}.enable`);
  }

  send(method, params = {}) { return this.debugger.sendCommand(method, params); }

  dispose() {
    this.debugger.removeListener('message', this.message);
    if (this.debugger.isAttached()) this.debugger.detach();
  }
}
