# Profiles have already run. Respect execution policy and constrained language;
# never change PSReadLine options, history filters or key bindings.
if ($env:ELEVENEX_TERMINAL_SHELL_INTEGRATION -eq '0' -or
    $ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    [Console]::Write("$([char]27)]133;X;__ELEVENEX_TOKEN__$([char]7)")
    return
}
if (Test-Path variable:global:__ElevenexTerminal) { return }
$global:__ElevenexTerminal = @{
    Prompt = $function:prompt
    ReadLine = $function:PSConsoleHostReadLine
    Executing = $false
    LastHistoryId = 0
}
function global:__ElevenexEscape([string]$value, [int]$limit) {
    if ($value.Length -gt $limit) { return '' }
    return $value.Replace('\', '\\').Replace(';', '\x3b').Replace("`n", '\x0a').Replace("`t", '\x09')
}
if ($null -ne $global:__ElevenexTerminal.ReadLine) {
    function global:PSConsoleHostReadLine {
        $line = $global:__ElevenexTerminal.ReadLine.Invoke()
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $global:__ElevenexTerminal.Executing = $true
            [Console]::Write("$([char]27)]133;E;__ELEVENEX_TOKEN__;$(__ElevenexEscape $line 4096)$([char]7)$([char]27)]133;C;__ELEVENEX_TOKEN__$([char]7)")
        }
        return $line
    }
}
function global:prompt {
    $succeeded = $global:?
    Set-StrictMode -Off
    $entry = Get-History -Count 1
    if ($global:__ElevenexTerminal.Executing -or
        ($null -eq $global:__ElevenexTerminal.ReadLine -and $entry.Id -gt $global:__ElevenexTerminal.LastHistoryId)) {
        # PowerShell's $? reports pipeline success, not a portable numeric native
        # exit code. Report 0/1 honestly rather than reusing a stale LASTEXITCODE.
        if ($null -eq $global:__ElevenexTerminal.ReadLine) {
            [Console]::Write("$([char]27)]133;H;__ELEVENEX_TOKEN__;$(__ElevenexEscape $entry.CommandLine 4096)$([char]7)")
        }
        [Console]::Write("$([char]27)]133;D;__ELEVENEX_TOKEN__;$([int](-not $succeeded))$([char]7)")
        $global:__ElevenexTerminal.Executing = $false
    }
    $global:__ElevenexTerminal.LastHistoryId = $entry.Id
    # Preserve the failure flag seen by the user's prompt, as VS Code does.
    if (-not $succeeded) { Write-Error 'failure' -ErrorAction Ignore }
    $text = $global:__ElevenexTerminal.Prompt.Invoke()
    $directory = if ($pwd.Provider.Name -eq 'FileSystem') { $pwd.ProviderPath } else { '' }
    return "$([char]27)]133;P;__ELEVENEX_TOKEN__;$(__ElevenexEscape $directory 8192)$([char]7)$text$([char]27)]133;B;__ELEVENEX_TOKEN__$([char]7)"
}
