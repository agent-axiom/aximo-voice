// Developer/CI tooling. The resulting kit needs neither Node nor Rust to run.
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machoInfo } from './macho-info.mjs';

export const METADATA_PATH = 'share/aximo-voice/KIT-METADATA.json';
export const PLUGIN_PATH = 'share/aximo-voice/plugin';
const PLUGIN_INPUTS = ['.claude-plugin', 'hooks', 'docs', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SECURITY.md',
  'native/models.json', 'scripts/install-runtime.sh', 'scripts/install-runtime.ps1', 'scripts/runtime-manifest.txt', 'scripts/onnx-runtime-manifest.json'];
const REQUIRED_RUNTIME = ['aximo-voice-native', 'BUILD-METADATA.json', 'AXIMO-LICENSE.txt', 'ONNX-LICENSE.txt',
  'ONNX-THIRD-PARTY-NOTICES.txt', 'ONNX-PRIVACY.md', 'ONNX-SOURCE.json'];
const PLATFORMS = { 'macos-aarch64': ['darwin', 'arm64'], 'macos-x86_64': ['darwin', 'x64'], 'linux-x86_64': ['linux', 'x64'] };
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });

export function safeRelative(file) {
  if (typeof file !== 'string' || file.split('/').some(p => !/^[A-Za-z0-9._-]+$/.test(p) || p === '.' || p === '..')) {
    throw Error(`Unsafe kit path: ${file}`);
  }
  return file;
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

export async function regularFiles(root, relative = '') {
  const path = relative ? join(root, safeRelative(relative)) : root;
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
    throw Error(`Kit input must be a regular file or directory, never a link: ${path}`);
  }
  if (stat.isFile()) return [relative];
  const result = [];
  for (const name of (await readdir(path)).sort()) result.push(...await regularFiles(root, relative ? `${relative}/${name}` : name));
  return result;
}

// Cargo hard-links release binaries to target/release/deps. Accept that build
// input only; copyFile below gives the shipped kit its own single-link inode.
async function verifyCliInput(cli) {
  const stat = await lstat(cli);
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error(`Management CLI must be a regular file, never a link: ${cli}`);
}

async function copyInput(source, target, input) {
  for (const file of await regularFiles(source, input)) {
    const from = join(source, file), to = join(target, file);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    await chmod(to, (await lstat(from)).mode & 0o111 ? 0o755 : 0o644);
  }
}

export async function verifyRuntime(runtime, platform, version) {
  if (!PLATFORMS[platform]) throw Error('Unsupported full-kit platform');
  const present = await regularFiles(runtime);
  if (present.some(p => p.includes('/'))) throw Error('Runtime bundle must be flat');
  for (const file of REQUIRED_RUNTIME) if (!present.includes(file)) throw Error(`Missing runtime dependency or notice: ${file}`);
  const onnx = platform.startsWith('macos-') ? 'libonnxruntime.dylib' : 'libonnxruntime.so.1';
  if (!present.includes(onnx)) throw Error(`Missing runtime dependency: ${onnx}`);
  const metadata = JSON.parse(await readFile(join(runtime, 'BUILD-METADATA.json'), 'utf8'));
  if (metadata.version !== version || metadata.platform !== platform || metadata.relocatedWithoutBuildLoaderPaths !== true) {
    throw Error('Runtime version/platform/relocation metadata mismatch');
  }
  const tracked = new Set();
  if (!Array.isArray(metadata.files)) throw Error('Runtime file checksums are missing');
  for (const entry of metadata.files) {
    safeRelative(entry.file);
    if (entry.file.includes('/') || entry.file === 'BUILD-METADATA.json' || tracked.has(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw Error('Invalid runtime file checksum manifest');
    }
    tracked.add(entry.file);
    if (!present.includes(entry.file) || await sha256(join(runtime, entry.file)) !== entry.sha256) throw Error(`Runtime checksum mismatch: ${entry.file}`);
  }
  if (present.some(file => file !== 'BUILD-METADATA.json' && !tracked.has(file))) throw Error('Unmanifested runtime file');
  if (!metadata.dependencies || !Object.hasOwn(metadata.dependencies, 'aximo-voice-native')) throw Error('Runtime dependency report missing');
  if (platform.startsWith('macos-')) {
    for (const file of present.filter(file => file === 'aximo-voice-native' || file.endsWith('.dylib'))) {
      const info = machoInfo(await readFile(join(runtime, file)));
      for (const dependency of info.dependencies) {
        if (dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/')) continue;
        // Dependencies must resolve next to the helper, not arbitrary nested paths.
        if (!/^@(rpath|loader_path|executable_path)\/[^/]+$/.test(dependency) || !present.includes(basename(dependency))) {
          throw Error(`Missing or external Mach-O dependency: ${file} -> ${dependency}`);
        }
      }
    }
  } else {
    for (const [file, report] of Object.entries(metadata.dependencies)) {
      if (!present.includes(file) || typeof report !== 'string' || /not found/.test(report)) throw Error('Invalid ELF dependency report');
      for (const match of report.matchAll(/\b(libonnxruntime[^\s]*)\s+=>/g)) {
        if (!present.includes(match[1])) throw Error(`Missing ELF dependency: ${match[1]}`);
      }
    }
  }
  return metadata;
}

export async function verifyKit(root) {
  const present = await regularFiles(root);
  const metadata = JSON.parse(await readFile(join(root, METADATA_PATH), 'utf8'));
  if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.files)) throw Error('Unsupported kit manifest');
  const seen = new Set([METADATA_PATH]);
  for (const entry of metadata.files) {
    safeRelative(entry.file);
    if (seen.has(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw Error('Invalid kit file manifest');
    seen.add(entry.file);
    const file = join(root, entry.file);
    if (!present.includes(entry.file) || (await lstat(file)).size !== entry.size || await sha256(file) !== entry.sha256) {
      throw Error(`Kit checksum mismatch: ${entry.file}`);
    }
  }
  if (present.length !== seen.size || present.some(file => !seen.has(file))) throw Error('Unmanifested kit file');
  for (const required of ['bin/aximo-voice', `${PLUGIN_PATH}/.claude-plugin/plugin.json`, `${PLUGIN_PATH}/.claude-plugin/marketplace.json`, `${PLUGIN_PATH}/hooks/register.js`, `${PLUGIN_PATH}/bin/BUILD-METADATA.json`]) {
    if (!seen.has(required)) throw Error(`Missing kit component: ${required}`);
  }
  const plugin = JSON.parse(await readFile(join(root, PLUGIN_PATH, '.claude-plugin/plugin.json'), 'utf8'));
  if ([metadata.pluginVersion, metadata.runtimeVersion, metadata.cliVersion, plugin.version].some(version => version !== metadata.version)) throw Error('Kit component versions differ');
  await verifyRuntime(join(root, PLUGIN_PATH, 'bin'), metadata.platform, metadata.version);
  return metadata;
}

// Version values come from executing the relocated binaries in main(), not a CLI flag.
export async function createKit({ source, runtime, cli, output, platform, cliVersion, runtimeVersion, provenance }) {
  const plugin = JSON.parse(await readFile(join(source, '.claude-plugin/plugin.json'), 'utf8'));
  const cargo = await readFile(join(source, 'native/Cargo.toml'), 'utf8');
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const version = plugin.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || [cargoVersion, cliVersion, runtimeVersion].some(v => v !== version)) {
    throw Error('Plugin, Cargo, management CLI and runtime versions must agree');
  }
  if (!provenance || !/^[a-f0-9]{40}$/.test(provenance.commit) || typeof provenance.dirty !== 'boolean') throw Error('Exact source commit metadata is required');
  const runtimeMetadata = await verifyRuntime(runtime, platform, version);
  if (runtimeMetadata.commit !== provenance.commit) throw Error('Runtime source commit differs from kit source commit');
  const compatibility = { ...runtimeMetadata.compatibility };
  if (platform.startsWith('macos-')) {
    const info = machoInfo(await readFile(cli));
    if (!info.minimumOS) throw Error('Management CLI deployment floor could not be verified');
    if (info.dependencies.some(dependency => !dependency.startsWith('/System/Library/') && !dependency.startsWith('/usr/lib/'))) throw Error('Management CLI needs an unbundled non-system library');
    compatibility.managementMinimumMacOS = info.minimumOS;
    compatibility.minimumMacOS = [compatibility.minimumMacOS, info.minimumOS].sort((a, b) => {
      const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) - (bb[i] || 0);
      return 0;
    }).at(-1);
  }
  const marketplace = JSON.parse(await readFile(join(source, '.claude-plugin/marketplace.json'), 'utf8'));
  if (marketplace.name !== 'aximo' || marketplace.plugins?.length !== 1 || marketplace.plugins[0].name !== 'aximo-voice' || marketplace.plugins[0].source !== './') {
    throw Error('Expected single-plugin local aximo marketplace rooted at ./');
  }
  // Fully validate and copy into a new directory. A failed build never destroys an older kit.
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.kit-'));
  try {
    const pluginRoot = join(staging, PLUGIN_PATH);
    for (const input of PLUGIN_INPUTS) await copyInput(source, pluginRoot, input);
    for (const input of await regularFiles(runtime)) await copyInput(runtime, join(pluginRoot, 'bin'), input);
    await verifyCliInput(cli);
    await mkdir(join(staging, 'bin'), { recursive: true });
    await copyFile(cli, join(staging, 'bin/aximo-voice'));
    await chmod(join(staging, 'bin/aximo-voice'), 0o755);
    await chmod(join(pluginRoot, 'bin/aximo-voice-native'), 0o755);
    const files = [];
    for (const file of await regularFiles(staging)) files.push({ file, sha256: await sha256(join(staging, file)), size: (await lstat(join(staging, file))).size });
    const metadata = { schemaVersion: 1, version, platform, pluginVersion: version, runtimeVersion, cliVersion,
      source: provenance, compatibility, files,
      unsigned: true, microphoneTested: false, preview: true };
    await writeFile(join(staging, METADATA_PATH), JSON.stringify(metadata, null, 2) + '\n');
    await verifyKit(staging);
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    return metadata;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function cleanLoaderEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ORT_|AXIMO_ONNX_|LD_LIBRARY_PATH$|LD_PRELOAD$|DYLD_)/i.test(key)) delete env[key];
  return env;
}

async function main() {
  const platform = process.argv[2];
  if (!PLATFORMS[platform] || PLATFORMS[platform][0] !== process.platform || PLATFORMS[platform][1] !== process.arch) throw Error('Kit platform must match the current Unix runner');
  const source = resolve('.'), runtime = resolve('dist/runtime'), cli = resolve('native/target/release/aximo-voice'), output = resolve('dist/kit');
  const env = cleanLoaderEnvironment();
  await verifyCliInput(cli);
  await regularFiles(runtime);
  const cliVersion = JSON.parse(run(cli, ['--version'], { env })).version;
  const runtimeVersion = JSON.parse(run(join(runtime, 'aximo-voice-native'), ['--version'], { env })).version;
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  if (process.env.AXIMO_SOURCE_COMMIT && process.env.AXIMO_SOURCE_COMMIT !== commit) throw Error('AXIMO_SOURCE_COMMIT does not match checkout');
  if (platform.startsWith('macos-')) {
    const info = machoInfo(await readFile(cli));
    if (info.dependencies.some(dependency => !dependency.startsWith('/System/Library/') && !dependency.startsWith('/usr/lib/'))) throw Error('Management CLI needs an unbundled non-system library');
  } else {
    const report = run('ldd', [cli], { env });
    if (/not found|libonnxruntime/.test(report)) throw Error('Management CLI must not depend on an external ONNX runtime');
  }
  const metadata = await createKit({ source, runtime, cli, output, platform, cliVersion, runtimeVersion,
    provenance: { commit, workflowCommit: process.env.GITHUB_SHA || null, dirty: run('git', ['status', '--porcelain']).trim().length > 0 } });
  if (JSON.parse(run(join(output, 'bin/aximo-voice'), ['--version'], { env, cwd: output })).version !== metadata.version) throw Error('Relocated management CLI version mismatch');
  run(join(output, 'bin/aximo-voice'), ['doctor', '--package-only'], { env, cwd: output });
  const name = `aximo-voice-kit-${metadata.version}-${platform}.tar.gz`;
  const archive = resolve('dist', name);
  // Explicit file list, no links or leading archive directory. Homebrew preserves bin/share.
  run('tar', ['-czf', archive, '-C', output, 'bin', 'share']);
  const digest = await sha256(archive);
  await writeFile(`${archive}.sha256`, `${digest}  ${name}\n`);
  await writeFile(`${archive}.build.json`, JSON.stringify({ ...metadata, archive: name, archiveSha256: digest }, null, 2) + '\n');
  console.log(`${name}: full preview kit; SHA-256 ${digest}. Unsigned; real microphone acceptance required.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
