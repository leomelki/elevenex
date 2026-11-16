import { RuntimeInputLane } from './runtime-input-lane.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe('runtime input ordering', () => {
  it('overlaps at most four compatible moves and drains every receipt before a barrier', async () => {
    const lane = new RuntimeInputLane(),
      receipts = Array.from({ length: 6 }, deferred),
      sent: number[] = [];
    const requests = receipts.map((receipt, index) =>
      lane.enqueue(
        async () => {
          sent.push(index);
          await receipt.promise;
        },
        index < 5 ? 'lock-1:buttons-0:modifiers-0' : undefined,
      ),
    );
    await settle();
    expect(sent).toEqual([0, 1, 2, 3]);
    receipts[2].resolve();
    await settle();
    expect(sent).toEqual([0, 1, 2, 3, 4]);
    for (const i of [0, 4, 3]) {
      receipts[i].resolve();
      await settle();
    }
    expect(sent).toHaveLength(5);
    receipts[1].resolve();
    await settle();
    expect(sent).toEqual([0, 1, 2, 3, 4, 5]);
    receipts[5].resolve();
    await Promise.all(requests);
    await lane.settled();
    expect(lane.idle).toBe(true);
    lane.destroy();
  });

  it('never overlaps a different motion identity or interleaves a complete batch', async () => {
    const lane = new RuntimeInputLane(),
      receipt = deferred(),
      batchReceipt = deferred(),
      sent: string[] = [];
    const first = lane.enqueue(async () => {
      sent.push('old lock');
      await receipt.promise;
    }, 'old');
    const changed = lane.enqueue(() => {
      sent.push('new lock');
      return Promise.resolve();
    }, 'new');
    const batch = lane.enqueue(async () => {
      sent.push('batch start');
      await batchReceipt.promise;
      sent.push('batch end');
    });
    const after = lane.enqueue(() => {
      sent.push('after batch');
      return Promise.resolve();
    }, 'new');
    await settle();
    expect(sent).toEqual(['old lock']);
    receipt.resolve();
    await settle();
    expect(sent).toEqual(['old lock', 'new lock', 'batch start']);
    batchReceipt.resolve();
    await Promise.all([first, changed, batch, after]);
    expect(sent).toEqual([
      'old lock',
      'new lock',
      'batch start',
      'batch end',
      'after batch',
    ]);
    lane.destroy();
  });

  it('bounds admissions, rejects queued work on disposal and retains active receipt ownership', async () => {
    const lane = new RuntimeInputLane(2),
      receipt = deferred(),
      run = jest.fn(() => Promise.resolve());
    const active = lane.enqueue(() => receipt.promise);
    const queued = lane.enqueue(run);
    const rejected = expect(queued).rejects.toThrow('stopped');
    await expect(lane.enqueue(run)).rejects.toThrow('capacity');
    await settle();
    lane.destroy();
    await rejected;
    expect(run).not.toHaveBeenCalled();
    expect(lane.idle).toBe(false);
    receipt.resolve();
    await active;
    await lane.settled();
    expect(lane.idle).toBe(true);
  });
});
