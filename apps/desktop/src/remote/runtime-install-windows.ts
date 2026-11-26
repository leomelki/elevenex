import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { backendRelease, type BackendRelease } from '../backend/release';
import { remoteClientSources } from './runtime-sources';

const compress = promisify(gzip);

/** Windows OpenSSH can invoke either cmd or PowerShell. The fixed UTF-16 loader fits
 * both command lines. It consumes exactly the gzip payload, leaving the SSH stream
 * at the archive header (or the bridge's first wire packet on a cached install). */
function command(size: number): string {
  const loader = `
$ErrorActionPreference='Stop'
try {
  if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'EX11_COMPATIBILITY: Windows PowerShell 5.1 is required.' }
  $channel=[Console]::OpenStandardInput()
  $payload=[byte[]]::new(${size})
  $position=0
  while ($position -lt $payload.Length) {
    $n=$channel.Read($payload,$position,($payload.Length-$position))
    if ($n -eq 0) { throw 'EX11_CONFIGURATION: Incomplete installer payload.' }
    $position+=$n
  }
  $memory=[IO.MemoryStream]::new($payload,$false)
  $gz=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress)
  $reader=[IO.StreamReader]::new($gz,[Text.UTF8Encoding]::new($false,$true))
  try { $source=$reader.ReadToEnd() } finally { $reader.Dispose(); $memory.Dispose() }
  & ([ScriptBlock]::Create($source))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ' + Buffer.from(loader, 'utf16le').toString('base64');
}

export async function bootstrapWindowsScript(
  release: BackendRelease, nonce: string, developmentNamespace?: string, allowUpdate = false,
): Promise<{ command: string; payload: Buffer }> {
  // These identifiers are the only metadata embedded in executable source.
  backendRelease(release, 'win32', 'x64');
  if (!/^[a-f0-9]{32}$/.test(nonce) || (developmentNamespace !== undefined && !/^[a-f0-9]{32}$/.test(developmentNamespace))) {
    throw new Error('Invalid Windows runtime bootstrap identity');
  }
  const { sources, modules, clientId } = await remoteClientSources();
  const sourceFiles = sources.map((source, i) => `Write-Module '${modules[i]}.js' '${Buffer.from(source).toString('base64')}'`).join('\n');
  const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$trusted=@($sid.Value,$system.Value,$admins.Value)
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
foreach ($id in @($sid,$system,$admins)) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
function Report([string]$value) {
  [Console]::Write($value+[char]10)
  [Console]::Out.Flush()
}
function Plain([string]$path) {
  if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'EX11_CONFIGURATION: Runtime path contains a reparse point.' }
}
function Private-Item([IO.FileSystemInfo]$item) {
  Plain $item.FullName
  $rules=$item.GetAccessControl()
  if ($trusted -notcontains $rules.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'EX11_CONFIGURATION: Unexpected runtime directory owner.' }
  foreach ($rule in $rules.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) { throw 'EX11_CONFIGURATION: Runtime directory permissions must be private.' }
  }
}
function Private-Directory([string]$path) {
  $dir=[IO.DirectoryInfo]::new($path)
  $dir.Create($acl)
  Private-Item $dir
}
function Publish([string]$from,[string]$to) {
  try { [IO.Directory]::Move($from,$to) }
  catch [IO.IOException] { if (![IO.Directory]::Exists($to)) { throw } }
  Plain $to
}
function Marker([string]$path) {
  $file=[IO.FileInfo]::new($path)
  Private-Item $file
  if ($file.Length -ne 64) { throw 'EX11_CONFIGURATION: Invalid installation marker.' }
  $hash=[IO.File]::ReadAllText($path)
  if ($hash -cnotmatch '^[0-9a-f]{64}$') { throw 'EX11_CONFIGURATION: Invalid installation marker.' }
  return $hash
}
function Assert-Runtime([string]$path) {
  foreach ($part in @('backend','backend\node')) { Private-Item ([IO.DirectoryInfo]::new((Join-Path $path $part))) }
  foreach ($part in @('backend\node\node.exe','backend\main.cjs')) {
    $file=[IO.FileInfo]::new((Join-Path $path $part))
    Private-Item $file
    if ($file.Length -eq 0) { throw 'EX11_CONFIGURATION: Incomplete runtime installation.' }
  }
}
function Archive-Input {
  # Windows PowerShell's console stream stops returning SSH pipe input partway
  # through a large transfer, which stalls the archive indefinitely. Read the
  # same inherited handle through an unbuffered FileStream. The handle is not
  # owned here: the bridge process inherits it once installation completes.
  $field=$channel.GetType().GetField('_handle',[Reflection.BindingFlags]'NonPublic,Instance')
  if (!$field) { throw 'EX11_COMPATIBILITY: Windows PowerShell 5.1 on .NET Framework 4 is required.' }
  $handle=[Microsoft.Win32.SafeHandles.SafeFileHandle]::new($field.GetValue($channel).DangerousGetHandle(),$false)
  return [IO.FileStream]::new($handle,[IO.FileAccess]::Read,1)
}
function Read-Archive([string]$path) {
  # Read from the original binary stream without buffering. Text readers buffer
  # past the LF and would discard the first compressed bytes or the first live
  # wire packet.
  $channel=Archive-Input
  $header=[Text.StringBuilder]::new()
  while ($header.Length -lt 80) {
    $b=$channel.ReadByte()
    if ($b -eq 10) { break }
    if ($b -lt 32 -or $b -gt 126) { throw 'EX11_CONFIGURATION: Invalid archive header.' }
    [void]$header.Append([char]$b)
  }
  if ($b -ne 10 -or $header.ToString() -cnotmatch '^([1-9][0-9]{0,9}) ([0-9a-f]{64})$') { throw 'EX11_CONFIGURATION: Invalid archive header.' }
  $remaining=[int64]$Matches[1]
  $hash=$Matches[2]
  if ($remaining -gt 1073741824) { throw 'EX11_CONFIGURATION: Archive is too large.' }
  $file=[IO.File]::Open($path,'CreateNew','Write','None')
  $buffer=[byte[]]::new(65536)
  $sha=[Security.Cryptography.SHA256]::Create()
  try {
    while ($remaining -gt 0) {
      $n=$channel.Read($buffer,0,[int][Math]::Min([int64]$buffer.Length,$remaining))
      if (!$n) { throw 'EX11_CONFIGURATION: Incomplete archive transfer.' }
      [void]$sha.TransformBlock($buffer,0,$n,$buffer,0)
      $file.Write($buffer,0,$n)
      $remaining-=$n
    }
    [void]$sha.TransformFinalBlock([byte[]]::new(0),0,0)
    $actual=[BitConverter]::ToString($sha.Hash).Replace('-','')
  } finally { $file.Dispose(); $sha.Dispose() }
  if ($actual -ne $hash) { throw 'EX11_CONFIGURATION: Transferred runtime checksum mismatch.' }
  return $hash
}

Remove-Item Env:NODE_OPTIONS,Env:NODE_PATH,Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$system32=[Environment]::GetFolderPath('System')
$tar=Join-Path $system32 'tar.exe'
if (!(Test-Path -LiteralPath $tar -PathType Leaf) -or !(Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue)) {
  throw 'EX11_COMPATIBILITY: Windows tar.exe and Git are required.'
}
$arch=$env:PROCESSOR_ARCHITEW6432
if (!$arch) { $arch=$env:PROCESSOR_ARCHITECTURE }
switch ($arch) { 'AMD64' { $target='x64' }; 'ARM64' { $target='arm64' }; default { throw 'EX11_COMPATIBILITY: Use an x64 or arm64 Windows host.' } }
$local=[Environment]::GetFolderPath('LocalApplicationData')
if (![IO.Path]::IsPathRooted($local)) { throw 'EX11_CONFIGURATION: Missing user profile.' }
Plain $local
$base=Join-Path $local 'Elevenex'
Private-Directory $base
$root=Join-Path $base 'desktop-remote'
Private-Directory $root
${developmentNamespace ? `$root=Join-Path $root 'dev'; Private-Directory $root\n$root=Join-Path $root '${developmentNamespace}'; Private-Directory $root` : ''}
$runtimes=Join-Path $root 'runtimes'
$clients=Join-Path $root 'clients'
Private-Directory $runtimes
Private-Directory $clients
$cache=Join-Path $runtimes ('${release.tag}-windows-'+$target)
Report ('EX11:${nonce}:platform:win32:'+$target)
if ([IO.Directory]::Exists($cache)) {
  Private-Item ([IO.DirectoryInfo]::new($cache))
  Assert-Runtime $cache
  [void](Marker (Join-Path $cache 'installation.sha256'))
  Report ('EX11:${nonce}:cache:yes')
} else {
  $stage=Join-Path $runtimes ('.install-'+[Guid]::NewGuid().ToString('N'))
  Private-Directory $stage
  try {
    Report ('EX11:${nonce}:cache:no')
    $archive=Join-Path $stage 'archive.tar.gz'
    $digest=Read-Archive $archive
    Report ('EX11:${nonce}:installation:start')
    & $tar -xzf $archive -C $stage
    if ($LASTEXITCODE -ne 0) { throw 'EX11_CONFIGURATION: Runtime extraction failed.' }
    [IO.File]::Delete($archive)
    Assert-Runtime $stage
    [IO.File]::WriteAllText((Join-Path $stage 'installation.sha256'),$digest,[Text.Encoding]::ASCII)
    Publish $stage $cache
    if ((Marker (Join-Path $cache 'installation.sha256')) -ne $digest) { throw 'EX11_CONFIGURATION: Conflicting cached runtime.' }
    Assert-Runtime $cache
  } finally { if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage,$true) } }
}
$client=Join-Path $clients '${clientId}'
if (![IO.Directory]::Exists($client)) {
  $stage=Join-Path $clients ('.client-'+[Guid]::NewGuid().ToString('N'))
  Private-Directory $stage
  try {
    function Write-Module([string]$relative,[string]$content) {
      $path=Join-Path $stage $relative
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
      [IO.File]::WriteAllBytes($path,[Convert]::FromBase64String($content))
    }
${sourceFiles}
    Publish $stage $client
  } finally { if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage,$true) } }
}
Private-Item ([IO.DirectoryInfo]::new($client))
$runtime=Join-Path $client 'runtime.js'
Private-Item ([IO.FileInfo]::new($runtime))
$node=Join-Path $cache 'backend\node\node.exe'
& $node -e 'if(Number(process.versions.node.split(String.fromCharCode(46))[0])<22)process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'EX11_COMPATIBILITY: Bundled Node cannot run on this Windows host.' }
$name='Elevenex Desktop '+$sid.Value+' ${developmentNamespace ?? 'production'}'
$description='Elevenex on-demand desktop engine '+$sid.Value+' ${developmentNamespace ?? 'production'}'
# Windows filenames cannot contain a double quote; each argument is a file
# or a directory without a trailing separator, including profiles with spaces.
$arguments='"'+$runtime+'" daemon "'+$root+'" "'+$cache+'" ${release.version}'
$existing=Get-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction SilentlyContinue
if ($existing) {
  try {
    $user=$existing.Principal.UserId
    $owner=if ($user -match '^S-1-') { $user } else { ([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]).Value }
  } catch { throw 'EX11_CONFIGURATION: Cannot confirm ownership of the scheduler entry.' }
  if ($owner -ne $sid.Value) { throw 'EX11_CONFIGURATION: A different user owns the scheduler entry.' }
}
if ($existing -and ($existing.Description -cne $description -or $existing.Principal.RunLevel -ne 'Limited' -or $existing.Principal.LogonType -ne 'Interactive' -or $existing.Triggers.Count -ne 0)) {
  throw 'EX11_CONFIGURATION: The scheduler entry is already used by another task.'
}
if (!$existing -or ($existing.State -ne 'Running' -and ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $node -or $existing.Actions[0].Arguments -ne $arguments))) {
  $action=New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $root
  $principal=New-ScheduledTaskPrincipal -UserId $sid.Value -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  # Only overwrite the previously verified user-owned task. An unexpected
  # concurrent first registration fails safely and can be joined on reconnect.
  $replace=@{}
  if ($existing) { $replace['Force']=$true }
  [void](Register-ScheduledTask -TaskPath '\' -TaskName $name -Description $description -Action $action -Principal $principal -Settings $settings @replace)
}
$env:ELEVENEX_WINDOWS_RUNTIME_TASK=$name
Report ('EX11:${nonce}:runtime:start')
# Inherit the SSH handles directly. A PowerShell object pipeline would convert
# stdout and stdin to text and break the live bridge framing.
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=$node
$start.Arguments='"'+$runtime+'" bridge "'+$root+'" "'+$cache+'" ${release.version} ${allowUpdate ? 'update' : 'join'}'
$start.WorkingDirectory=$root
$start.UseShellExecute=$false
$process=[Diagnostics.Process]::Start($start)
try { $process.WaitForExit(); exit $process.ExitCode } finally { $process.Dispose() }
`;
  const payload = await compress(script);
  return { command: command(payload.length), payload };
}
