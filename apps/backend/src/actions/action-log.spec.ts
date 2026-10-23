import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  ACTION_LOG_BYTES,
  ACTION_LOG_WRITER,
  readActionLog,
  readActionLogSnapshot,
  readFileTail,
} from './action-log.js';

describe('action log storage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'action-log-test-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a bounded suffix from a multi-gigabyte sparse legacy log', async () => {
    const log = path.join(dir, 'legacy.log');
    const file = await fs.open(log, 'w');
    await file.truncate(4 * 1024 ** 3);
    await file.write(Buffer.from('final output'), 0, 12, 4 * 1024 ** 3 - 12);
    await file.close();
    const readFile = jest.spyOn(fs, 'readFile');
    try {
      expect((await readFileTail(log, 12)).toString()).toBe('final output');
      const output = await readActionLog(log);
      expect(output.length).toBe(50_000);
      expect(output.endsWith('final output')).toBe(true);
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }
  });

  it('rotates under sustained output and drains the final suffix in order', async () => {
    const log = path.join(dir, 'rotated.log');
    const child = spawn(process.execPath, ['-e', ACTION_LOG_WRITER, log], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const closed = once(child, 'close');
    let errors = '';
    child.stderr.on('data', (data) => {
      errors += data;
    });
    const content = Buffer.from(
      'αβγδ'.repeat(ACTION_LOG_BYTES) + '\r\nFINAL\r\n',
    );
    child.stdin.end(content);
    const [code] = await closed;
    expect(errors).toBe('');
    expect(code).toBe(0);
    expect(await fs.stat(log + '.ready')).toBeDefined();
    expect(await fs.stat(log + '.done')).toBeDefined();
    expect((await fs.stat(log)).size).toBeLessThanOrEqual(ACTION_LOG_BYTES);
    expect((await fs.stat(log + '.1')).size).toBe(ACTION_LOG_BYTES);
    expect(await readActionLog(log)).toBe(
      content.toString('utf8').slice(-50_000),
    );
    expect((await fs.readdir(dir)).sort()).toEqual([
      'rotated.log',
      'rotated.log.1',
      'rotated.log.done',
      'rotated.log.ready',
    ]);
  });
  it('captures the replay boundary before reads, retaining bytes appended during the snapshot for follow', async () => {
    const log = path.join(dir, 'append.log');
    await fs.writeFile(log, 'before');
    const file = await fs.open(log, 'r');
    const stat = file.stat.bind(file);
    const open = jest.spyOn(fs, 'open').mockResolvedValueOnce(file);
    const captured = jest
      .spyOn(file as any, 'stat')
      .mockImplementation(async () => {
        const result = await stat();
        await fs.appendFile(log, ' after');
        return result;
      });
    try {
      expect(await readActionLogSnapshot(log)).toEqual({
        output: 'before',
        endOffset: 6,
      });
    } finally {
      open.mockRestore();
      captured.mockRestore();
    }
    expect((await readFileTail(log, 6)).toString()).toBe(' after');
  });
});
