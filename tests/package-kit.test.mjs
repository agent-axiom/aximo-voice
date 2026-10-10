import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createKit, METADATA_PATH, PLUGIN_PATH, regularFiles, safeRelative, sha256, verifyKit, verifyRuntime } from '../scripts/package-kit.mjs';
import { generateFormula } from '../packaging/homebrew/generate-formula.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aximo-kit-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = join(root, 'source'), runtime = join(root, 'runtime'), cli = join(root, 'aximo-voice'), output = join(root, 'output');
  await mkdir(source); await mkdir(runtime);
  for (const input of ['.claude-plugin', 'hooks', 'docs', 'scripts', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SECURITY.md', 'native/Cargo.toml', 'native/models.json']) {
    await mkdir(join(source, input, '..'), { recursive: true });
    await cp(resolve(input), join(source, input), { recursive: true });
  }
  for (const file of ['aximo-voice-native', 'libonnxruntime.so.1', 'AXIMO-LICENSE.txt', 'ONNX-LICENSE.txt', 'ONNX-THIRD-PARTY-NOTICES.txt', 'ONNX-PRIVACY.md', 'ONNX-SOURCE.json']) {
    await writeFile(join(runtime, file), file === 'ONNX-SOURCE.json' ? '{"version":"1.24.2"}' : `fixture ${file}\n`);
  }
  const metadata = { version: '0.1.0', platform: 'linux-x86_64', commit: COMMIT, relocatedWithoutBuildLoaderPaths: true,
    dependencies: { 'aximo-voice-native': 'libonnxruntime.so.1 => /runtime/libonnxruntime.so.1' }, compatibility: { operatingSystem: 'linux', architecture: 'x64' }, files: [] };
  for (const file of await regularFiles(runtime)) metadata.files.push({ file, sha256: await sha256(join(runtime, file)) });
  await writeFile(join(runtime, 'BUILD-METADATA.json'), JSON.stringify(metadata));
  await writeFile(cli, 'management CLI fixture');
  return { root, source, runtime, cli, output, platform: 'linux-x86_64', cliVersion: '0.1.0', runtimeVersion: '0.1.0', provenance: { commit: COMMIT, workflowCommit: null, dirty: false } };
}
async function editJSON(path, fn) {
  const value = JSON.parse(await readFile(path, 'utf8')); fn(value); await writeFile(path, JSON.stringify(value));
}

test('full kit includes matching plugin, management CLI, complete runtime and exact checksums', async t => {
  const input = await fixture(t), metadata = await createKit(input);
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.source.commit, COMMIT);
  assert.equal(metadata.unsigned, true);
  assert.equal(metadata.microphoneTested, false);
  assert.equal(metadata.version, '0.1.0');
  assert.equal(metadata.files.length + 1, (await regularFiles(input.output)).length);
  for (const file of ['bin/aximo-voice', `${PLUGIN_PATH}/hooks/register.js`, `${PLUGIN_PATH}/bin/libonnxruntime.so.1`, `${PLUGIN_PATH}/bin/ONNX-LICENSE.txt`]) assert(metadata.files.some(entry => entry.file === file));
  assert.equal((await lstat(join(input.output, 'bin/aximo-voice'))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(input.output, PLUGIN_PATH, 'bin/aximo-voice-native'))).mode & 0o777, 0o755);
  assert(!metadata.files.some(entry => entry.file.includes('package-kit.mjs') || entry.file.includes('Cargo.toml')));
  assert.deepEqual(await verifyKit(input.output), metadata);
});

test('Cargo hard-linked CLI is copied into a standalone verified kit file', async t => {
  const input = await fixture(t);
  await link(input.cli, join(input.root, 'cargo-deps-binary'));
  assert.equal((await lstat(input.cli)).nlink, 2);
  await createKit(input);
  const shipped = join(input.output, 'bin/aximo-voice');
  assert.equal((await lstat(shipped)).nlink, 1);
  await writeFile(input.cli, 'rebuilt Cargo output');
  assert.equal(await readFile(shipped, 'utf8'), 'management CLI fixture');
  await verifyKit(input.output);
});

for (const [name, mutate, error] of [
  ['CLI version mismatch', async f => { f.cliVersion = '0.2.0'; }, /versions must agree/],
  ['runtime version mismatch', async f => { f.runtimeVersion = '0.2.0'; }, /versions must agree/],
  ['missing ONNX dependency', async f => { await rm(join(f.runtime, 'libonnxruntime.so.1')); }, /Missing runtime dependency/],
  ['missing license', async f => { await rm(join(f.runtime, 'ONNX-LICENSE.txt')); }, /Missing runtime dependency or notice/],
  ['tampered runtime', async f => { await writeFile(join(f.runtime, 'aximo-voice-native'), 'tampered'); }, /checksum mismatch/],
  ['unmanifested runtime dependency', async f => { await writeFile(join(f.runtime, 'hidden.so'), 'untracked'); }, /Unmanifested runtime file/],
  ['runtime source mismatch', async f => { f.provenance.commit = 'a'.repeat(40); }, /source commit differs/],
  ['runtime with unresolved dependency', async f => { await editJSON(join(f.runtime, 'BUILD-METADATA.json'), m => { m.dependencies['aximo-voice-native'] = 'libevil.so => not found'; }); }, /ELF dependency report/],
  ['runtime manifest traversal', async f => { await editJSON(join(f.runtime, 'BUILD-METADATA.json'), m => { m.files[0].file = '../escape'; }); }, /Unsafe kit path/],
  ['runtime manifest duplicate', async f => { await editJSON(join(f.runtime, 'BUILD-METADATA.json'), m => { m.files.push(m.files[0]); }); }, /checksum manifest/],
  ['remote marketplace source', async f => { await editJSON(join(f.source, '.claude-plugin/marketplace.json'), m => { m.plugins[0].source = { source: 'github', repo: 'other/plugin' }; }); }, /single-plugin local/],
  ['symlink in plugin', async f => { await symlink('../README.md', join(f.source, 'hooks/escape')); }, /never a link/],
  ['symlink directory in plugin', async f => { await symlink('../scripts', join(f.source, 'hooks/outside'), 'dir'); }, /never a link/],
  ['hardlink in runtime', async f => { await link(join(f.runtime, 'ONNX-LICENSE.txt'), join(f.runtime, 'extra')); }, /never a link/],
  ['symlink management executable', async f => { await symlink(f.cli, join(f.root, 'linked-cli')); f.cli = join(f.root, 'linked-cli'); }, /never a link/],
]) test(`packager refuses ${name} without replacing the previous kit`, async t => {
  const input = await fixture(t);
  await mkdir(input.output); await writeFile(join(input.output, 'previous'), 'working kit');
  await mutate(input);
  await assert.rejects(createKit(input), error);
  assert.equal(await readFile(join(input.output, 'previous'), 'utf8'), 'working kit');
});

test('kit verification rejects modified, added and untracked linked files', async t => {
  const input = await fixture(t); await createKit(input);
  const extra = join(input.output, 'extra'); await writeFile(extra, 'untracked');
  await assert.rejects(verifyKit(input.output), /Unmanifested kit file/); await rm(extra);
  await symlink('bin/aximo-voice', extra); await assert.rejects(verifyKit(input.output), /never a link/); await rm(extra);
  await writeFile(join(input.output, PLUGIN_PATH, 'hooks/register.js'), 'tampered');
  await assert.rejects(verifyKit(input.output), /checksum mismatch/);
});

test('kit verification rejects metadata path traversal and self-reference', async t => {
  const input = await fixture(t); await createKit(input);
  const path = join(input.output, METADATA_PATH), original = await readFile(path);
  await editJSON(path, m => { m.files[0].file = '/tmp/escape'; });
  await assert.rejects(verifyKit(input.output), /Unsafe kit path/);
  await writeFile(path, original); await editJSON(path, m => { m.files[0].file = METADATA_PATH; });
  await assert.rejects(verifyKit(input.output), /Invalid kit file manifest/);
});

test('path validator rejects traversal, Windows paths and control characters', () => {
  for (const bad of ['', '/etc/passwd', '../escape', 'dir/../escape', 'a//b', 'C:\\escape', 'foo\nbar', './bin', 'a/']) assert.throws(() => safeRelative(bad));
  assert.equal(safeRelative('.claude-plugin/plugin.json'), '.claude-plugin/plugin.json');
});

// This small Mach-O fixture encodes a real LC_LOAD_DYLIB; test dependency checks
// against binary bytes rather than trusting the accompanying metadata report.
function macho(dependency) {
  const bytes = Buffer.alloc(256); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(0xc, 32); bytes.writeUInt32LE(224, 36); bytes.writeUInt32LE(24, 40); bytes.write(`${dependency}\0`, 56); return bytes;
}
test('macOS kit rejects omitted Mach-O dependency even when metadata claims it is complete', async t => {
  const input = await fixture(t);
  await rm(join(input.runtime, 'libonnxruntime.so.1'));
  await writeFile(join(input.runtime, 'libonnxruntime.dylib'), macho('/usr/lib/libSystem.B.dylib'));
  await writeFile(join(input.runtime, 'aximo-voice-native'), macho('@rpath/libmissing.dylib'));
  await editJSON(join(input.runtime, 'BUILD-METADATA.json'), m => { m.platform = 'macos-aarch64'; m.files = []; });
  const files = [];
  for (const file of await regularFiles(input.runtime)) if (file !== 'BUILD-METADATA.json') files.push({ file, sha256: await sha256(join(input.runtime, file)) });
  await editJSON(join(input.runtime, 'BUILD-METADATA.json'), m => { m.files = files; });
  await assert.rejects(verifyRuntime(input.runtime, 'macos-aarch64', '0.1.0'), /Missing or external Mach-O dependency/);
});

async function formulaFixture(t) {
  const input = await fixture(t), sourceArchive = join(input.root, 'source.tar.gz'), kitArchive = join(input.root, 'aximo-voice-kit-0.1.0-macos-aarch64.tar.gz');
  await writeFile(sourceArchive, 'real source bytes'); await writeFile(kitArchive, 'real kit bytes');
  const metadata = { schemaVersion: 1, version: '0.1.0', pluginVersion: '0.1.0', runtimeVersion: '0.1.0', cliVersion: '0.1.0',
    source: input.provenance, platform: 'macos-aarch64', compatibility: { minimumMacOS: '14.0.0' }, archive: 'aximo-voice-kit-0.1.0-macos-aarch64.tar.gz', archiveSha256: await sha256(kitArchive) };
  await writeFile(`${kitArchive}.build.json`, JSON.stringify(metadata));
  return { sourceArchive, sourceURL: `https://github.com/agent-axiom/aximo-voice/archive/${COMMIT}.tar.gz`, kitArchive,
    kitURL: 'https://github.com/agent-axiom/aximo-voice/releases/download/preview/aximo-voice-kit-0.1.0-macos-aarch64.tar.gz' };
}
test('Homebrew generator uses actual hashes and a pinned complete kit with explicit setup', async t => {
  const input = await formulaFixture(t), formula = await generateFormula(input);
  assert(formula.includes(await sha256(input.sourceArchive))); assert(formula.includes(await sha256(input.kitArchive)));
  assert.match(formula, /resource "runtime-kit"/); assert.match(formula, /preserve_rpath/); assert.match(formula, /skip_clean "libexec"/);
  assert.match(formula, /bin.install_symlink libexec/); assert.match(formula, /doctor", "--package-only/);
  assert(!/def post_install|depends_on "(?:node|rust|python|ffmpeg)"/.test(formula));
});
for (const [name, mutate, error] of [
  ['a placeholder or altered kit hash', async f => { await writeFile(f.kitArchive, 'different'); }, /does not match/],
  ['dirty source', async f => { await editJSON(`${f.kitArchive}.build.json`, m => { m.source.dirty = true; }); }, /clean, exact source/],
  ['HTTP resources', async f => { f.kitURL = f.kitURL.replace('https:', 'http:'); }, /HTTPS/],
  ['unversioned source', async f => { f.sourceURL = 'https://github.com/agent-axiom/aximo-voice/archive/main.tar.gz'; }, /pinned to the exact/],
  ['unsupported platforms', async f => { await editJSON(`${f.kitArchive}.build.json`, m => { m.platform = 'windows-x86_64'; }); }, /macOS architecture/],
]) test(`formula generator rejects ${name}`, async t => { const f = await formulaFixture(t); await mutate(f); await assert.rejects(generateFormula(f), error); });
