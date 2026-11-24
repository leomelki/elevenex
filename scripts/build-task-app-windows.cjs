'use strict';

const { execFile } = require('node:child_process');
const { mkdir, mkdtemp, copyFile, rm } = require('node:fs/promises');
const { join, dirname, isAbsolute, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function compilerEnvironment() {
  if (process.env.VCToolsInstallDir && process.env.WindowsSdkDir) return process.env;
  const base = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles;
  const vswhere = join(base, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const { stdout } = await run(vswhere, ['-latest', '-products', '*', '-property', 'installationPath']);
  const installation = stdout.trim();
  if (!isAbsolute(installation) || /["%\r\n]/.test(installation)) {
    throw new Error('Install Visual Studio with C++ build tools and the Windows SDK');
  }
  const setup = join(installation, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
  const arch = process.arch === 'arm64' ? 'amd64_arm64' : 'amd64';
  // The command includes only the discovered toolchain path and a fixed architecture.
  const result = await run(process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', 'call "' + setup + '" ' + arch + ' >nul && set'],
    { windowsVerbatimArguments: true, maxBuffer: 2 * 1024 * 1024 });
  const env = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const equal = line.indexOf('=');
    if (equal > 0) env[line.slice(0, equal)] = line.slice(equal + 1);
  }
  return env;
}

async function buildWindowsAppDisplay({ outputPath }) {
  if (process.platform !== 'win32') throw new Error('Build the Windows app helper on Windows');
  if (!isAbsolute(outputPath)) throw new Error('Expected an absolute helper output path');
  const sources = resolve(__dirname, '../apps/backend/src/task-apps/windows');
  const directory = await mkdtemp(join(tmpdir(), 'elevenex-app-build-'));
  try {
    const env = await compilerEnvironment();
    const target = join(directory, 'task-app-windows.exe');
    await run('cl.exe', ['/nologo', '/std:c++17', '/permissive-', '/EHsc', '/utf-8', '/O2', '/MT', '/guard:cf',
      '/DUNICODE', '/D_UNICODE', '/D_WIN32_WINNT=0x0A00',
      join(sources, 'main.cpp'), join(sources, 'launch.cpp'), join(sources, 'view.cpp'),
      '/Fe:' + target, '/link', '/DYNAMICBASE', '/NXCOMPAT', 'windowsapp.lib',
      'd3d11.lib', 'dwmapi.lib', 'advapi32.lib', 'user32.lib'],
    { cwd: directory, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      .catch(error => { throw new Error('Windows app helper build failed\n' + (error.stdout || error.message) + '\n' + (error.stderr || '')); });
    await mkdir(dirname(outputPath), { recursive: true });
    await copyFile(target, outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
module.exports = { buildWindowsAppDisplay };
if (require.main === module) {
  buildWindowsAppDisplay({ outputPath: resolve(process.argv[2] || 'apps/backend/bin/task-app-windows.exe') })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
