# Aximo Voice 0.1.0 preview: unsigned, checksum-verified native kits.
# Source commit: efa540e266a92ba092ebf2f6932f9db94c9454fc
# Native kits for Apple Silicon and Intel Macs.
# Do not add post_install registration or model downloads.
require "digest"
require "json"

class AximoVoice < Formula
  desc "Local dictation into Claude Code's editable prompt"
  homepage "https://github.com/agent-axiom/aximo-voice"
  url 'https://github.com/agent-axiom/aximo-voice/archive/efa540e266a92ba092ebf2f6932f9db94c9454fc.tar.gz'
  sha256 "354d1624ff7464102ef0cd1c9a09afd50a584e2d637b35ec85a9a256c09e2c27"
  version "0.1.0"
  license "MIT"

  depends_on :macos
  preserve_rpath
  skip_clean "libexec"

  # This custom-tap preview stages a complete prebuilt kit. No Rust/Node dependency.
  # The source archive is pinned provenance and validates the plugin version below.
  on_arm do
    resource "runtime-kit" do
      url 'https://github.com/agent-axiom/aximo-voice/releases/download/v0.1.0/aximo-voice-kit-0.1.0-macos-aarch64.tar.gz'
      sha256 "d8c8172c63682687d98fb050c269b60cdd108d8eb3ca78ed7535a88271257e5d"
    end
  end

  on_intel do
    resource "runtime-kit" do
      url 'https://github.com/agent-axiom/aximo-voice/releases/download/v0.1.0/aximo-voice-kit-0.1.0-macos-x86_64.tar.gz'
      sha256 "104a67b5cc5b9db10f1577b509c6067a75c455fd76ecd0577aaa659367979159"
    end
  end

  def install
    minimum_os = Hardware::CPU.arm? ? "14.0.0" : "13.4.0"
    target = Hardware::CPU.arm? ? "macos-aarch64" : "macos-x86_64"
    odie "macOS #{minimum_os} or newer is required" if MacOS.version < minimum_os
    source_plugin = JSON.parse((buildpath/".claude-plugin/plugin.json").read)
    odie "Source and kit versions differ" unless source_plugin.fetch("version") == version.to_s
    resource("runtime-kit").stage do
      metadata = JSON.parse(File.read("share/aximo-voice/KIT-METADATA.json"))
      odie "Unsupported kit metadata" unless metadata.fetch("schemaVersion") == 1
      odie "Source commit mismatch" unless metadata.fetch("source").fetch("commit") == "efa540e266a92ba092ebf2f6932f9db94c9454fc"
      odie "Dirty kit source" unless metadata.fetch("source").fetch("dirty") == false
      odie "Kit target mismatch" unless metadata.fetch("platform") == target
      %w[version pluginVersion runtimeVersion cliVersion].each do |key|
        odie "Kit version mismatch" unless metadata.fetch(key) == version.to_s
      end
      expected = ["share/aximo-voice/KIT-METADATA.json"]
      metadata.fetch("files").each do |entry|
        path = entry.fetch("file")
        odie "Unsafe kit path" unless path.split("/", -1).all? { |part| part.match?(/\A[A-Za-z0-9._-]+\z/) && !%w[. ..].include?(part) }
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
      This is an unsigned preview. Real microphone acceptance is still pending.
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
