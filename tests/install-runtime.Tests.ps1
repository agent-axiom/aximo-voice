$ErrorActionPreference = 'Stop'
$Root = Join-Path ([IO.Path]::GetTempPath()) ('aximo installer tests ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Root | Out-Null
$Installer = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/install-runtime.ps1'
$PreviousArchive = $env:AXIMO_TEST_ARCHIVE
$env:AXIMO_TEST_ARCHIVE = ''
# No network is reached by these installer tests.
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec)
    Copy-Item -LiteralPath $env:AXIMO_TEST_ARCHIVE -Destination $OutFile
}
function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
try {
    $Good = Join-Path $Root 'good.exe'; $Bad = Join-Path $Root 'bad.exe'
    Add-Type -TypeDefinition 'public class AximoGood { public static int Main(string[] args) { return 0; } }' -Language CSharp -OutputAssembly $Good -OutputType ConsoleApplication
    Add-Type -TypeDefinition 'public class AximoBad { public static int Main(string[] args) { return 1; } }' -Language CSharp -OutputAssembly $Bad -OutputType ConsoleApplication
    foreach ($Case in @('success', 'checksum', 'startup', 'traversal', 'empty')) {
        $Dir = Join-Path $Root $Case; $Scripts = Join-Path $Dir 'scripts'; $Payload = Join-Path $Dir 'payload'
        New-Item -ItemType Directory -Path $Scripts, $Payload | Out-Null
        Copy-Item $Installer (Join-Path $Scripts 'install-runtime.ps1')
        $Helper = if ($Case -eq 'startup') { $Bad } else { $Good }
        Copy-Item $Helper (Join-Path $Payload 'aximo-voice-native.exe')
        Set-Content -Path (Join-Path $Payload 'onnxruntime.dll') -Value 'fixture dependency'
        $env:AXIMO_TEST_ARCHIVE = Join-Path $Dir 'fixture.zip'
        Compress-Archive -Path (Join-Path $Payload '*') -DestinationPath $env:AXIMO_TEST_ARCHIVE
        if ($Case -eq 'traversal') {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $Zip = [IO.Compression.ZipFile]::Open($env:AXIMO_TEST_ARCHIVE, [IO.Compression.ZipArchiveMode]::Update)
            try { $Entry = $Zip.CreateEntry('../escape'); $Writer = New-Object IO.StreamWriter($Entry.Open()); $Writer.Write('bad'); $Writer.Dispose() } finally { $Zip.Dispose() }
        }
        $Hash = (Get-FileHash $env:AXIMO_TEST_ARCHIVE -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($Case -eq 'checksum') { $Hash = 'a' * 64 }
        $Manifest = if ($Case -eq 'empty') { '# source preview' } else { "windows-x86_64 $Hash https://github.com/agent-axiom/aximo-voice/releases/download/v0.1.0/aximo-voice-native-windows-x86_64.zip" }
        Set-Content -Path (Join-Path $Scripts 'runtime-manifest.txt') -Value $Manifest
        $Bin = Join-Path $Dir 'bin'; New-Item -ItemType Directory -Path $Bin | Out-Null
        $Installed = Join-Path $Bin 'aximo-voice-native.exe'; Set-Content $Installed 'existing runtime'
        $Succeeded = $true
        try { & (Join-Path $Scripts 'install-runtime.ps1') } catch { $Succeeded = $false; Write-Host "Expected failure in ${Case}: $($_.Exception.Message)" }
        if ($Case -eq 'success') {
            Assert-True $Succeeded 'Valid bundle did not install'
            Assert-True ((Get-FileHash $Installed).Hash -eq (Get-FileHash $Good).Hash) 'Wrong installed helper'
            Assert-True (Test-Path (Join-Path $Bin 'onnxruntime.dll')) 'Dependency was not installed'
        } else {
            Assert-True (-not $Succeeded) "Invalid $Case bundle was installed"
            Assert-True ((Get-Content $Installed -Raw).Trim() -eq 'existing runtime') 'Working installation was changed on failure'
        }
        Write-Host "PASS $Case"
    }
    $global:LASTEXITCODE = 0
} finally {
    $env:AXIMO_TEST_ARCHIVE = $PreviousArchive
    Remove-Item -LiteralPath $Root -Recurse
}
