import { EventEmitter } from 'node:events';

export interface FSWatcher extends EventEmitter {
  on(event: string, listener: (...args: any[]) => void): this;
  close(): Promise<void>;
}

export const watch = jest.fn().mockImplementation(() => {
  const emitter = new EventEmitter() as FSWatcher;
  (emitter as any).close = jest.fn().mockResolvedValue(undefined);
  return emitter;
});

export default { watch };