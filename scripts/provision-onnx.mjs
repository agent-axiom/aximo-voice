// Developer/CI tooling only. End users receive the reviewed runtime bundle.
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const manifest = JSON.parse(await readFile(new URL('./onnx-runtime-manifest.json', import.meta.url), 'utf8'));
const platform = process.argv[2];
const entry = manifest.platforms[platform];
if (!entry || entry.os !== process.platform || entry.arch !== process.arch) throw Error('ONNX platform must match the CI host');
const base = resolve('native/target/onnx', platform);
const root = join(base, 'runtime');
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: 'inherit', ...options });
async function sha(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
await mkdir(base, { recursive: true });
if (entry.mode === 'archive') {
  if (!/^https:\/\/github\.com\/microsoft\/onnxruntime\/releases\/download\/v1\.24\.2\//.test(entry.url) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid pinned ONNX source');
  const archive = join(base, entry.url.endsWith('.zip') ? 'upstream.zip' : 'upstream.tgz');
  if (await sha(archive).catch(() => '') !== entry.sha256) {
    const temporary = `${archive}.partial`;
    run('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--connect-timeout', '20', '--max-time', '600', entry.url, '--output', temporary]);
    if (await sha(temporary) !== entry.sha256) throw Error('ONNX archive SHA-256 mismatch');
    await copyFile(temporary, archive);
    await rm(temporary);
  }
  await rm(root, { recursive: true, force: true });
  await mkdir(root);
  // The archive is authenticated before extraction. lib symlinks are resolved
  // to regular files later, so the shipped bundle needs no symlink handling.
  run('tar', ['-xf', archive, '--strip-components=1', '-C', root]);
} else {
  if (platform !== 'macos-x86_64' || entry.commit !== manifest.commit) throw Error('Unexpected source-build target');
  const source = join(base, 'source');
  const build = join(base, 'compile');
  await mkdir(source, { recursive: true });
  run('git', ['init', source]);
  run('git', ['-C', source, 'fetch', '--depth=1', entry.repository, entry.commit]);
  run('git', ['-C', source, 'checkout', '--detach', '--force', entry.commit]);
  const actual = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actual !== entry.commit) throw Error('ONNX source commit mismatch');
  const notices = [['LICENSE', 'LICENSE'], ['ThirdPartyNotices.txt', 'ThirdPartyNotices.txt'], ['docs/Privacy.md', 'Privacy.md'], ['VERSION_NUMBER', 'VERSION_NUMBER']];
  // Validate the pinned source layout before spending time compiling it.
  for (const [from] of notices) await readFile(join(source, from));
  if ((await readFile(join(source, 'VERSION_NUMBER'), 'utf8')).trim() !== manifest.version) throw Error('ONNX source version mismatch');
  run('git', ['-C', source, 'submodule', 'update', '--init', '--recursive', '--depth=1']);
  run('python3', [join(source, 'tools/ci_build/build.py'), '--build_dir', build, '--config', 'Release', '--update', '--build', '--parallel', '3', '--build_shared_lib', '--skip_tests', '--skip_submodule_sync', '--compile_no_warning_as_error', '--osx_arch', 'x86_64', '--cmake_extra_defines', `CMAKE_OSX_DEPLOYMENT_TARGET=${entry.minimumMacOS}`, 'CMAKE_INSTALL_NAME_DIR=@rpath', 'onnxruntime_BUILD_UNIT_TESTS=OFF'], { cwd: source, env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: entry.minimumMacOS } });
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'lib'), { recursive: true });
  for (const name of await readdir(join(build, 'Release'))) {
    if (/^libonnxruntime(?:\.[0-9.]+)?\.dylib$/.test(name)) await copyFile(join(build, 'Release', name), join(root, 'lib', name));
  }
  for (const [from, to] of notices) await copyFile(join(source, from), join(root, to));
}
const libraries = await readdir(join(root, 'lib'));
const expected = process.platform === 'win32' ? 'onnxruntime.dll' : process.platform === 'darwin' ? 'libonnxruntime.dylib' : 'libonnxruntime.so.1';
if (!libraries.includes(expected)) throw Error(`Official ONNX runtime is missing ${expected}`);
await writeFile(join(root, 'AXIMO-ONNX-SOURCE.json'), JSON.stringify({ version: manifest.version, release: manifest.release, ...entry }, null, 2) + '\n');

const variables = { ORT_LIB_LOCATION: join(root, 'lib'), ORT_PREFER_DYNAMIC_LINK: '1', AXIMO_ONNX_ROOT: root };
if (process.platform === 'linux') {
  variables.LD_LIBRARY_PATH = join(root, 'lib');
  variables.RUSTFLAGS = `${process.env.RUSTFLAGS || ''} -C link-arg=-Wl,-rpath,$ORIGIN`.trim();
} else if (process.platform === 'darwin') {
  variables.DYLD_LIBRARY_PATH = join(root, 'lib');
  variables.RUSTFLAGS = `${process.env.RUSTFLAGS || ''} -C link-arg=-Wl,-rpath,@executable_path`.trim();
  variables.MACOSX_DEPLOYMENT_TARGET = entry.minimumMacOS || '13.4';
}
if (process.env.GITHUB_ENV) {
  for (const [key, value] of Object.entries(variables)) {
    if (/[\r\n]/.test(value)) throw Error('Unsafe CI environment value');
    await appendFile(process.env.GITHUB_ENV, `${key}=${value}\n`);
  }
  if (process.platform === 'win32') await appendFile(process.env.GITHUB_PATH, `${join(root, 'lib')}\n`);
}
console.log(JSON.stringify(variables, null, 2));
