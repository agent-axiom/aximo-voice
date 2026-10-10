// Release only the exact CI-verified 0.1.0 source and complete Mac kits.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { generateFormula } from '../packaging/homebrew/generate-formula.mjs';

const commit = 'efa540e266a92ba092ebf2f6932f9db94c9454fc';
const version = '0.1.0';
const root = process.argv[2] || 'release-input';
const output = process.argv[3] || 'release-output';
const sourceURL = `https://github.com/agent-axiom/aximo-voice/archive/${commit}.tar.gz`;
const variants = [];
for (const platform of ['macos-aarch64', 'macos-x86_64']) {
  const archive = `aximo-voice-kit-${version}-${platform}.tar.gz`;
  const kitArchive = join(root, `aximo-voice-${platform}`, 'dist', archive);
  const metadata = JSON.parse(await readFile(`${kitArchive}.build.json`, 'utf8'));
  if (metadata.source?.commit !== commit || metadata.source?.dirty !== false || metadata.platform !== platform || metadata.version !== version) throw Error('Unexpected release provenance');
  const sha256 = createHash('sha256').update(await readFile(kitArchive)).digest('hex');
  if (metadata.archiveSha256 !== sha256) throw Error('Release archive checksum mismatch');
  const kitURL = `https://github.com/agent-axiom/aximo-voice/releases/download/v${version}/${archive}`;
  const formula = await generateFormula({ sourceArchive: join(root, 'source.tar.gz'), sourceURL, kitArchive, kitURL });
  variants.push({ platform, archive, sha256, kitURL, minimumOS: metadata.compatibility.minimumMacOS, formula });
}
const [arm, intel] = variants;
let formula = arm.formula;
function replaceOnce(from, to) {
  if (formula.split(from).length !== 2) throw Error(`Formula template changed: ${from}`);
  formula = formula.replace(from, to);
}
replaceOnce('# GENERATED PREVIEW: unsigned CI artifacts are not a public release.', '# Aximo Voice 0.1.0 preview: unsigned, checksum-verified native kits.');
replaceOnce(`# Target: ${arm.platform}. Generate another reviewed recipe/bottle for another target.`, '# Native kits for Apple Silicon and Intel Macs.');
replaceOnce('  depends_on arch: :arm64\n', '');
replaceOnce(`  resource "runtime-kit" do\n    url '${arm.kitURL}'\n    sha256 "${arm.sha256}"\n  end`, `  on_arm do\n    resource "runtime-kit" do\n      url '${arm.kitURL}'\n      sha256 "${arm.sha256}"\n    end\n  end\n\n  on_intel do\n    resource "runtime-kit" do\n      url '${intel.kitURL}'\n      sha256 "${intel.sha256}"\n    end\n  end`);
replaceOnce(`    odie "macOS ${arm.minimumOS} or newer is required" if MacOS.version < "${arm.minimumOS}"`, `    minimum_os = Hardware::CPU.arm? ? "${arm.minimumOS}" : "${intel.minimumOS}"\n    target = Hardware::CPU.arm? ? "${arm.platform}" : "${intel.platform}"\n    odie "macOS #{minimum_os} or newer is required" if MacOS.version < minimum_os`);
replaceOnce(`metadata.fetch("platform") == "${arm.platform}"`, 'metadata.fetch("platform") == target');
replaceOnce('This is a maintainer preview, not an accepted public release.', 'This is an unsigned preview. Real microphone acceptance is still pending.');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'aximo-voice.rb'), formula);
await writeFile(join(output, 'release-manifest.json'), JSON.stringify({ version, sourceCommit: commit, sourceURL, variants: variants.map(({ formula, ...variant }) => variant) }, null, 2) + '\n');
console.log('Prepared both checksum-pinned architecture variants.');
