import { x11Input } from './x11-input.js';
import { LINUX_APP_PROGRAM_PATH } from './app-host-setup.js';

// The backend bundle carries this helper verbatim, so a remote engine does not
// need a checkout or a native Node addon. fd 3 belongs only to the supervisor.
export const linuxSupervisor =
  String.raw`
import ctypes, json, math, os, select, shutil, signal, socket, struct, subprocess, sys, tempfile, time

` +
  x11Input +
  String.raw`

def report(**event):
    os.write(3, (json.dumps(event, ensure_ascii=True) + '\n').encode())

def children():
    with open('/proc/self/task/%d/children' % os.getpid()) as source:
        return [int(value) for value in source.read().split()]

def reap(pid):
    try:
        return bool(os.waitpid(pid, os.WNOHANG)[0])
    except ChildProcessError:
        return True

def stop_tree():
    # The subreaper adopts orphaned grandchildren, including children which
    # changed session/process group. Signal only live, unreaped children.
    deadline = time.monotonic() + 1.2
    while True:
        living = [pid for pid in children() if not reap(pid)]
        if not living:
            return
        sig = signal.SIGKILL if time.monotonic() >= deadline else signal.SIGTERM
        for pid in living:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        time.sleep(0.03)

def terminated(signum, frame):
    raise SystemExit(128 + signum)

def system_program(name):
    path = shutil.which(name, path='${LINUX_APP_PROGRAM_PATH}')
    if not path:
        raise RuntimeError('Install %s on the Linux task host' % name)
    return path

def xauthority(path, cookie):
    def field(value):
        return struct.pack('>H', len(value)) + value
    with open(path, 'xb') as stream:
        stream.write(struct.pack('>H', 65535) + field(b'') + field(b'') +
                     field(b'MIT-MAGIC-COOKIE-1') + field(cookie))

def graphical_session(directory, size):
    env = os.environ.copy()
    for key in ('DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
                'DBUS_SESSION_BUS_PID', 'DBUS_STARTER_ADDRESS', 'SESSION_MANAGER', 'DESKTOP_STARTUP_ID',
                'XDG_ACTIVATION_TOKEN', 'XDG_CURRENT_DESKTOP'):
        env.pop(key, None)
    for name in ('RUNTIME', 'CONFIG', 'DATA', 'CACHE', 'STATE'):
        path = os.path.join(directory, name.lower())
        os.mkdir(path, 0o700)
        env['XDG_' + name + ('_DIR' if name == 'RUNTIME' else '_HOME')] = path
    cookie = os.urandom(16)
    auth = os.path.join(directory, 'Xauthority')
    xauthority(auth, cookie)
    env.update(XAUTHORITY=auth, XDG_SESSION_TYPE='x11', GDK_BACKEND='x11',
               QT_QPA_PLATFORM='xcb', ELECTRON_OZONE_PLATFORM_HINT='x11')
    reader, writer = os.pipe()
    try:
        xvfb = subprocess.Popen([system_program('Xvfb'), '-displayfd', str(writer), '-auth', auth,
            '-screen', '0', '%dx%dx24' % (size['width'], size['height']), '-nolisten', 'tcp', '-noreset'], pass_fds=(writer,),
            stdin=subprocess.DEVNULL, env=env)
    finally:
        os.close(writer)
    try:
        if not select.select([reader], [], [], 5)[0]:
            raise RuntimeError('Private X display did not start in time')
        number = b''
        while b'\n' not in number and len(number) < 16:
            part = os.read(reader, 16 - len(number))
            if not part:
                break
            number += part
        number = number.strip()
        if not number.isdigit():
            raise RuntimeError('Xvfb could not start a private display')
    finally:
        os.close(reader)
    env['DISPLAY'] = ':' + number.decode()
    source = PrivateInput(int(number), cookie, size)
    env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + os.path.join(directory, 'bus')
    bus = subprocess.Popen([system_program('dbus-daemon'), '--session', '--nofork',
        '--address=' + env['DBUS_SESSION_BUS_ADDRESS']], env=env, stdin=subprocess.DEVNULL)
    start = time.monotonic()
    while not os.path.exists(os.path.join(directory, 'bus')):
        if bus.poll() is not None or time.monotonic() - start > 3:
            raise RuntimeError('Private D-Bus session failed to start')
        time.sleep(0.01)
    infrastructure = [xvfb, bus]
    manager = next((path for path in ('/usr/bin/openbox', '/usr/bin/fluxbox',
                   '/usr/bin/xfwm4', '/usr/bin/twm') if os.access(path, os.X_OK)), None)
    if manager:
        infrastructure.append(subprocess.Popen([manager], env=env, stdin=subprocess.DEVNULL))
    else:
        source.focus_on_click = True
    return env, source, infrastructure

def run(command):
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('Linux child-process supervision is unavailable')
    with tempfile.TemporaryDirectory(prefix='display-', dir=os.environ['ELEVENEX_TASK_APP_RUNTIME_DIR']) as directory:
        proof = os.environ.pop('ELEVENEX_TASK_APP_DRAIN_PROOF', None)
        if proof:
            marker = os.path.join(os.environ['ELEVENEX_TASK_APP_RUNTIME_DIR'], '.supervisor-drained')
            os.unlink(marker)
        try:
            env, source, infrastructure = os.environ.copy(), None, []
            if command['mode'] == 'stream':
                env, source, infrastructure = graphical_session(directory, command['displaySize'])
            app = subprocess.Popen([command['executable'], *command['args']], env=env,
                start_new_session=True, stdin=subprocess.DEVNULL)
            ready = False
            buffer = b''
            while True:
                if not ready and (not source or source.has_window(command.get('fit', True))):
                    report(kind='ready', display=env.get('DISPLAY') if source else None,
                           authority=env.get('XAUTHORITY') if source else None)
                    ready = True
                code = app.poll()
                if code is not None:
                    infrastructure_ids = {p.pid for p in infrastructure}
                    if not any(not reap(pid) for pid in children() if pid not in infrastructure_ids):
                        if source and not ready and code == 0:
                            report(kind='error', message='The launch exited before opening a window. Check the app output and profile.')
                        report(kind='exit', code=code)
                        return
                if any(p.poll() is not None for p in infrastructure):
                    raise RuntimeError('Private display service exited')
                if not select.select([0], [], [], 0.4 if ready else 0.12)[0]:
                    continue
                chunk = os.read(0, 16384)
                if not chunk:
                    return
                buffer += chunk
                if len(buffer) > 65536:
                    raise RuntimeError('Input message exceeds host limit')
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    if source:
                        source.apply(json.loads(line))
        finally:
            stop_tree()
            if proof:
                os.close(os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))

try:
    signal.signal(signal.SIGTERM, terminated)
    packet = sys.stdin.buffer.readline(262145)
    if len(packet) > 262144:
        raise RuntimeError('App launch specification exceeds host limit')
    command = json.loads(packet)
    run(command)
except Exception as error:
    report(kind='error', message=str(error)[:320])
    sys.exit(1)
`;
