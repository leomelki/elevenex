'use strict';
const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { createRequire } = require('node:module');
const { setTimeout: wait } = require('node:timers/promises');

async function verifyJob(helper) {
  const cancelled = spawn(helper, ['--verify-job', randomUUID()], { windowsHide:true, stdio:'pipe' });
  let cancelledOutput = '';
  for (const out of [cancelled.stdout, cancelled.stderr]) out.on('data', bytes => { cancelledOutput += bytes; });
  const cancelledExit = once(cancelled, 'close');
  cancelled.stdin.end();
  const [cancelledCode] = await cancelledExit;
  assert.equal(cancelledCode, 0);
  assert.equal(cancelledOutput, '', 'EOF before GO must leave the job unstarted');
  const child = spawn(helper, ['--verify-job', randomUUID()], { windowsHide:true, stdio:'pipe' });
  child.stdin.write('GO\n');
  let out='', logs='';
  child.stdout.on('data', data=>{out+=data;});
  child.stderr.on('data', data=>{logs+=data;});
  const deadline=setTimeout(()=>child.kill(),10_000);
  try {
    const [code]=await once(child,'close');
    assert.equal(code,0,'Windows Job Object launch failed: '+logs);
    assert.match(out,/ready/);
    assert.match(logs,/contained/);
  } finally { clearTimeout(deadline); child.stdin.end(); }
}

async function verifyJobDrain(helper) {
  const id = randomUUID();
  const probe = () => execFileSync(helper, ['--job-drained', id], {
    encoding: 'utf8', windowsHide: true, timeout: 2500,
  }).trim();
  assert.equal(probe(), 'drained');

  const supervisor = spawn(helper, ['--verify-job-hold', id], { windowsHide: true, stdio: 'pipe' });
  const exited = once(supervisor, 'exit');
  const closed = once(supervisor, 'close');
  supervisor.stdin.on('error', () => {});
  let output = '';
  supervisor.stderr.on('data', chunk => { output += chunk; });
  const deadline = setTimeout(() => supervisor.kill(), 10_000);
  try {
    supervisor.stdin.write('GO\n');
    while (!output.includes('contained') && supervisor.exitCode === null && supervisor.signalCode === null) {
      await wait(40);
    }
    assert.match(output, /contained/, 'The diagnostic job must own a live process.');
    assert.equal(probe(), 'active');
    supervisor.kill();
    await exited;
    const drainDeadline = Date.now() + 5000;
    while (probe() === 'active' && Date.now() < drainDeadline) await wait(40);
    assert.equal(probe(), 'drained');
    await closed;
  } finally {
    clearTimeout(deadline);
    supervisor.kill();
    supervisor.stdin.end();
    await closed;
  }
}

async function interactive(directory) {
  const {TaskAppHost}=require('../apps/backend/dist/task-apps/task-app-host.js');
  const requireBackend=createRequire(resolve(__dirname,'../apps/backend/package.json'));
  const encoder=requireBackend('ffmpeg-static');
  const app=new TaskAppHost();
  const fixture = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = "Elevenex Windows capture fixture"
$form.ClientSize = New-Object System.Drawing.Size(640,400)
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = "Fill"
$box.BackColor = [System.Drawing.Color]::FromArgb(15,45,200)
$form.Controls.Add($box)
$resize = New-Object System.Windows.Forms.Timer
$resize.Interval = 150
$resize.Add_Tick({
  $resize.Stop()
  $form.Width += 120
  [Console]::WriteLine("resized")
})
$box.Add_TextChanged({
  [Console]::WriteLine("Text="+$box.Text)
  if ($box.Text -eq 'stream-ok!') { $resize.Start() }
})
$form.Add_Shown({ $box.Focus(); [Console]::WriteLine("mapped") })
[System.Windows.Forms.Application]::Run($form)
`;
  const state=await app.start({taskId:1,requestId:randomUUID(),name:'WinForms fixture',cwd:directory,mode:'stream',
    executable:join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    args:['-NoProfile','-NonInteractive','-STA','-Command',fixture]});
  const until=async check=>{
    const deadline=Date.now()+30_000;
    while(Date.now()<deadline) {
      if(check())return;
      const current=app.get(1,state.runId);
      if(['exited','failed'].includes(current.status)) break;
      await wait(40);
    }
    throw new Error('Windows fixture did not reach expected state: '+ JSON.stringify(app.get(1,state.runId))+' '+app.output(1,state.runId));
  };
  try {
    await until(()=>app.output(1,state.runId).includes('mapped'));
    let frame, failure, disposition;
    const stop=app.watch(1,state.runId,{frame:f=>{
      if(frame||!f.key)return;
      const sample=spawnSync(encoder,['-v','error','-f','h264','-i','pipe:0','-frames:v','1','-vf','scale=1:1',
        '-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input:f.data,maxBuffer:4096,timeout:4000,windowsHide:true});
      if(sample.status===0 && sample.stdout.length===3 && sample.stdout[2] > sample.stdout[0] + 35) frame=f;
    },end:(reason, ended)=>{failure=reason;disposition=ended;}});
    try {
      await until(() => {
        if (failure) throw new Error(`Capture ended before the first decoded WinForms frame (${disposition ?? 'unknown'}): ${failure}`);
        return !!frame;
      });
      app.acquireInput(1,state.runId,'fixture');
      const point={x:Math.floor(frame.width/2),y:Math.floor(frame.height/2),button:0};
      await app.input(1,state.runId,'fixture',{kind:'down',...point});
      await app.input(1,state.runId,'fixture',{kind:'up',...point});
      await app.input(1,state.runId,'fixture',{kind:'text',text:'stream-ok'});
      await app.releaseInput(1,state.runId,'fixture');
      await until(()=>app.output(1,state.runId).includes('Text=stream-ok'));
      app.acquireInput(1,state.runId,'fixture');
      await app.input(1,state.runId,'fixture',{kind:'text',text:'!'});
      await until(()=>!!failure);
      assert.equal(disposition, 'window-changed', 'Resizing retires the old geometry and input lease.');
      await until(() => app.output(1, state.runId).includes('resized'));
    } finally {stop();}
    let replacement, replacementFailure;
    const detach=app.watch(1,state.runId,{
      frame: value => { if(value.key) replacement=value; },
      end: (reason, ended) => { replacementFailure = `Capture ended after reattachment (${ended ?? 'unknown'}): ${reason}`; },
    });
    try {
      await until(() => {
        if (replacementFailure) throw new Error(replacementFailure);
        return !!replacement;
      });
      assert.ok(replacement.width > frame.width, 'Reattachment starts at the resized surface.');
    } finally { detach(); }
  } finally {await app.onModuleDestroy();}
}

async function main() {
  if(process.platform!=='win32')throw new Error('Run the native Windows smoke test on Windows.');
  const directory=await mkdtemp(join(tmpdir(),'elevenex-windows-smoke-'));
  try {
    const archive=resolve(process.argv[2]||'dist-runtime/elevenex-backend-windows-x64.tar.gz');
    // Git for Windows can put GNU tar first on PATH, where D: looks like a remote host.
    execFileSync('tar.exe', ['-xzf', basename(archive), '-C', directory, 'backend/bin/task-app-windows.exe'], {
      cwd: dirname(archive), timeout: 180000, windowsHide: true,
    });
    process.env.ELEVENEX_BACKEND_RUNTIME_ROOT=join(directory,'backend');
    const helper=join(directory,'backend','bin','task-app-windows.exe');
    await verifyJob(helper);
    await verifyJobDrain(helper);
    console.log('Packaged Windows helper verified Job Object membership and cleanup after supervisor exit.');
    const state=spawnSync(helper,['--check'],{encoding:'utf8',windowsHide:true,timeout:5000});
    if(state.status===20 && state.stderr.includes('No interactive Windows desktop')) {
      console.log('::notice::Skipped window capture and input verification because the Windows runner has no unlocked interactive desktop.');
      return;
    }
    assert.equal(state.status,0,'Windows graphics capture preflight failed: '+(state.error||state.stderr));
    await interactive(directory);
    console.log('Verified a decoded WinForms window and text delivery through the packaged Windows helper.');
  } finally {await rm(directory,{recursive:true,force:true,maxRetries:3});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
