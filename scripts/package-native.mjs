import { readFile, readdir, mkdir, copyFile, chmod, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { peImports } from './pe-imports.mjs';
import { machoInfo } from './macho-info.mjs';

const manifest = JSON.parse(await readFile(new URL('./onnx-runtime-manifest.json', import.meta.url), 'utf8'));
const platform = process.argv[2], entry = manifest.platforms[platform];
if (!entry || entry.os !== process.platform || entry.arch !== process.arch) throw Error('Runner architecture does not match package name');
const root = resolve(process.env.AXIMO_ONNX_ROOT || `native/target/onnx/${platform}/runtime`);
const upstreamLib = join(root, 'lib');
const helper = `aximo-voice-native${process.platform === 'win32' ? '.exe' : ''}`;
const runtime = resolve('dist/runtime');
await rm(runtime, { force: true, recursive: true });
await mkdir(runtime, { recursive: true });
await copyFile(`native/target/release/${helper}`, join(runtime, helper));
await chmod(join(runtime, helper), 0o755);
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
async function sha(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
const pattern = process.platform === 'win32' ? /^onnxruntime(?:_providers_shared)?\.dll$/i : process.platform === 'darwin' ? /^libonnxruntime(?:\.[0-9.]+)?\.dylib$/ : /^libonnxruntime(?:_providers_shared)?\.so(?:\.[0-9.]+)?$/;
const libraryRoot = await realpath(upstreamLib);
for (const name of await readdir(upstreamLib)) {
  if (!pattern.test(name)) continue;
  const source = await realpath(join(upstreamLib, name));
  if (!source.startsWith(`${libraryRoot}${sep}`)) throw Error('Upstream runtime link escapes its authenticated directory');
  await copyFile(source, join(runtime, name)); // regular files, never archive symlinks
}
for (const [source, target] of [['LICENSE','ONNX-LICENSE.txt'],['ThirdPartyNotices.txt','ONNX-THIRD-PARTY-NOTICES.txt'],['Privacy.md','ONNX-PRIVACY.md'],['AXIMO-ONNX-SOURCE.json','ONNX-SOURCE.json']]) await copyFile(join(root, source), join(runtime, target));
await copyFile('LICENSE', join(runtime, 'AXIMO-LICENSE.txt'));
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (/^(ORT_|AXIMO_ONNX_|LD_LIBRARY_PATH$|LD_PRELOAD$|DYLD_)/i.test(key)) delete cleanEnv[key];
if (process.platform === 'win32') { for (const key of Object.keys(cleanEnv)) if (key.toLowerCase() === 'path') delete cleanEnv[key]; cleanEnv.Path = join(process.env.SystemRoot || 'C:\\Windows','System32'); }
const compatibility = { architecture: entry.arch, operatingSystem: entry.os };
const dependencies = {}, crtSources = [];
if (process.platform === 'win32') {
  // Only the licensed Visual Studio redist directory is eligible. No System32,
  // arbitrary PATH DLL, or debug_nonredist is ever copied into a bundle.
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const installation = run(vswhere, ['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath']).trim();
  if (!installation) throw Error('Official Visual Studio C++ redistributable installation unavailable');
  const redist = join(installation, 'VC/Redist/MSVC');
  let crt, crtVersion;
  for (const version of (await readdir(redist)).filter(v => /^14\.[0-9.]+$/.test(v)).sort(compareVersion).reverse()) {
    const candidate = join(redist,version,'x64/Microsoft.VC143.CRT');
    if (await readdir(candidate).then(() => true).catch(() => false)) { crt = candidate; crtVersion = version; break; }
  }
  if (!crt) throw Error('Official x64 Microsoft.VC143.CRT directory missing');
  const crtFiles = new Map((await readdir(crt)).filter(n => /\.dll$/i.test(n)).map(n => [n.toLowerCase(),n]));
  const system = new Set(['advapi32.dll','avrt.dll','bcrypt.dll','bcryptprimitives.dll','cfgmgr32.dll','combase.dll','crypt32.dll','cryptbase.dll','dbghelp.dll','dwmapi.dll','dxgi.dll','gdi32.dll','imm32.dll','iphlpapi.dll','kernel32.dll','kernelbase.dll','mmdevapi.dll','msvcrt.dll','ncrypt.dll','normaliz.dll','ntasn1.dll','ntdll.dll','ole32.dll','oleaut32.dll','powrprof.dll','propsys.dll','psapi.dll','rpcrt4.dll','secur32.dll','setupapi.dll','shell32.dll','shlwapi.dll','ucrtbase.dll','user32.dll','userenv.dll','version.dll','winhttp.dll','winmm.dll','wintrust.dll','ws2_32.dll']);
  const queue = (await readdir(runtime)).filter(n => /\.(exe|dll)$/i.test(n)), seen = new Set();
  while (queue.length) {
    const file = queue.shift(); if (seen.has(file.toLowerCase())) continue; seen.add(file.toLowerCase());
    dependencies[file] = peImports(await readFile(join(runtime,file)));
    for (const dependency of dependencies[file]) {
      if (/^(api-ms-win-|ext-ms-win-)/.test(dependency) || system.has(dependency)) continue;
      const existing = (await readdir(runtime)).find(n => n.toLowerCase() === dependency);
      if (existing) { queue.push(existing); continue; }
      const official = crtFiles.get(dependency);
      if (!official) throw Error(`Unbundled Windows DLL: ${file} -> ${dependency}`);
      await copyFile(join(crt,official),join(runtime,official));
      crtSources.push({ file: official, version: crtVersion, source: `Visual Studio VC/Redist/MSVC/${crtVersion}/x64/Microsoft.VC143.CRT`, sha256: await sha(join(runtime,official)) });
      queue.push(official);
    }
  }
  await writeFile(join(runtime,'MICROSOFT-CRT-NOTICE.txt'), `Microsoft Visual C++ Runtime files, copyright Microsoft Corporation.\nCopied unmodified from the official Visual Studio ${crtVersion} x64 redistributable directory.\nRedistribution is subject to the Visual Studio license's Distributable Code terms.\nhttps://learn.microsoft.com/visualstudio/releases/2022/redistribution\nhttps://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files\nNo debug_nonredist or arbitrary system DLL is included.\n`);
  compatibility.minimumWindows = 'Windows 10'; compatibility.crt = crtSources;
} else if (process.platform === 'darwin') {
  const floors = [], present = new Set(await readdir(runtime));
  for (const file of present) {
    if (file !== helper && !file.endsWith('.dylib')) continue;
    const info = machoInfo(await readFile(join(runtime,file)));
    dependencies[file] = info.dependencies;
    if (info.minimumOS) floors.push(info.minimumOS);
    for (const dependency of info.dependencies) {
      if (dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/')) continue;
      if (!/^@(rpath|loader_path|executable_path)\//.test(dependency) || !present.has(basename(dependency))) throw Error(`Unbundled Mach-O dependency: ${file} -> ${dependency}`);
    }
    if (file === helper) {
      if (!info.rpaths.includes('@executable_path')) throw Error('Missing bundle-relative Mach-O RPATH');
      if (!info.infoPlist?.includes('<key>NSMicrophoneUsageDescription</key>')) throw Error('Microphone usage description missing from Mach-O __info_plist');
      compatibility.microphoneUsageEmbedded = true;
    }
  }
  if (!floors.length) throw Error('macOS deployment floor could not be verified');
  compatibility.minimumMacOS = floors.sort(compareVersion).at(-1);
} else {
  const abi = new Set();
  for (const file of await readdir(runtime)) {
    if (file !== helper && !file.includes('.so')) continue;
    const path = join(runtime,file), report = run('ldd',[path],{env:cleanEnv}); dependencies[file] = report;
    if (/not found/.test(report)) throw Error(`Unresolved ELF dependency in ${file}`);
    for (const line of report.split('\n')) { const library = line.match(/libonnxruntime[^\s]*\s+=>\s+(\S+)/)?.[1]; if (library && !library.startsWith(runtime+sep)) throw Error('ONNX resolves outside packaged runtime'); }
    for (const match of run('readelf',['--version-info',path]).matchAll(/\b(GLIBC(?:XX)?_[0-9.]+|CXXABI_[0-9.]+)/g)) abi.add(match[1]);
  }
  compatibility.elfVersionRequirements = [...abi].sort();
  compatibility.minimumGlibc = [...abi].filter(v => v.startsWith('GLIBC_')).map(v => v.slice(6)).sort(compareVersion).at(-1) || null;
}
const relocated = await mkdtemp(join(tmpdir(),'aximo-package-check-'));
let version;
try {
  for (const file of await readdir(runtime)) await copyFile(join(runtime,file),join(relocated,file));
  const executable = join(relocated,helper); await chmod(executable,0o755);
  version = JSON.parse(run(executable,['--version'],{env:cleanEnv,cwd:relocated}));
  const doctor = JSON.parse(run(executable,['doctor'],{env:cleanEnv,cwd:relocated}));
  if (version.version !== '0.1.0' || doctor.type !== 'doctor' || doctor.microphoneChecked !== false) throw Error('Relocated doctor/version contract failed');
} finally { await rm(relocated,{recursive:true,force:true}); }
const files = [];
for (const file of (await readdir(runtime)).sort()) files.push({file,sha256:await sha(join(runtime,file))});
const metadata = {version:version.version,platform,commit:process.env.AXIMO_SOURCE_COMMIT||process.env.GITHUB_SHA||null,workflowCommit:process.env.GITHUB_SHA||null,onnxVersion:manifest.version,onnx:JSON.parse(await readFile(join(root,'AXIMO-ONNX-SOURCE.json'),'utf8')),compatibility,files,dependencies,unsigned:true,microphoneTested:false,relocatedWithoutBuildLoaderPaths:true};
await writeFile(join(runtime,'BUILD-METADATA.json'),JSON.stringify(metadata,null,2)+'\n');
const name = `aximo-voice-native-${platform}${process.platform==='win32'?'.zip':'.tar.gz'}`, archive = resolve('dist',name);
if (process.platform==='win32') {
  const q = value => `'${value.replaceAll("'","''")}'`;
  const paths = (await readdir(runtime)).map(f => q(join(runtime,f))).join(',');
  run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Compress-Archive -LiteralPath @(${paths}) -DestinationPath ${q(archive)} -Force -CompressionLevel Optimal`]);
} else run('tar',['-czf',archive,'-C',runtime,...(await readdir(runtime)).sort()]);
const digest = await sha(archive);
await writeFile(`dist/${name}.sha256`,`${digest}  ${name}\n`);
await writeFile(`dist/${name}.build.json`,JSON.stringify({...metadata,archiveSha256:digest},null,2)+'\n');
console.log(`${name}: complete runtime bundle relocated successfully; SHA-256 ${digest}`);
function compareVersion(a,b) { const aa=a.split('.').map(Number),bb=b.split('.').map(Number); for(let i=0;i<Math.max(aa.length,bb.length);i++) if((aa[i]||0)!==(bb[i]||0)) return (aa[i]||0)-(bb[i]||0); return 0; }
