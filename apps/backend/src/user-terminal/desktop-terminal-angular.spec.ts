import { resolve } from 'node:path';
import { UserPtyManager } from './user-pty-manager.service.js';
import { TerminalOutputEvents } from './terminal-output-events.js';

// Opt in: this builds the real renderer and starts its installed Angular CLI.
// Ordinary backend tests must also run without the renderer's dependencies.
const suite =
  process.env.ELEVENEX_TEST_ANGULAR_TERMINAL === '1' ? describe : describe.skip;

suite('Terminal URL discovery with a real Angular dev server', () => {
  it.each([false, true])(
    'parses PTY output, verifies socket ownership and serves the advertised path (color: %s)',
    async (color) => {
      const renderer = resolve(__dirname, '../../../renderer');
      const ptys = new UserPtyManager({
        sendToTerminal: () => {},
        onProcessExit: () => {},
      } as never);
      const id = 1;
      const path = '/terminal-url-check/';
      const args = [
        // Vite honors the presence of NO_COLOR even when FORCE_COLOR is set.
        // Confine the override to the child, after the login-shell env is merged.
        '--eval',
        (color
          ? "delete process.env.NO_COLOR; process.env.FORCE_COLOR = '1';"
          : "delete process.env.FORCE_COLOR; process.env.NO_COLOR = '1';") +
          'require(process.argv[1]);',
        resolve(renderer, 'node_modules/@angular/cli/bin/ng.js'),
        'serve',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--serve-path',
        path,
      ];
      try {
        await ptys.spawnDesktop(id, renderer, process.execPath, {
          id: 'angular',
          file: process.execPath,
          args,
          cmd: 'ng serve --host 127.0.0.1 --port 0 --serve-path ' + path,
        });
        const stream = ptys.desktopStream(id);
        if (!stream) throw new Error('Angular terminal was not created');
        const deadline = Date.now() + 90_000;
        while (stream.services.primary?.path !== path) {
          if (
            !ptys.isAlive(id) ||
            stream.services.discovery === 'unavailable' ||
            Date.now() > deadline
          )
            throw new Error(
              'Angular did not advertise a service:\n' +
                stream.read(null, 0).data,
            );
          await ptys.refreshDesktopPorts();
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const service = stream.services.primary;
        if (!service) throw new Error('Angular listener disappeared');
        expect(stream.status).toBe('serving');
        expect(stream.services.discovery).toBe('process');
        expect(service).toMatchObject({
          host: '127.0.0.1',
          protocol: 'http',
          path,
        });

        const output = stream.read(null, 0).data;
        const line = output
          .split('\n')
          .find((line) => line.includes('http://'));
        if (!line) throw new Error('Angular did not print a URL:\n' + output);
        expect(line.includes('\x1b[')).toBe(color);
        // Assert parser events directly: listener discovery alone would otherwise
        // make a broken URL finder appear to work with default HTTP/root values.
        for (let split = 0; split <= line.length; split++) {
          const parser = new TerminalOutputEvents(null);
          const receive = jest.fn();
          parser.append(line.slice(0, split), receive);
          parser.append(line.slice(split) + '\n', receive);
          expect(receive).toHaveBeenCalledWith(
            expect.objectContaining({
              type: 'service',
              port: service.port,
              protocol: 'http',
              path,
            }),
          );
        }
        const response = await fetch(
          `http://${service.host}:${service.port}${service.path}`,
          { signal: AbortSignal.timeout(5000) },
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('</ex-root>');
        await ptys.destroy(id, true);
        expect(stream.port).toBeNull();
        expect(stream.status).toBe('exited');
      } finally {
        try {
          await ptys.destroy(id, true);
        } finally {
          ptys.onModuleDestroy();
        }
      }
    },
    120_000,
  );
});
