#Requires -Version 7.2
<#
.SYNOPSIS
    CLUE restricted host: a persistent PowerShell process that answers a fixed, typed command
    registry over newline-delimited JSON.

.DESCRIPTION
    This is the PowerShell half of the boundary whose typed half is `src/experiment/host/
    hostClient.ts`. The analysis and experiment planes never run a process, touch Git, hash a file,
    or drive the test browser directly; they send one of a closed set of named commands to this
    host, and this host is the only thing that acts. The closed set *is* the security surface: there
    is deliberately no "run this string" verb.

    Four properties make it a boundary rather than a convenience, each because the alternative fails
    quietly (Architecture v8 — PowerShell Controller; Execution Model v8 Stage G1 — "typecheck and
    build run without arbitrary shell"; Interface v10 — host request/response envelopes):

      A closed registry. Every request names a member of HOST_COMMANDS and carries only that
      command's declared arguments. An unknown command, an unknown argument key, or a wrong-typed
      argument is refused before anything runs — a request that does not fit the contract is not a
      request this host guesses at.

      Paths are re-resolved here, not trusted. The client classifies a target zone from the path
      text; this host resolves the *real* path (collapsing `.`/`..` and following the junction or
      symlink the client could not see) and classifies the zone from what is actually on disk. If
      the resolved zone is not the one the operation requires, the command is refused. Every
      path-bearing reply carries the resolved path and zone back, so the client can check parity a
      second time — a target that resolves somewhere it was not authorised is the shape of an escape.

      Only approved processes run. Git runs one of a small set of verbs, each with a fixed argument
      vector; the shadow tree runs one of its own named npm scripts; the browser launches only the
      configured executable with fixed measurement flags. No argument is ever a command.

      Output is redacted and referenced, not inlined. Secret environment values are stripped from
      any text this host returns, and process output is captured to files referenced by hash and
      path rather than pasted into a reply. A build log is evidence; a build log inside a JSON
      response is a leak waiting to happen.

    The wire is one JSON object per line, both directions. A request is
        { "v": 1, "id": <string>, "command": <string>, "args": { ... } }
    and a reply is
        { "v": 1, "id": <same>, "ok": <bool>, "result": <object|null>,
          "code": <string|null>, "message": <string|null>,
          "resolvedPath": <string|null>, "zone": <string|null> }
    `resolvedPath` and `zone` are populated for path-bearing commands and null otherwise. The host
    never emits an unsolicited banner; the client opens the session by sending `host.hello`.

.PARAMETER CanonicalRoot
    Absolute path to the Murugan (target program) working tree. Match clue.config.yaml -> project.root.

.PARAMETER ShadowRoot
    Absolute path to the shadow clone CLUE experiments in. Match shadow.root.

.PARAMETER WorkspaceRoot
    Absolute path to CLUE's workspace (events, blobs, db, logs). Match workspace.root. Process
    output is captured under "<WorkspaceRoot>\logs\host".

.PARAMETER BrowserProfileDir
    Absolute path to the dedicated browser profile directory. Match browser.profile_dir.

.PARAMETER BrowserExecutable
    Absolute path to the ONE browser binary this host may launch (DEV-P0-12). browser.launch is
    refused entirely when this is not set, and refused when a request names any other executable.
    Match browser.executable.

.PARAMETER AllowedBrowserOrigins
    The origins (scheme://host:port) the measurement browser may be pointed at (DEV-P0-12).
    browser.launch is refused entirely when empty, and refused for any url outside this set.

.PARAMETER LandingRefPrefix
    The landing branch prefix (DEV-P0-12), e.g. "clue/accepted/". A canonical mergeFfOnly whose ref
    is outside this prefix is refused by the host itself; with no prefix set, canonical landing is
    refused entirely. Match patching.landing_branch_prefix.

.PARAMETER HostName
    A label returned in the hello banner. Defaults to the machine name.

.EXAMPLE
    pwsh -NoLogo -NonInteractive -File .\clue-host.ps1 `
        -CanonicalRoot "F:\murugan" -ShadowRoot "F:\CLU\shadow" `
        -WorkspaceRoot "F:\CLU\workspace" -BrowserProfileDir "F:\CLU\chrome-profile" `
        -BrowserExecutable "C:\Program Files\Google\Chrome\Application\chrome.exe" `
        -AllowedBrowserOrigins @('http://127.0.0.1:47900') -LandingRefPrefix "clue/accepted/"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $CanonicalRoot,
    [Parameter(Mandatory)] [string] $ShadowRoot,
    [Parameter(Mandatory)] [string] $WorkspaceRoot,
    [Parameter(Mandatory)] [string] $BrowserProfileDir,
    # DEV-P0-12: the browser executable is pinned at startup, never taken from a request. When empty,
    # browser.launch is refused entirely — deny-by-default for the one command that starts a process
    # from a caller-influenced identity.
    [string] $BrowserExecutable = '',
    # DEV-P0-12: the origins the measurement browser may be pointed at, fixed at startup. A launch url
    # whose origin is not in this set is refused; when empty, browser.launch is refused entirely.
    [string[]] $AllowedBrowserOrigins = @(),
    # DEV-P0-12: the landing branch prefix, enforced independently in the host. A canonical
    # mergeFfOnly whose ref is outside this prefix is refused even if a compromised client asked for
    # it; when empty, canonical landing is refused entirely.
    [string] $LandingRefPrefix = '',
    # Canonical ProjectOperationIdentity JSON pinned to every request in this host session.
    [string] $ProjectIdentityJson = '',
    [string] $HostName = [System.Environment]::MachineName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Optional project-session pin. A profile-bound host accepts only requests carrying this exact
# three-field identity; an unbound legacy host rejects requests that attempt to introduce one.
$script:ProjectIdentityPin = $null
if (-not [string]::IsNullOrWhiteSpace($ProjectIdentityJson)) {
    try {
        $candidateIdentity = $ProjectIdentityJson | ConvertFrom-Json -AsHashtable -Depth 5
    }
    catch {
        throw '-ProjectIdentityJson is not valid JSON'
    }
    if ($candidateIdentity -isnot [System.Collections.IDictionary]) {
        throw '-ProjectIdentityJson must be an object'
    }
    $identityKeys = @('projectId', 'targetRootIdentity', 'projectProfileHash')
    foreach ($key in $candidateIdentity.Keys) {
        if ($identityKeys -notcontains $key) { throw "unknown Project Identity key `"$key`"" }
    }
    foreach ($key in $identityKeys) {
        if (-not $candidateIdentity.Contains($key) -or $candidateIdentity[$key] -isnot [string] -or [string]::IsNullOrWhiteSpace([string] $candidateIdentity[$key])) {
            throw "Project Identity is missing non-empty string `"$key`""
        }
    }
    $script:ProjectIdentityPin = [ordered]@{
        projectId = [string] $candidateIdentity['projectId']
        targetRootIdentity = [string] $candidateIdentity['targetRootIdentity']
        projectProfileHash = [string] $candidateIdentity['projectProfileHash']
    }
}

# Startup pins (DEV-P0-12). Normalised once; handlers compare against these, never against request data.
$script:BrowserExecutablePin = $BrowserExecutable
$script:LandingRefPrefix = $LandingRefPrefix
# NOTE: stored under a distinct name — at script top level the parameter variable IS the script-scope
# variable, so reusing the parameter's own name here would clear it before it was read.
$script:BrowserOriginAllowlist = @()
foreach ($originText in $AllowedBrowserOrigins) {
    $parsed = $null
    if (-not [System.Uri]::TryCreate($originText, [System.UriKind]::Absolute, [ref] $parsed)) {
        throw "invalid -AllowedBrowserOrigins entry `"$originText`" — each entry must be an absolute origin like http://127.0.0.1:47900"
    }
    $script:BrowserOriginAllowlist += "$($parsed.Scheme)://$($parsed.Authority)".ToLowerInvariant()
}

# ---------------------------------------------------------------------------------------------------
# Protocol constants. These must stay in lock-step with hostClient.ts; the client rejects any drift.
# ---------------------------------------------------------------------------------------------------

$script:ProtocolVersion = 1

# The closed command registry (HOST_COMMANDS) and the argument keys each command accepts. A request
# whose command is absent here, or whose args carry a key not listed, is refused.
$script:CommandArgKeys = @{
    'host.hello'     = @('roots')
    'env.host'       = @()
    'shadow.refresh' = @('canonicalRoot', 'shadowRoot', 'commit')
    'shadow.run'     = @('shadowRoot', 'script', 'timeoutMs')
    'git'            = @('zone', 'root', 'verb', 'params')
    'fs.hash'        = @('zone', 'path')
    'fs.stat'        = @('zone', 'path')
    'browser.launch' = @('executable', 'profileDir', 'port', 'url', 'timeoutMs')
    'browser.status' = @('port')
    'browser.stop'   = @('profileDir')
}

# The npm scripts the shadow tree exposes (SHADOW_SCRIPTS), mapped to their fixed npm argument
# vector. serve.start/serve.stop are the dev-server lifecycle and are handled specially.
$script:ShadowArgv = @{
    'npm.ci'      = @('ci')
    'typecheck'   = @('run', 'typecheck')
    'build'       = @('run', 'build')
    'serve.start' = @('run', 'serve')
    'serve.stop'  = $null
}

# The Git verbs (GIT_VERBS). Read verbs may run on any zone; landing verbs mutate the canonical tree
# and may run only there; every other verb is a shadow-tree operation and is refused on canonical.
$script:GitReadVerbs = @('status', 'revParseHead', 'revParseBranch', 'hashObject')
$script:GitLandingVerbs = @('mergeFfOnly', 'revert')
$script:GitAllVerbs = @(
    'status', 'revParseHead', 'revParseBranch', 'hashObject', 'clone', 'fetch',
    'checkout', 'applyCheck', 'apply', 'addAll', 'commit', 'mergeFfOnly', 'revert'
)

# The exact key set each nested git `params` shape may carry, keyed by its `of` discriminator. A params
# object whose `of` is unknown, or which carries any key outside its shape's set, is refused — nested
# params are validated as strictly as top-level command args (DEV-P0-12). Mirrors the client's
# GitParams union in hostClient.ts.
$script:GitParamKeys = @{
    'none'   = @('of')
    'path'   = @('of', 'path')
    'ref'    = @('of', 'ref')
    'clone'  = @('of', 'source', 'dest')
    'commit' = @('of', 'message')
    'sha'    = @('of', 'sha')
}

# Environment values that must never appear in a returned line (mirrors SECRET_ENV_NAMES).
$script:SecretEnvNames = @('OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN')

# ---------------------------------------------------------------------------------------------------
# A typed error carrying a stable code, so a handler can fail with a reason the reply preserves.
# ---------------------------------------------------------------------------------------------------

class HostCommandError : System.Exception {
    [string] $Code
    HostCommandError([string] $code, [string] $message) : base($message) { $this.Code = $code }
}

# Raises a terminating HostCommandError carrying a stable code. Named with the approved `Write` verb
# (PSUseApprovedVerbs) rather than an unapproved `Throw`; it throws rather than returning.
function Write-HostError {
    param([Parameter(Mandatory)] [string] $Code, [Parameter(Mandatory)] [string] $Message)
    throw [HostCommandError]::new($Code, $Message)
}

function Assert-ProjectIdentityParity {
    param([Parameter(Mandatory)] [System.Collections.IDictionary] $Request)

    $hasIdentity = $Request.Contains('projectIdentity')
    if ($null -eq $script:ProjectIdentityPin) {
        if ($hasIdentity) {
            Write-HostError 'PROJECT_IDENTITY_MISMATCH' 'request supplied a Project Identity to an unbound host session'
        }
        return
    }
    if (-not $hasIdentity) {
        Write-HostError 'PROJECT_IDENTITY_MISMATCH' 'profile-bound host request omitted Project Identity'
    }
    $actual = $Request['projectIdentity']
    if ($actual -isnot [System.Collections.IDictionary]) {
        Write-HostError 'PROJECT_IDENTITY_MISMATCH' 'request Project Identity was not an object'
    }
    $keys = @('projectId', 'targetRootIdentity', 'projectProfileHash')
    foreach ($key in $actual.Keys) {
        if ($keys -notcontains $key) {
            Write-HostError 'PROJECT_IDENTITY_MISMATCH' "unknown Project Identity key `"$key`""
        }
    }
    foreach ($key in $keys) {
        if (-not $actual.Contains($key) -or [string] $actual[$key] -ne [string] $script:ProjectIdentityPin[$key]) {
            Write-HostError 'PROJECT_IDENTITY_MISMATCH' "Project Identity mismatch in `"$key`""
        }
    }
}

# ---------------------------------------------------------------------------------------------------
# Zone roots. Resolved once so every classification compares against the same real, absolute paths.
# ---------------------------------------------------------------------------------------------------

function Resolve-RealPath {
    <#
      A component-wise realpath (DEV-P0-12): collapses `.`/`..`, then walks the path from its
      filesystem root, following the junction, reparse point, or symlink at EVERY existing component —
      not only the leaf. A link that sits in the middle of a path (`shadow\esc\file` where `esc`
      points elsewhere) previously survived leaf-only resolution and mis-zoned the real target; here
      each component is resolved as it is met, so the returned path is the one actually on disk.
      Components that do not exist yet (a stat of a missing file) extend the resolved prefix
      lexically, which is correct — there is no link to follow.
    #>
    param([Parameter(Mandatory)] [string] $Path)

    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    $parts = $full.Substring($root.Length) -split '[\\/]' | Where-Object { $_ -ne '' }
    # Start from the filesystem root INCLUDING its trailing separator, so Join-Path stays rooted. On
    # Windows "F:\" + "clu" = "F:\clu"; trimming to "F:" would make it drive-RELATIVE ("F:clu"), which
    # GetFullPath resolves against the current directory and corrupts the walk. On POSIX the root is "/".
    $current = if ([string]::IsNullOrEmpty($root)) { [string] [System.IO.Path]::DirectorySeparatorChar } else { $root }
    foreach ($part in $parts) {
        # Combine (pure path math, no PowerShell drive provider) rather than Join-Path, which validates
        # the drive exists and would throw. "F:\" + "clu" -> "F:\clu"; "/" + "tmp" -> "/tmp".
        $candidate = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($current, $part))
        try {
            $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
            $target = $item.ResolveLinkTarget($true)
            if ($null -eq $target -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                Write-HostError 'PATH_UNREADABLE' 'path contains a reparse point that could not be resolved'
            }
            $current = if ($null -ne $target) { [System.IO.Path]::GetFullPath($target.FullName) } else { $candidate }
        }
        catch [System.Management.Automation.ItemNotFoundException] {
            # A missing component can be extended lexically. A permission or link resolution
            # failure must reach the caller instead of letting the path pass its zone check.
            $current = $candidate
        }
    }
    # Trim a trailing separator for stable comparison, but never below a root (do not turn "F:\" into "F:").
    $trimmed = $current.TrimEnd([char]0x5C, [char]0x2F)
    if ($trimmed.Length -eq 0 -or $trimmed -match '^[A-Za-z]:$') { return $current }
    return $trimmed
}

$script:ZoneRoots = [ordered]@{
    canonical      = Resolve-RealPath $CanonicalRoot
    shadow         = Resolve-RealPath $ShadowRoot
    workspace      = Resolve-RealPath $WorkspaceRoot
    browserProfile = Resolve-RealPath $BrowserProfileDir
}

$script:OutputDir = Join-Path (Join-Path $script:ZoneRoots['workspace'] 'logs') 'host'

function Test-PathWithin {
    <# True when $child is $parent or lies beneath it, comparing already-resolved paths. #>
    param([string] $Parent, [string] $Child)
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $comparison = if ($IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
    if ([string]::Equals($Parent, $Child, $comparison)) { return $true }
    return $Child.StartsWith($Parent.TrimEnd($sep) + $sep, $comparison)
}

function Get-Zone {
    <#
      Classifies a resolved path into one of the operating zones by longest containing root, or
      `external` when no configured root contains it. Longest-prefix wins so a workspace nested under
      a repository — were that ever configured — would still classify as workspace.
    #>
    param([Parameter(Mandatory)] [string] $ResolvedPath)

    $best = 'external'
    $bestLen = -1
    foreach ($entry in $script:ZoneRoots.GetEnumerator()) {
        if ((Test-PathWithin -Parent $entry.Value -Child $ResolvedPath) -and $entry.Value.Length -gt $bestLen) {
            $best = $entry.Key
            $bestLen = $entry.Value.Length
        }
    }
    return $best
}

# ---------------------------------------------------------------------------------------------------
# Argument validation. Unknown keys, missing required keys, and wrong types are all refused here.
# ---------------------------------------------------------------------------------------------------

function Assert-KnownKeys {
    <# Every key present in $Payload must be declared for $Command; an unknown key is refused. #>
    param([Parameter(Mandatory)] [string] $Command, $Payload)

    $allowed = $script:CommandArgKeys[$Command]
    if ($null -eq $Payload) { return }
    if ($Payload -isnot [System.Collections.IDictionary]) {
        Write-HostError 'INVALID_ARGUMENT' "args for $Command must be an object"
    }
    foreach ($key in $Payload.Keys) {
        if ($allowed -notcontains $key) {
            Write-HostError 'INVALID_ARGUMENT' "unknown argument `"$key`" for $Command"
        }
    }
}

function Get-StringArg {
    param($Payload, [Parameter(Mandatory)] [string] $Key, [bool] $AllowNull = $false)
    if ($null -eq $Payload -or -not $Payload.Contains($Key)) {
        Write-HostError 'INVALID_ARGUMENT' "missing argument `"$Key`""
    }
    $value = $Payload[$Key]
    if ($null -eq $value) {
        if ($AllowNull) { return $null }
        Write-HostError 'INVALID_ARGUMENT' "argument `"$Key`" must not be null"
    }
    if ($value -isnot [string]) {
        Write-HostError 'INVALID_ARGUMENT' "argument `"$Key`" must be a string"
    }
    return [string] $value
}

function Get-IntArg {
    param($Payload, [Parameter(Mandatory)] [string] $Key)
    if ($null -eq $Payload -or -not $Payload.Contains($Key)) {
        Write-HostError 'INVALID_ARGUMENT' "missing argument `"$Key`""
    }
    $value = $Payload[$Key]
    if ($value -isnot [int] -and $value -isnot [long] -and $value -isnot [double]) {
        Write-HostError 'INVALID_ARGUMENT' "argument `"$Key`" must be a number"
    }
    $asLong = [long] $value
    if ([double] $value -ne [double] $asLong) {
        Write-HostError 'INVALID_ARGUMENT' "argument `"$Key`" must be an integer"
    }
    return $asLong
}

# ---------------------------------------------------------------------------------------------------
# Redaction and hashing.
# ---------------------------------------------------------------------------------------------------

function Protect-Secrets {
    <# Replaces any secret environment value found in $Text with a fixed marker. #>
    param([string] $Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $out = $Text
    foreach ($name in $script:SecretEnvNames) {
        $value = [System.Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrEmpty($value)) {
            $out = $out.Replace($value, "[redacted:$name]")
        }
    }
    return $out
}

function Get-Sha256Hex {
    <# Lower-case hex SHA-256 of a file, matching the sha256 schema the client enforces. #>
    param([Parameter(Mandatory)] [string] $Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-Sha256HexOfString {
    param([string] $Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string] $Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

# ---------------------------------------------------------------------------------------------------
# Process execution. One entry point runs an external program with a fixed argument vector, captures
# redacted stdout/stderr to files, and returns exit code, duration, and the file paths + hashes.
# ---------------------------------------------------------------------------------------------------

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory)] [string] $Executable,
        [Parameter(Mandatory)] [string[]] $Argv,
        [Parameter(Mandatory)] [string] $WorkingDirectory,
        [Parameter(Mandatory)] [string] $Label,
        [int] $TimeoutMs = 600000,
        [switch] $Git
    )

    $output = Resolve-AndEnforceZone -RawPath $script:OutputDir -RequiredZone 'workspace'
    [System.IO.Directory]::CreateDirectory($output.Path) | Out-Null
    $stamp = [Guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $output.Path "$Label-$stamp.out.log"
    $stderrPath = Join-Path $output.Path "$Label-$stamp.err.log"

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $Executable
    foreach ($a in $Argv) { $psi.ArgumentList.Add($a) }
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    foreach ($key in @($psi.Environment.Keys)) {
        if ($script:SecretEnvNames -contains $key -or ($Git -and $key -match '^(GIT|GCM|GH)_')) {
            [void] $psi.Environment.Remove($key)
        }
    }
    if ($Git) {
        $psi.Environment['GIT_ALLOW_PROTOCOL'] = 'file'
        $psi.Environment['GIT_TERMINAL_PROMPT'] = '0'
    }

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    [void] $proc.Start()
    $proc.StandardInput.Close()

    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    if (-not $proc.WaitForExit($TimeoutMs)) {
        try { $proc.Kill($true) } catch { }
        $sw.Stop()
        Write-HostError 'HOST_TIMEOUT' "$Label exceeded ${TimeoutMs}ms"
    }
    $sw.Stop()

    $stdout = Protect-Secrets ($stdoutTask.GetAwaiter().GetResult())
    $stderr = Protect-Secrets ($stderrTask.GetAwaiter().GetResult())
    Set-Content -LiteralPath $stdoutPath -Value $stdout -Encoding utf8 -NoNewline
    Set-Content -LiteralPath $stderrPath -Value $stderr -Encoding utf8 -NoNewline

    return [pscustomobject]@{
        ExitCode     = [int] $proc.ExitCode
        DurationMs   = [long] $sw.ElapsedMilliseconds
        Stdout       = $stdout
        StdoutSha256 = Get-Sha256Hex $stdoutPath
        StderrSha256 = Get-Sha256Hex $stderrPath
        StdoutPath   = $stdoutPath
        StderrPath   = $stderrPath
    }
}

# ---------------------------------------------------------------------------------------------------
# Git: verb + params resolved into a fixed argv, mirroring hostClient.gitArgv exactly. Any verb whose
# params are the wrong shape, or which is not permitted on the requested zone, is refused.
# ---------------------------------------------------------------------------------------------------

function Get-ParamsShape {
    param($Params)
    if ($null -eq $Params -or $Params -isnot [System.Collections.IDictionary] -or -not $Params.Contains('of')) {
        Write-HostError 'INVALID_ARGUMENT' 'git params must be an object with an `of` discriminator'
    }
    $of = [string] $Params['of']
    # DEV-P0-12: the shape must be known and the params may carry no key outside that shape's set, so a
    # nested params object cannot smuggle an extra field past the top-level key check.
    $allowed = $script:GitParamKeys[$of]
    if ($null -eq $allowed) {
        Write-HostError 'INVALID_ARGUMENT' "unknown git params shape `"$of`""
    }
    foreach ($key in $Params.Keys) {
        if ($allowed -notcontains $key) {
            Write-HostError 'INVALID_ARGUMENT' "unknown git param `"$key`" for shape `"$of`""
        }
    }
    return $of
}

function Resolve-GitArgv {
    param([Parameter(Mandatory)] [string] $Verb, $Params)

    $of = Get-ParamsShape $Params
    $wrong = { Write-HostError 'INVALID_ARGUMENT' "git verb `"$Verb`" received the wrong parameters" }

    # DEV-P0-12: operand VALUES are validated as strictly as shapes. A leading dash would be read by
    # git as an option; a traversal or ref-pattern shape is an injection regardless of intent. These
    # run host-side independent of the client's own equivalent checks, because a boundary that only
    # holds when the client cooperates is not a boundary.
    $operand = {
        param([string] $Value, [string] $Kind)
        if ($null -eq $Value -or $Value.Length -eq 0) { Write-HostError 'INVALID_ARGUMENT' "git $Kind must not be empty" }
        if ($Value.StartsWith('-')) { Write-HostError 'INVALID_ARGUMENT' "git $Kind must not begin with `"-`"" }
        return $Value
    }
    $refOperand = {
        param([string] $Value)
        [void] (& $operand $Value 'ref')
        if ($Value -match '\.\.' -or $Value -match '[~^:?*\[\\ ]' -or $Value -match '@\{' -or
            $Value.StartsWith('/') -or $Value.EndsWith('/') -or $Value.EndsWith('.lock')) {
            Write-HostError 'INVALID_ARGUMENT' "git ref `"$Value`" has forbidden syntax"
        }
        return $Value
    }
    $shaOperand = {
        param([string] $Value)
        if ($Value -notmatch '^[0-9a-f]{7,64}$') { Write-HostError 'INVALID_ARGUMENT' 'git sha must be lowercase hex (7-64 chars)' }
        return $Value
    }
    $pathOperand = {
        param([string] $Value, [string] $Kind)
        [void] (& $operand $Value $Kind)
        foreach ($component in ($Value -split '[\\/]')) {
            if ($component -eq '..') { Write-HostError 'INVALID_ARGUMENT' "git $Kind must not contain a `"..`" traversal" }
        }
        return $Value
    }

    switch ($Verb) {
        'status'          { if ($of -ne 'none') { & $wrong }; return @('status', '--porcelain=v1') }
        'revParseHead'    { if ($of -ne 'none') { & $wrong }; return @('rev-parse', 'HEAD') }
        'revParseBranch'  { if ($of -ne 'none') { & $wrong }; return @('rev-parse', '--abbrev-ref', 'HEAD') }
        'hashObject'      { if ($of -ne 'path') { & $wrong }; return @('hash-object', (& $pathOperand ([string] $Params['path']) 'path')) }
        'clone'           { if ($of -ne 'clone') { & $wrong }; return @('clone', '--no-checkout', (& $operand ([string] $Params['source']) 'source'), (& $pathOperand ([string] $Params['dest']) 'dest')) }
        'fetch'           { if ($of -ne 'none') { & $wrong }; return @('fetch', '--all', '--prune') }
        'checkout'        { if ($of -ne 'ref') { & $wrong }; return @('checkout', (& $refOperand ([string] $Params['ref']))) }
        'applyCheck'      { if ($of -ne 'path') { & $wrong }; return @('apply', '--check', (& $pathOperand ([string] $Params['path']) 'path')) }
        'apply'           { if ($of -ne 'path') { & $wrong }; return @('apply', (& $pathOperand ([string] $Params['path']) 'path')) }
        'addAll'          { if ($of -ne 'none') { & $wrong }; return @('add', '-A') }
        'commit'          { if ($of -ne 'commit') { & $wrong }; if (([string] $Params['message']).Length -eq 0) { Write-HostError 'INVALID_ARGUMENT' 'git commit message must not be empty' }; return @('commit', '-m', [string] $Params['message']) }
        'mergeFfOnly'     { if ($of -ne 'ref') { & $wrong }; return @('merge', '--ff-only', (& $refOperand ([string] $Params['ref']))) }
        'revert'          { if ($of -ne 'sha') { & $wrong }; return @('revert', '--no-edit', (& $shaOperand ([string] $Params['sha']))) }
        default           { & $wrong }
    }
}

function Assert-GitVerbAllowedOnZone {
    param([Parameter(Mandatory)] [string] $Verb, [Parameter(Mandatory)] [string] $Zone)
    if ($Zone -eq 'canonical') {
        # The canonical tree is read-only except for the two landing verbs.
        if (($script:GitReadVerbs -notcontains $Verb) -and ($script:GitLandingVerbs -notcontains $Verb)) {
            Write-HostError 'ZONE_FORBIDDEN' "git verb `"$Verb`" is not permitted on the canonical zone"
        }
    }
    # Shadow zone: any allowed verb is process execution in the experiment tree.
}

# ---------------------------------------------------------------------------------------------------
# Command handlers. Each validates, resolves and enforces its zone, does its one job, and returns a
# hashtable of { result; resolvedPath; zone }. resolvedPath/zone are $null for non-path commands.
# ---------------------------------------------------------------------------------------------------

function Invoke-Hello {
    param($Payload)
    # DEV-P0-11: echo the roots this host will actually enforce so the client can verify parity at
    # startup. The client sends the roots it requires; a host resolved to different directories is
    # refused by the client before any command is authorised.
    $result = [ordered]@{
        host       = $HostName
        protocol   = $script:ProtocolVersion
        pwshVersion = $PSVersionTable.PSVersion.ToString()
        os         = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
        roots      = $script:ZoneRoots
    }
    if ($null -ne $script:ProjectIdentityPin) {
        $result['projectIdentity'] = $script:ProjectIdentityPin
    }
    return @{ result = $result; resolvedPath = $null; zone = $null }
}

function Invoke-EnvHost {
    param($Payload)
    $result = [ordered]@{
        os          = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
        arch        = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        pwshVersion = $PSVersionTable.PSVersion.ToString()
        cpuCount    = [int] [System.Environment]::ProcessorCount
        totalMemBytes = [long] ((Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory)
    }
    return @{ result = $result; resolvedPath = $null; zone = $null }
}

function Resolve-AndEnforceZone {
    <# Resolves a target to its real path and zone, and refuses if the zone is not the required one. #>
    param([Parameter(Mandatory)] [string] $RawPath, [Parameter(Mandatory)] [string] $RequiredZone)
    $resolved = Resolve-RealPath $RawPath
    $zone = Get-Zone $resolved
    if ($zone -ne $RequiredZone) {
        Write-HostError 'ZONE_MISMATCH' "path resolved into the $zone zone; the $RequiredZone zone was required"
    }
    return [pscustomobject]@{ Path = $resolved; Zone = $zone }
}

function Resolve-GitOperandPath {
    param([string] $Path, [string] $Base, [string[]] $Zones)
    if (($IsWindows -and (($Path -replace '^[A-Za-z]:[\\/]', '') -match ':')) -or $Path -match '^[\\/]{2}') {
        Write-HostError 'INVALID_ARGUMENT' 'Git operand must be a local filesystem path'
    }
    $resolved = Resolve-RealPath ([System.IO.Path]::GetFullPath($Path, $Base))
    if ($Zones -notcontains (Get-Zone $resolved)) {
        Write-HostError 'ZONE_MISMATCH' 'Git operand is outside the allowed filesystem zones'
    }
    return $resolved
}

function Find-HostApplication {
    param([string] $Name)
    foreach ($entry in @(Get-Command -Name $Name -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $resolved = Resolve-RealPath $entry.Source
        if ((Get-Zone $resolved) -eq 'external') { return $resolved }
    }
    Write-HostError 'HOST_ERROR' "A host $Name installation is required outside the configured zones"
}

function Get-HostNpmTool {
    if ($IsWindows) {
        $node = Find-HostApplication 'node.exe'
        $npm = Find-HostApplication 'npm.cmd'
        $cli = Resolve-RealPath (Join-Path ([System.IO.Path]::GetDirectoryName($npm)) 'node_modules/npm/bin/npm-cli.js')
    }
    else {
        $node = Find-HostApplication 'node'
        $cli = Find-HostApplication 'npm'
    }
    if ((Get-Zone $cli) -ne 'external' -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        Write-HostError 'HOST_ERROR' 'A host npm CLI installation is required outside the configured zones'
    }
    return [pscustomobject]@{ Node = $node; Cli = $cli }
}

function Invoke-HostGit {
    param([string[]] $Argv, [string] $Root, [string] $Label)
    $tool = Find-HostApplication ($(if ($IsWindows) { 'git.exe' } else { 'git' }))
    $gitArgs = @('--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0') + $Argv
    return Invoke-CapturedProcess -Executable $tool -Argv $gitArgs -WorkingDirectory $Root -Label $Label -Git
}

function Assert-HostGitRoot {
    param([string] $Root, [string] $Zone)
    $top = Invoke-HostGit @('rev-parse', '--show-toplevel') $Root 'git-check-root'
    if ($top.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($top.Stdout)) {
        Write-HostError 'HOST_ERROR' 'Git repository root is unavailable'
    }
    $resolved = Resolve-AndEnforceZone -RawPath $top.Stdout.Trim() -RequiredZone $Zone
    if (-not (Test-PathWithin $resolved.Path $Root) -or -not (Test-PathWithin $Root $resolved.Path)) {
        Write-HostError 'ZONE_MISMATCH' 'Git command requires the exact top-level checkout directory'
    }
    foreach ($flag in @('--absolute-git-dir', '--git-common-dir')) {
        $metadata = Invoke-HostGit @('rev-parse', '--path-format=absolute', $flag) $Root 'git-check-metadata'
        if ($metadata.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($metadata.Stdout)) {
            Write-HostError 'HOST_ERROR' 'Git repository metadata directory is unavailable'
        }
        [void] (Resolve-AndEnforceZone -RawPath $metadata.Stdout.Trim() -RequiredZone $Zone)
    }
}

function Invoke-CanonicalFetch {
    param([string] $Shadow, [string] $Canonical, [string] $Ref)
    $effective = Invoke-HostGit @('ls-remote', '--get-url', '--', $Canonical) $Shadow 'shadow-check-source'
    if ($effective.ExitCode -ne 0 -or $effective.Stdout.Trim() -cne $Canonical) {
        Write-HostError 'HOST_ERROR' 'Git did not resolve the fetch source to the canonical checkout'
    }
    return Invoke-HostGit @('fetch', '--no-tags', '--no-recurse-submodules', '--', $Canonical, $Ref) $Shadow 'shadow-fetch'
}

function Invoke-FsHash {
    param($Payload)
    $zone = Get-StringArg $Payload 'zone'
    $path = Get-StringArg $Payload 'path'
    if ($zone -eq 'external') { Write-HostError 'INVALID_ARGUMENT' 'fs commands may not target the external zone' }
    $r = Resolve-AndEnforceZone -RawPath $path -RequiredZone $zone
    if (-not (Test-Path -LiteralPath $r.Path -PathType Leaf)) {
        Write-HostError 'NOT_FOUND' 'file does not exist'
    }
    $bytes = [long] ((Get-Item -LiteralPath $r.Path -Force).Length)
    $result = [ordered]@{ sha256 = (Get-Sha256Hex $r.Path); bytes = $bytes }
    return @{ result = $result; resolvedPath = $r.Path; zone = $r.Zone }
}

function Invoke-FsStat {
    param($Payload)
    $zone = Get-StringArg $Payload 'zone'
    $path = Get-StringArg $Payload 'path'
    if ($zone -eq 'external') { Write-HostError 'INVALID_ARGUMENT' 'fs commands may not target the external zone' }
    $r = Resolve-AndEnforceZone -RawPath $path -RequiredZone $zone
    $exists = Test-Path -LiteralPath $r.Path
    $isFile = $false; $isDirectory = $false; $bytes = $null; $mtimeMs = $null
    if ($exists) {
        $item = Get-Item -LiteralPath $r.Path -Force
        $isDirectory = [bool] ($item.PSIsContainer)
        $isFile = -not $isDirectory
        if ($isFile) { $bytes = [long] $item.Length }
        $mtimeMs = [long] ([DateTimeOffset]::new($item.LastWriteTimeUtc).ToUnixTimeMilliseconds())
    }
    $result = [ordered]@{
        exists = [bool] $exists
        isFile = [bool] $isFile
        isDirectory = [bool] $isDirectory
        bytes = $bytes
        mtimeMs = $mtimeMs
    }
    return @{ result = $result; resolvedPath = $r.Path; zone = $r.Zone }
}

function Invoke-Git {
    param($Payload)
    $zone = Get-StringArg $Payload 'zone'
    $root = Get-StringArg $Payload 'root'
    $verb = Get-StringArg $Payload 'verb'
    if ($zone -ne 'canonical' -and $zone -ne 'shadow') {
        Write-HostError 'INVALID_ARGUMENT' 'git zone must be canonical or shadow'
    }
    if ($script:GitAllVerbs -notcontains $verb) {
        Write-HostError 'INVALID_ARGUMENT' "unknown git verb `"$verb`""
    }
    if (-not $Payload.Contains('params')) { Write-HostError 'INVALID_ARGUMENT' 'git requires params' }
    Assert-GitVerbAllowedOnZone -Verb $verb -Zone $zone
    $argv = Resolve-GitArgv -Verb $verb -Params $Payload['params']
    # DEV-P0-12: the landing ref prefix is enforced HERE, independently of the client's policy engine.
    # A canonical fast-forward merge may only ever aim at a ref inside the configured landing prefix;
    # with no prefix configured, canonical landing is refused outright. A compromised or drifted client
    # cannot land outside the prefix, because the host holds the rule itself. Runs after Resolve-GitArgv
    # so a malformed params object is still refused for its shape, with the shape's own message.
    if ($zone -eq 'canonical' -and $verb -eq 'mergeFfOnly') {
        if ([string]::IsNullOrEmpty($script:LandingRefPrefix)) {
            Write-HostError 'LANDING_NOT_CONFIGURED' 'no -LandingRefPrefix was configured at startup; canonical landing is refused'
        }
        $landRef = [string] $Payload['params']['ref']
        if (-not $landRef.StartsWith($script:LandingRefPrefix)) {
            Write-HostError 'GIT_REF_FORBIDDEN' "ref `"$landRef`" is outside the landing prefix `"$($script:LandingRefPrefix)`""
        }
    }

    $r = Resolve-AndEnforceZone -RawPath $root -RequiredZone $zone
    if (-not (Test-Path -LiteralPath $r.Path -PathType Container)) {
        Write-HostError 'NOT_FOUND' 'git root directory does not exist'
    }
    if ($verb -eq 'clone') {
        $source = Resolve-GitOperandPath $argv[2] $r.Path @('canonical')
        $destination = Resolve-GitOperandPath $argv[3] $r.Path @('shadow')
        Assert-HostGitRoot $source 'canonical'
        $effective = Invoke-HostGit @('ls-remote', '--get-url', '--', $source) $r.Path 'shadow-check-source'
        if ($effective.ExitCode -ne 0 -or $effective.Stdout.Trim() -cne $source) {
            Write-HostError 'HOST_ERROR' 'Git did not resolve the clone source to the canonical checkout'
        }
        $run = Invoke-HostGit @('clone', '--no-checkout', '--no-local', '--', $source, $destination) $r.Path "git-$verb"
    }
    else {
        if ($verb -eq 'hashObject') {
            $argv[1] = Resolve-GitOperandPath $argv[1] $r.Path @($zone)
        }
        elseif ($verb -eq 'apply' -or $verb -eq 'applyCheck') {
            $argv[$argv.Length - 1] = Resolve-GitOperandPath $argv[$argv.Length - 1] $r.Path @('shadow', 'workspace')
        }
        Assert-HostGitRoot $r.Path $zone
        if ($verb -eq 'fetch') {
            $canonical = Resolve-AndEnforceZone -RawPath $script:ZoneRoots['canonical'] -RequiredZone 'canonical'
            Assert-HostGitRoot $canonical.Path 'canonical'
            $run = Invoke-CanonicalFetch $r.Path $canonical.Path 'HEAD'
        }
        else {
            $run = Invoke-HostGit $argv $r.Path "git-$verb"
        }
    }
    # Git stdout is returned inline (small by construction — porcelain status, a hash, a ref) but
    # still redacted; large output belongs in shadow.run's captured files, not here.
    $result = [ordered]@{
        verb = $verb
        exitCode = [int] $run.ExitCode
        durationMs = [long] $run.DurationMs
        stdout = (Protect-Secrets $run.Stdout).Trim()
    }
    return @{ result = $result; resolvedPath = $r.Path; zone = $r.Zone }
}

function Invoke-ShadowRefresh {
    param($Payload)
    $canonicalRoot = Get-StringArg $Payload 'canonicalRoot'
    $shadowRoot = Get-StringArg $Payload 'shadowRoot'
    $commit = Get-StringArg $Payload 'commit' -AllowNull $true
    if ($null -ne $commit -and $commit -cnotmatch '\A[0-9a-f]{7,64}\z') {
        Write-HostError 'INVALID_ARGUMENT' 'shadow refresh requires a canonical commit ID or null'
    }

    $canon = Resolve-AndEnforceZone -RawPath $canonicalRoot -RequiredZone 'canonical'
    $shadow = Resolve-AndEnforceZone -RawPath $shadowRoot -RequiredZone 'shadow'

    Assert-HostGitRoot $canon.Path 'canonical'
    Assert-HostGitRoot $shadow.Path 'shadow'
    $wanted = if ($null -eq $commit) { 'HEAD' } else { $commit }
    $headRun = Invoke-HostGit @('rev-parse', '--verify', "${wanted}^{commit}") $canon.Path 'shadow-canon-head'
    $target = $headRun.Stdout.Trim()
    if ($headRun.ExitCode -ne 0 -or $target -cnotmatch '\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z') {
        Write-HostError 'HOST_ERROR' 'could not resolve the requested canonical commit'
    }
    $fetch = Invoke-CanonicalFetch $shadow.Path $canon.Path $target
    if ($fetch.ExitCode -ne 0) { Write-HostError 'HOST_ERROR' 'could not fetch the requested canonical commit' }
    $checkout = Invoke-HostGit @('checkout', '--force', '--detach', $target) $shadow.Path 'shadow-checkout'
    if ($checkout.ExitCode -ne 0) { Write-HostError 'HOST_ERROR' "shadow checkout of $target failed" }

    $headRun2 = Invoke-HostGit @('rev-parse', 'HEAD') $shadow.Path 'shadow-head'
    $head = $headRun2.Stdout.Trim().ToLowerInvariant()
    if ($head -notmatch '^[0-9a-f]{7,64}$') { Write-HostError 'HOST_ERROR' 'shadow HEAD is not a git object id' }

    $result = [ordered]@{ head = $head }
    return @{ result = $result; resolvedPath = $shadow.Path; zone = $shadow.Zone }
}

$script:ServeProcess = $null

function Invoke-ShadowRun {
    param($Payload)
    $shadowRoot = Get-StringArg $Payload 'shadowRoot'
    $script = Get-StringArg $Payload 'script'
    $timeoutMs = [int] (Get-IntArg $Payload 'timeoutMs')
    if (-not $script:ShadowArgv.Contains($script)) {
        Write-HostError 'INVALID_ARGUMENT' "unknown shadow script `"$script`""
    }
    $shadow = Resolve-AndEnforceZone -RawPath $shadowRoot -RequiredZone 'shadow'

    if ($script -eq 'serve.stop') {
        $stopped = $false
        if ($null -ne $script:ServeProcess) {
            try { $script:ServeProcess.Kill($true); $stopped = $true } catch { }
            $script:ServeProcess = $null
        }
        $empty = Get-Sha256HexOfString ''
        $result = [ordered]@{
            script = $script
            exitCode = ([int] ((([bool] $stopped)) ? 0 : 1))
            durationMs = [long] 0
            stdoutSha256 = $empty
            stderrSha256 = $empty
            stdoutPath = $null
            stderrPath = $null
        }
        return @{ result = $result; resolvedPath = $shadow.Path; zone = $shadow.Zone }
    }

    if ($script -eq 'serve.start') {
        # The dev server is long-lived; start it in the background, capture its early output, and
        # report started/failed rather than blocking until it exits.
        if ($null -ne $script:ServeProcess -and -not $script:ServeProcess.HasExited) {
            Write-HostError 'HOST_ERROR' 'The shadow server is already running'
        }
        $npmTool = Get-HostNpmTool
        $output = Resolve-AndEnforceZone -RawPath $script:OutputDir -RequiredZone 'workspace'
        [System.IO.Directory]::CreateDirectory($output.Path) | Out-Null
        $stamp = [Guid]::NewGuid().ToString('N')
        $outPath = Join-Path $output.Path "serve-$stamp.out.log"
        $errPath = Join-Path $output.Path "serve-$stamp.err.log"
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $npmTool.Node
        $psi.ArgumentList.Add($npmTool.Cli)
        foreach ($a in $script:ShadowArgv['serve.start']) { $psi.ArgumentList.Add($a) }
        $psi.WorkingDirectory = $shadow.Path
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        foreach ($key in @($psi.Environment.Keys)) {
            if ($script:SecretEnvNames -contains $key) { [void] $psi.Environment.Remove($key) }
        }
        $proc = [System.Diagnostics.Process]::new()
        $proc.StartInfo = $psi
        [void] $proc.Start()
        $proc.StandardInput.Close()
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()
        $script:ServeProcess = $proc
        Start-Sleep -Milliseconds ([Math]::Min($timeoutMs, 1500))
        $started = -not $proc.HasExited
        Set-Content -LiteralPath $outPath -Value '' -Encoding utf8 -NoNewline
        Set-Content -LiteralPath $errPath -Value '' -Encoding utf8 -NoNewline
        $empty = Get-Sha256HexOfString ''
        $result = [ordered]@{
            script = $script
            exitCode = ([int] ((([bool] $started)) ? 0 : $proc.ExitCode))
            durationMs = [long] 0
            stdoutSha256 = $empty
            stderrSha256 = $empty
            stdoutPath = $outPath
            stderrPath = $errPath
        }
        return @{ result = $result; resolvedPath = $shadow.Path; zone = $shadow.Zone }
    }

    $npmTool = Get-HostNpmTool
    $argv = @($npmTool.Cli) + $script:ShadowArgv[$script]
    $run = Invoke-CapturedProcess -Executable $npmTool.Node -Argv $argv -WorkingDirectory $shadow.Path -Label "shadow-$script" -TimeoutMs $timeoutMs
    $result = [ordered]@{
        script = $script
        exitCode = [int] $run.ExitCode
        durationMs = [long] $run.DurationMs
        stdoutSha256 = $run.StdoutSha256
        stderrSha256 = $run.StderrSha256
        stdoutPath = $run.StdoutPath
        stderrPath = $run.StderrPath
    }
    return @{ result = $result; resolvedPath = $shadow.Path; zone = $shadow.Zone }
}

function Invoke-BrowserLaunch {
    param($Payload)
    # DEV-P0-12: the executable is pinned at startup and origins are allowlisted at startup. With no
    # pin or no origins configured, launching is refused entirely — the host will not start a process
    # whose identity or destination is caller data.
    if ([string]::IsNullOrEmpty($script:BrowserExecutablePin)) {
        Write-HostError 'BROWSER_NOT_CONFIGURED' 'no -BrowserExecutable was pinned at startup; browser.launch is refused'
    }
    if ($script:BrowserOriginAllowlist.Count -eq 0) {
        Write-HostError 'BROWSER_NOT_CONFIGURED' 'no -AllowedBrowserOrigins were configured at startup; browser.launch is refused'
    }
    $executable = Get-StringArg $Payload 'executable'
    $profileDir = Get-StringArg $Payload 'profileDir'
    $port = [int] (Get-IntArg $Payload 'port')
    $url = Get-StringArg $Payload 'url'
    $timeoutMs = [int] (Get-IntArg $Payload 'timeoutMs')
    # The request still names an executable (the protocol is unchanged), but it must be the pinned one —
    # resolved on both sides so a path spelling cannot dodge the comparison.
    if (-not [string]::Equals((Resolve-RealPath $executable), (Resolve-RealPath $script:BrowserExecutablePin), [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-HostError 'INVALID_ARGUMENT' 'browser.launch executable does not match the startup-pinned -BrowserExecutable'
    }
    $launchUri = $null
    if (-not [System.Uri]::TryCreate($url, [System.UriKind]::Absolute, [ref] $launchUri)) {
        Write-HostError 'INVALID_ARGUMENT' 'browser.launch url must be an absolute URL'
    }
    $origin = "$($launchUri.Scheme)://$($launchUri.Authority)".ToLowerInvariant()
    if ($script:BrowserOriginAllowlist -notcontains $origin) {
        Write-HostError 'ORIGIN_FORBIDDEN' "url origin `"$origin`" is not in the allowed browser origins"
    }
    $r = Resolve-AndEnforceZone -RawPath $profileDir -RequiredZone 'browserProfile'

    # Fixed measurement flags: bind the debugging port to loopback, isolate the profile, and disable
    # the throttling that makes an unfocused window's frame timing meaningless. No flag is caller data.
    $argv = @(
        "--remote-debugging-port=$port",
        "--user-data-dir=$($r.Path)",
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        $url
    )
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $executable
    foreach ($a in $argv) { $psi.ArgumentList.Add($a) }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $false
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    [void] $proc.Start()

    # Poll the DevTools endpoint until it answers or the timeout expires; report only a verified start.
    $endpoint = "http://127.0.0.1:$port/json/version"
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    $started = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            Invoke-RestMethod -Uri $endpoint -TimeoutSec 2 | Out-Null
            $started = $true
            break
        }
        catch { Start-Sleep -Milliseconds 200 }
    }
    $result = [ordered]@{
        started = [bool] $started
        endpoint = ($started ? $endpoint : $null)
        pid = [int] $proc.Id
    }
    return @{ result = $result; resolvedPath = $r.Path; zone = $r.Zone }
}

function Invoke-BrowserStatus {
    param($Payload)
    $port = [int] (Get-IntArg $Payload 'port')
    $endpoint = "http://127.0.0.1:$port/json/version"
    $running = $false
    try { Invoke-RestMethod -Uri $endpoint -TimeoutSec 2 | Out-Null; $running = $true } catch { }
    $result = [ordered]@{ running = [bool] $running; endpoint = ($running ? $endpoint : $null) }
    return @{ result = $result; resolvedPath = $null; zone = $null }
}

function Invoke-BrowserStop {
    param($Payload)
    $profileDir = Get-StringArg $Payload 'profileDir'
    $r = Resolve-AndEnforceZone -RawPath $profileDir -RequiredZone 'browserProfile'
    # Only the browser started against this exact profile directory is touched, matched on its
    # command line — never every Chrome on the machine.
    $needle = "--user-data-dir=$($r.Path)"
    $stopped = $false
    $candidates = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue
    foreach ($c in $candidates) {
        if ($null -ne $c.CommandLine -and $c.CommandLine.Contains($needle)) {
            try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; $stopped = $true } catch { }
        }
    }
    $result = [ordered]@{ stopped = [bool] $stopped }
    return @{ result = $result; resolvedPath = $r.Path; zone = $r.Zone }
}

$script:Handlers = @{
    'host.hello'     = 'Invoke-Hello'
    'env.host'       = 'Invoke-EnvHost'
    'shadow.refresh' = 'Invoke-ShadowRefresh'
    'shadow.run'     = 'Invoke-ShadowRun'
    'git'            = 'Invoke-Git'
    'fs.hash'        = 'Invoke-FsHash'
    'fs.stat'        = 'Invoke-FsStat'
    'browser.launch' = 'Invoke-BrowserLaunch'
    'browser.status' = 'Invoke-BrowserStatus'
    'browser.stop'   = 'Invoke-BrowserStop'
}

# ---------------------------------------------------------------------------------------------------
# The wire: emit one compact JSON reply per request, and read one request per line until stdin ends.
# ---------------------------------------------------------------------------------------------------

function Write-Reply {
    param(
        [string] $Id,
        [bool] $Ok,
        $Result = $null,
        [string] $Code = $null,
        [string] $Message = $null,
        [string] $ResolvedPath = $null,
        [string] $Zone = $null
    )
    # DEV-P0-11: emit exactly the strict envelope the client validates — a success carries a result and
    # never an error code/message; a failure carries a code and never a result. resolvedPath/zone are
    # the host's resolution (null for non-path commands) and appear on either.
    $envelope = [ordered]@{
        v  = $script:ProtocolVersion
        id = $Id
        ok = $Ok
    }
    if ($Ok) {
        $envelope['result'] = $Result
    }
    else {
        $envelope['code'] = $Code
        $envelope['message'] = $Message
    }
    $envelope['resolvedPath'] = $ResolvedPath
    $envelope['zone'] = $Zone
    if ($null -ne $script:ProjectIdentityPin) {
        $envelope['projectIdentity'] = $script:ProjectIdentityPin
    }
    # -Compress keeps one object on one line; the client splits stdout on newlines.
    $line = $envelope | ConvertTo-Json -Depth 8 -Compress
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Invoke-Request {
    param([string] $Line)

    $request = $null
    try {
        $request = $Line | ConvertFrom-Json -AsHashtable -Depth 12
    }
    catch {
        Write-Reply -Id '' -Ok $false -Code 'MALFORMED_REQUEST' -Message 'request was not valid JSON'
        return
    }
    if ($request -isnot [System.Collections.IDictionary]) {
        Write-Reply -Id '' -Ok $false -Code 'MALFORMED_REQUEST' -Message 'request was not an object'
        return
    }

    $id = if ($request.Contains('id') -and $request['id'] -is [string]) { [string] $request['id'] } else { '' }

    try {
        if (-not $request.Contains('v') -or [int] $request['v'] -ne $script:ProtocolVersion) {
            Write-HostError 'PROTOCOL_MISMATCH' 'unsupported or missing protocol version'
        }
        if ($id -eq '') { Write-HostError 'MALFORMED_REQUEST' 'request is missing a string id' }
        # DEV-P0-12: the OUTER envelope is as closed as command args. A request carrying any key
        # beyond the protocol's four is refused, so nothing can ride alongside a valid command.
        foreach ($key in $request.Keys) {
            if (@('v', 'id', 'command', 'args', 'projectIdentity') -notcontains $key) {
                Write-HostError 'INVALID_ARGUMENT' "unknown request key `"$key`""
            }
        }
        if (-not $request.Contains('command') -or $request['command'] -isnot [string]) {
            Write-HostError 'MALFORMED_REQUEST' 'request is missing a command'
        }
        $command = [string] $request['command']
        if (-not $script:Handlers.Contains($command)) {
            Write-HostError 'UNKNOWN_COMMAND' "unknown command `"$command`""
        }
        Assert-ProjectIdentityParity -Request $request
        $cmdArgs = if ($request.Contains('args')) { $request['args'] } else { @{} }
        Assert-KnownKeys -Command $command -Payload $cmdArgs

        $handler = $script:Handlers[$command]
        $outcome = & $handler $cmdArgs
        Write-Reply -Id $id -Ok $true -Result $outcome.result -ResolvedPath $outcome.resolvedPath -Zone $outcome.zone
    }
    catch [HostCommandError] {
        Write-Reply -Id $id -Ok $false -Code $_.Exception.Code -Message (Protect-Secrets $_.Exception.Message)
    }
    catch {
        Write-Reply -Id $id -Ok $false -Code 'HOST_ERROR' -Message (Protect-Secrets $_.Exception.Message)
    }
}

# The read loop. One request per line; a blank line is ignored; EOF ends the session cleanly.
while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    Invoke-Request -Line $line
}
