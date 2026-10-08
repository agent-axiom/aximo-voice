$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'No prebuilt Aximo Voice runtime is available for this Windows architecture.'
}
$Entries = @(Get-Content "$PSScriptRoot/runtime-manifest.txt" | Where-Object { $_ -match '^windows-x86_64\s' })
if ($Entries.Count -ne 1) { throw 'This source preview has no published, verified runtime. See docs/installation.md.' }
$Parts = $Entries[0] -split '\s+'
if ($Parts.Count -ne 3 -or $Parts[1] -notmatch '^[0-9a-f]{64}$' -or $Parts[2] -notmatch '^https://github\.com/agent-axiom/aximo-voice/releases/download/v[^/]+/aximo-voice-native-[^/]+$') { throw 'Invalid runtime manifest.' }
$Bin = Join-Path $Root 'bin'
if ((Test-Path $Bin) -and ((Get-Item $Bin).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a linked runtime directory.' }
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
$Temporary = Join-Path $Bin ('.runtime.' + [guid]::NewGuid().ToString('N'))
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Parts[2] -OutFile $Temporary -UseBasicParsing -TimeoutSec 480
    if ((Get-FileHash $Temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Parts[1]) { throw 'Runtime checksum mismatch; runtime was not installed.' }
    Move-Item -Force -LiteralPath $Temporary -Destination (Join-Path $Bin 'aximo-voice-native.exe')
    Write-Output 'Verified Aximo Voice runtime installed.'
} finally { if (Test-Path $Temporary) { Remove-Item -LiteralPath $Temporary } }
