// A cancelled window must not cancel a connection another window is awaiting.
// Each caller owns a subscription; the last cancellation aborts the SSH work.
function createRemoteConnectionAttempts({ timeoutMs = 180000 } = {}) {
  const attempts = new Map();

  function run(serverId, callerId, factory) {
    let attempt = attempts.get(serverId);
    if (!attempt) {
      const controller = new AbortController();
      attempt = { controller, callers: new Map() };
      attempts.set(serverId, attempt);
      const timer = setTimeout(() => {
        controller.abort(new Error('SSH connection timed out. Check the network and retry.'));
      }, timeoutMs);
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      attempt.promise = Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return factory(controller.signal);
        }),
        aborted,
      ]).finally(() => {
        clearTimeout(timer);
        if (attempts.get(serverId) === attempt) attempts.delete(serverId);
      });
    }

    return new Promise((resolve, reject) => {
      attempt.callers.set(callerId, reject);
      attempt.promise.then(resolve, reject).finally(() => {
        attempt.callers.delete(callerId);
      });
    });
  }

  function cancel(serverId, callerId) {
    const attempt = attempts.get(serverId);
    const reject = attempt?.callers.get(callerId);
    if (!reject) return false;
    const error = new Error('SSH connection canceled. Automatic reconnection is paused.');
    reject(error);
    attempt.callers.delete(callerId);
    if (attempt.callers.size === 0) {
      attempts.delete(serverId);
      attempt.controller.abort(error);
    }
    return true;
  }

  function cancelWindow(windowId) {
    for (const [serverId, attempt] of attempts) {
      for (const callerId of [...attempt.callers.keys()]) {
        if (callerId.startsWith(`${windowId}:`)) cancel(serverId, callerId);
      }
    }
  }

  return { run, cancel, cancelWindow };
}

module.exports = { createRemoteConnectionAttempts };
