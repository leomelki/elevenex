const calls = [
  ['remoteHosts', 'remote:hosts', []],
  ['chooseRemoteSshFile', 'remote:choose-file', ['identity']],
  ['saveRemoteHost', 'remote:save-host', [{ name: 'dev', host: 'dev', forwardAgent: false }, null]],
  ['removeRemoteHost', 'remote:remove-host', ['host-id']],
  ['environmentStatus', 'environment:status', []],
  ['environmentBackendStatus', 'environment:backend-status', []],
  ['selectEnvironment', 'environment:select', [{ kind: 'local' }]],
  ['saveEnvironmentContext', 'environment:context', [{ projectId: null, taskId: null, sessionId: null, draft: '', cursor: null }, { kind: 'local' }]],
  ['retryRemote', 'remote:retry', []],
  ['pauseRemoteRecovery', 'remote:pause', []],
  ['disconnectRemote', 'remote:disconnect', []],
  ['answerRemoteChallenge', 'remote:answer', ['challenge-id', null]],
  ['addRemoteForward', 'remote:add-forward', [{ remotePort: 8000, localPort: 0, label: 'web' }]],
  ['retryRemoteForward', 'remote:retry-forward', ['forward-id']],
  ['removeRemoteForward', 'remote:remove-forward', ['forward-id']],
  ['remoteDiagnostics', 'remote:diagnostics', []],
];
module.exports = { calls, methods: [...calls.map(([name]) => name), 'onEnvironmentChanged'] };
