// Real Claude CLI smoke, using a fresh isolated user profile. No login or model download.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanLoaderEnvironment, verifyKit } from './package-kit.mjs';

if (process.platform === 'win32') throw Error('Full-kit manager smoke is Unix-only');
const manager = resolve(process.argv[2] || 'dist/kit/bin/aximo-voice');
if (!process.argv[3]) throw Error('Pass an absolute path to the pinned Claude executable');
const claude = resolve(process.argv[3]);
const profile = await mkdtemp(join(tmpdir(), 'aximo-real-marketplace-'));
const home = join(profile, 'home'), data = join(profile, 'data');
await mkdir(home); await mkdir(data);
const env = { ...cleanLoaderEnvironment(), HOME: home, XDG_DATA_HOME: data, CLAUDE_CONFIG_DIR: join(profile, 'claude'),
  PATH: `${dirname(claude)}${delimiter}${process.env.PATH || ''}` };
for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_API_KEY$)/.test(key)) delete env[key];
const run = (file, args) => execFileSync(file, args, { env, cwd: profile, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
const management = args => { const result = run(manager, args); process.stdout.write(result); return result; };
try {
  console.log(`Isolated real marketplace host: ${run(claude, ['--version']).trim()}`);
  const kit = await verifyKit(resolve(dirname(manager), '..'));
  management(['doctor', '--package-only']);
  management(['setup']);
  management(['setup']);
  management(['doctor']);
  const installedRoot = process.platform === 'darwin' ? join(home, 'Library/Application Support/aximo-voice/installed') : join(data, 'aximo-voice/installed');
  const installed = await verifyKit(installedRoot);
  assert.equal(installed.version, kit.version);
  const list = JSON.parse(run(claude, ['plugin', 'list', '--json']));
  const entries = list.filter(plugin => plugin.id === 'aximo-voice@aximo');
  assert.equal(entries.length, 1, 'Repeated setup must not duplicate registration');
  assert.equal(entries[0].scope, 'user');
  assert.equal(entries[0].enabled, true);
  assert.equal(entries[0].readFromFolder || entries[0].installPath, join(installedRoot, 'share/aximo-voice/plugin'));
  const input = JSON.parse(await readFile(join(installedRoot, 'share/aximo-voice/plugin/.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(input.version, kit.version);
  await access(join(dirname(installedRoot), 'models')).then(() => { throw Error('Management smoke unexpectedly created model storage'); }, () => {});
  management(['uninstall']);
  management(['uninstall']);
  assert(!JSON.parse(run(claude, ['plugin', 'list', '--json'])).some(plugin => plugin.id === 'aximo-voice@aximo'));
  assert(!JSON.parse(run(claude, ['plugin', 'marketplace', 'list', '--json'])).some(market => market.name === 'aximo'));
  console.log('Real local-marketplace registration, repeated setup, package verification and uninstall passed. No microphone or speech model tested.');
} finally {
  await rm(profile, { recursive: true, force: true });
}
