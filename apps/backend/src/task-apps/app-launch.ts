import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { buildAugmentedEnvAsync } from '../config/system-paths.js';
import { prepareAndroidApp } from './android-app.js';
import { DarwinAppDisplay } from './darwin-display.js';
import { windowsAppHelper } from './windows-display.js';
import type { AppHostReady } from './app-host-setup.js';
import { windowsLaunchCommand } from './windows-launch.js';
import { appDisplaySize, type AppDisplaySize } from './app-display-size.js';
import { linuxSupervisor } from './linux-supervisor.js';

export interface AppLaunch {
  taskId: number;
  cwd: string;
  executable: string;
  args: readonly string[];
  requestId: string;
  name: string;
  mode: 'native' | 'stream';
  android?: { avd: string };
  readonly virtualDisplay?: AppDisplaySize;
  savedAction?: { id: number; command: string };
}

export function launchFingerprint(request: AppLaunch): string {
  return JSON.stringify([
    request.cwd,
    request.name,
    request.executable,
    request.args,
    request.mode,
    request.android?.avd,
    request.savedAction?.id,
    request.savedAction?.command,
    // Omit the trailing optional fields for previously issued request hashes.
    ...(request.virtualDisplay ? [request.virtualDisplay.width, request.virtualDisplay.height] : []),
  ]);
}

export function validLaunch(request: AppLaunch): void {
  const validString = (value: string, cap: number) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= cap &&
    !value.includes('\0');
  if (
    !Number.isSafeInteger(request.taskId) ||
    request.taskId <= 0 ||
    !validString(request.requestId, 128) ||
    !validString(request.name, 100) ||
    !isAbsolute(request.cwd) ||
    !validString(request.cwd, 4096) ||
    !validString(request.executable, 1024) ||
    (request.savedAction !== undefined &&
      (!Number.isSafeInteger(request.savedAction.id) ||
        request.savedAction.id < 1 ||
        !validString(request.savedAction.command, 8192))) ||
    !Array.isArray(request.args) ||
    request.args.length > 64 ||
    request.args.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.includes('\0') ||
        argument.length > (request.savedAction ? 8192 : 2048),
    ) ||
    request.args.reduce((sum, argument) => sum + argument.length, 0) > 32_768 ||
    !['native', 'stream'].includes(request.mode)
  )
    throw new Error('Invalid app launch');
  if (request.virtualDisplay) {
    if (process.platform !== 'linux' || request.mode !== 'stream') throw new Error('A virtual display size requires a streamed Linux app.');
    appDisplaySize(request);
  }
  if (!['win32', 'darwin', 'linux'].includes(process.platform))
    throw new Error('This host OS does not support task app launches');
}

export function appEnvironment(
  runId: string,
  directory: string,
  taskEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Forward development toolchain configuration deliberately. The backend's
  // API/provider credentials and Node/Electron injection flags stay private.
  const env: NodeJS.ProcessEnv = {};
  const names =
    /^(?:PATH|PATHEXT|HOME|SHELL|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMP|TEMP|TMPDIR|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|HOMEDRIVE|HOMEPATH|DISPLAY|XAUTHORITY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_[A-Z_]+|JAVA_HOME|ANDROID_HOME|ANDROID_SDK_ROOT|ANDROID_AVD_HOME|PNPM_HOME|CARGO_HOME|RUSTUP_HOME|GOPATH|NVM_BIN|VOLTA_HOME|SDKROOT|DEVELOPER_DIR)$/i;
  for (const [name, value] of Object.entries(process.env))
    if (names.test(name)) env[name] = value;
  const toolchain =
    /^(?:PATH|JAVA_HOME|ANDROID_HOME|ANDROID_SDK_ROOT|ANDROID_AVD_HOME|PNPM_HOME|CARGO_HOME|RUSTUP_HOME|GOPATH|NVM_BIN|VOLTA_HOME|SDKROOT|DEVELOPER_DIR)$/i;
  for (const [name, value] of Object.entries(taskEnvironment))
    if (toolchain.test(name)) env[name] = value;
  env.ELEVENEX_TASK_APP_RUN_ID = runId;
  env.ELEVENEX_TASK_APP_RUNTIME_DIR = directory;
  return env;
}

interface Supervisor {
  child: ChildProcess;
  linuxLaunch?: {
    displaySize: AppDisplaySize;
    fit: boolean;
    mode: AppLaunch['mode'];
    executable: string;
    args: readonly string[];
  };
}

/** Prepare the launch without allocating a process until the caller's active
 * checkout still admits it. Helpers own their children and drain on stdin EOF. */
export async function spawnAppSupervisor(
  request: AppLaunch,
  runId: string,
  directory: string,
  signal: AbortSignal,
  journaled: boolean,
  host: AppHostReady,
): Promise<Supervisor> {
  const taskEnvironment = await buildAugmentedEnvAsync(
    process.env,
    request.cwd,
    { signal },
  );
  const env = appEnvironment(runId, directory, taskEnvironment);
  const command = request.android
    ? await prepareAndroidApp(request.android.avd, directory, env)
    : request;
  if ('env' in command) Object.assign(env, command.env);
  signal.throwIfAborted();
  if (journaled && process.platform !== 'win32') env.ELEVENEX_TASK_APP_DRAIN_PROOF = '1';
  const common = { cwd: request.cwd, env };

  if (process.platform === 'linux') {
    return {
      child: spawn('/usr/bin/python3', ['-I', '-u', '-c', linuxSupervisor], {
        ...common,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        detached: true,
      }),
      linuxLaunch: {
        displaySize: appDisplaySize(request),
        mode: request.mode,
        fit:
          !request.android &&
          !/(?:^|[\\/])(?:emulator|qemu-system-[^\\/]+)(?:\.exe)?$/i.test(
            command.executable,
          ),
        executable: command.executable,
        args: command.args,
      },
    };
  }
  if (process.platform === 'win32') {
    const launch = await windowsLaunchCommand(command, env, request.cwd);
    signal.throwIfAborted();
    return {
      child: spawn(
        windowsAppHelper(),
        ['--launch', runId, launch.executable, ...launch.args],
        { ...common, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      ),
    };
  }
  const launch = DarwinAppDisplay.launchCommand(command, host.darwinSession ?? 'direct', request.mode === 'stream');
  signal.throwIfAborted();
  return {
    child: spawn(launch.executable, [...launch.args], {
      ...common,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
    }),
  };
}
