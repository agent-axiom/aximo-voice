// Generates a review-only custom-tap recipe from real, local, final archive bytes.
// It neither publishes a tap nor downloads, builds, signs, or releases anything.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../scripts/package-kit.mjs';

function httpsURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || /[\r\n]/.test(value)) throw Error('Artifact URL must use HTTPS without credentials or fragments');
  return url.href;
}
// Single-quoted Ruby literals avoid interpolation of externally supplied URLs.
const ruby = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

export async function generateFormula({ sourceArchive, sourceURL, kitArchive, kitURL, metadataPath = `${kitArchive}.build.json` }) {
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const sourceHash = await sha256(sourceArchive), kitHash = await sha256(kitArchive);
  if (metadata.schemaVersion !== 1 || metadata.archiveSha256 !== kitHash || metadata.archive !== basename(kitArchive)) throw Error('Kit archive does not match its build metadata');
  if (metadata.source?.dirty !== false || !/^[0-9a-f]{40}$/.test(metadata.source?.commit || '')) throw Error('Formula generation requires a clean, exact source commit');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version) || [metadata.pluginVersion, metadata.runtimeVersion, metadata.cliVersion].some(v => v !== metadata.version)) throw Error('Kit versions must match');
  const arch = { 'macos-aarch64': 'arm64', 'macos-x86_64': 'x86_64' }[metadata.platform];
  if (!arch) throw Error('The Homebrew preview recipe supports only an explicitly built macOS architecture');
  const source = httpsURL(sourceURL), kit = httpsURL(kitURL);
  if (!new URL(source).pathname.includes(metadata.source.commit)) throw Error('Source URL must be pinned to the exact source commit');
  if (!new URL(kit).pathname.endsWith(`/${basename(kitArchive)}`) || /\/(latest|main|master)\//.test(new URL(kit).pathname)) throw Error('Kit URL must identify the versioned archive, never a mutable latest URL');
  const minimumOS = metadata.compatibility?.minimumMacOS;
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(minimumOS || '')) throw Error('Verified macOS deployment floor missing');
  return `# GENERATED PREVIEW: unsigned CI artifacts are not a public release.
# Source commit: ${metadata.source.commit}
# Target: ${metadata.platform}. Generate another reviewed recipe/bottle for another target.
# Do not add post_install registration or model downloads.
require "digest"
require "json"

class AximoVoice < Formula
  desc "Local dictation into Claude Code's editable prompt"
  homepage "https://github.com/agent-axiom/aximo-voice"
  url ${ruby(source)}
  sha256 "${sourceHash}"
  version "${metadata.version}"
  license "MIT"

  depends_on :macos
  depends_on arch: :${arch}
  preserve_rpath
  skip_clean "libexec"

  # This custom-tap preview stages a complete prebuilt kit. No Rust/Node dependency.
  # The source archive is pinned provenance and validates the plugin version below.
  resource "runtime-kit" do
    url ${ruby(kit)}
    sha256 "${kitHash}"
  end

  def install
    odie "macOS ${minimumOS} or newer is required" if MacOS.version < "${minimumOS}"
    source_plugin = JSON.parse((buildpath/".claude-plugin/plugin.json").read)
    odie "Source and kit versions differ" unless source_plugin.fetch("version") == version.to_s
    resource("runtime-kit").stage do
      metadata = JSON.parse(File.read("share/aximo-voice/KIT-METADATA.json"))
      odie "Unsupported kit metadata" unless metadata.fetch("schemaVersion") == 1
      odie "Source commit mismatch" unless metadata.fetch("source").fetch("commit") == "${metadata.source.commit}"
      odie "Dirty kit source" unless metadata.fetch("source").fetch("dirty") == false
      odie "Kit target mismatch" unless metadata.fetch("platform") == "${metadata.platform}"
      %w[version pluginVersion runtimeVersion cliVersion].each do |key|
        odie "Kit version mismatch" unless metadata.fetch(key) == version.to_s
      end
      expected = ["share/aximo-voice/KIT-METADATA.json"]
      metadata.fetch("files").each do |entry|
        path = entry.fetch("file")
        odie "Unsafe kit path" unless path.split("/", -1).all? { |part| part.match?(/\\A[A-Za-z0-9._-]+\\z/) && !%w[. ..].include?(part) }
        odie "Duplicate kit path" if expected.include?(path)
        expected << path
        stat = File.lstat(path)
        odie "Kit links are forbidden" unless stat.file? && !stat.symlink? && stat.nlink == 1
        odie "Kit size mismatch" unless stat.size == entry.fetch("size")
        odie "Kit checksum mismatch" unless Digest::SHA256.file(path).hexdigest == entry.fetch("sha256")
      end
      actual = Dir.glob("**/*", File::FNM_DOTMATCH).reject { |path| [".", ".."].include?(File.basename(path)) }
      actual.each { |path| odie "Kit links are forbidden" if File.symlink?(path) }
      actual.reject! { |path| File.directory?(path) }
      odie "Unexpected kit files" unless actual.sort == expected.sort
      libexec.install "bin", "share"
    end
    bin.install_symlink libexec/"bin/aximo-voice"
    # Homebrew must preserve the bytes covered by KIT-METADATA.json.
    # Relocation / signing must happen before final kit hashes are generated.
  end

  def caveats
    <<~EOS
      This is a maintainer preview, not an accepted public release.
      To connect to Claude Code, explicitly run:
        aximo-voice setup
      Brew installs no Claude registration and downloads no speech model.
      Keep your microphone off until you choose Start in /av.
      Upgrade the kit and refresh the managed plugin with aximo-voice update.
      Before brew uninstall, use aximo-voice uninstall to remove the registration.
      Downloaded models are preserved unless you separately confirm their removal.
    EOS
  end

  test do
    assert_equal version.to_s, JSON.parse(shell_output("#{bin}/aximo-voice --version")).fetch("version")
    system bin/"aximo-voice", "doctor", "--package-only"
  end
end
`;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  const names = { '--source-archive': 'sourceArchive', '--source-url': 'sourceURL', '--kit-archive': 'kitArchive', '--kit-url': 'kitURL', '--output': 'output' };
  for (let i = 0; i < args.length; i += 2) {
    if (!names[args[i]] || !args[i + 1] || options[names[args[i]]]) throw Error('Use --source-archive FILE --source-url HTTPS --kit-archive FILE --kit-url HTTPS --output FILE');
    options[names[args[i]]] = args[i + 1];
  }
  if (Object.values(names).some(name => !options[name])) throw Error('All archive, URL and output options are required');
  const formula = await generateFormula(options);
  await writeFile(options.output, formula, { flag: 'wx' });
  console.log(`Review-only formula written to ${resolve(options.output)}. Nothing published.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
