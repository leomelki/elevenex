// jsdom's visual clock can stall while Angular and CDK await a frame in CI.
// Drive fixture frames with cancellable timers. Real browser tests keep their clock.
if (navigator.userAgent.includes('jsdom')) {
  globalThis.requestAnimationFrame = window.requestAnimationFrame =
    callback => window.setTimeout(() => callback(performance.now()), 16);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame =
    id => window.clearTimeout(id);
}
