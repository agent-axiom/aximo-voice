$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'No prebuilt Aximo Voice runtime is available for this Windows architecture.'
}
$Entries = @(Get-Content "$PSScriptRoot/runtime-manifest.txt" | Where-Object { $_ -match '^windows-x86_64\s' })
if ($Entries.Count -ne 1) { throw 'This source preview has no published, verified runtime. See docs/installation.md.' }
$Parts = $Entries[0] -split '\s+'
if ($Parts.Count -ne 3 -or $Parts[1] -notmatch '^[0-9a-f]{64}$' -or $Parts[2] -notmatch '^https://github\.com/agent-axiom/aximo-voice/releases/download/v[^/]+/aximo-voice-native-windows-x86_64\.zip$') { throw 'Invalid runtime manifest.' }
$Bin = Join-Path $Root 'bin'
if ((Test-Path $Bin) -and ((Get-Item $Bin).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a linked runtime directory.' }
if ((Test-Path $Bin) -and -not (Test-Path $Bin -PathType Container)) { throw 'Runtime destination is not a directory.' }
$Temporary = Join-Path $Root ('.runtime-setup.' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temporary | Out-Null
$Previous = Join-Path $Temporary 'previous'
try {
    $Archive = Join-Path $Temporary 'runtime.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Parts[2] -OutFile $Archive -UseBasicParsing -TimeoutSec 480
    if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Parts[1]) { throw 'Runtime checksum mismatch; runtime was not installed.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        if ($Zip.Entries.Count -lt 1 -or $Zip.Entries.Count -gt 64) { throw 'Invalid runtime archive size.' }
        $Seen = @{}; [long]$Total = 0
        foreach ($Entry in $Zip.Entries) {
            $Name = $Entry.FullName
            if ($Name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' -or $Seen.ContainsKey($Name.ToLowerInvariant())) { throw 'Unsafe or duplicate runtime archive entry.' }
            if ((($Entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Runtime archive links are not allowed.' }
            $Seen[$Name.ToLowerInvariant()] = $true; $Total += $Entry.Length
            if ($Total -gt 1073741824) { throw 'Runtime archive is too large.' }
        }
    } finally { $Zip.Dispose() }
    $Stage = Join-Path $Temporary 'runtime'
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Stage)
    $Executable = Join-Path $Stage 'aximo-voice-native.exe'
    if (-not (Test-Path $Executable -PathType Leaf)) { throw 'Runtime executable is missing.' }
    & $Executable --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Relocated runtime verification failed; existing runtime was kept.' }
    if (Test-Path $Bin) { Move-Item -LiteralPath $Bin -Destination $Previous }
    Move-Item -LiteralPath $Stage -Destination $Bin
    Write-Output 'Verified Aximo Voice runtime bundle installed.'
} finally {
    if (-not (Test-Path $Bin) -and (Test-Path $Previous)) { Move-Item -LiteralPath $Previous -Destination $Bin }
    if (Test-Path $Temporary) { Remove-Item -LiteralPath $Temporary -Recurse }
}
