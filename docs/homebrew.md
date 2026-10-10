# Homebrew preview: package, verify, then release

This is maintainer tooling, not a published installation channel. No tap, bottle,
release URL or usable `brew install agent-axiom/tap/aximo-voice` command is promised.
The native CI artifacts are unsigned previews. Passing these checks does not prove
real speech accuracy, microphone permissions, Developer ID signing or notarization.

## Package contract

After the native build and `scripts/package-native.mjs`, run on the same Unix
OS/architecture:

```sh
node scripts/package-kit.mjs macos-aarch64
# Or macos-x86_64; linux-x86_64 is a developer/CI preview, not the Mac launch claim.
```

The result is `dist/kit` and a versioned `dist/aximo-voice-kit-<version>-<platform>.tar.gz`,
with sibling `.sha256` and `.build.json` files. The kit layout is:

```text
bin/aximo-voice
share/aximo-voice/KIT-METADATA.json
share/aximo-voice/plugin/
  .claude-plugin/{plugin,marketplace}.json
  hooks/
  native/models.json
  scripts/{install-runtime.sh,install-runtime.ps1,runtime-manifest.txt,onnx-runtime-manifest.json}
  bin/aximo-voice-native
  bin/<complete matching ONNX libraries, notices and BUILD-METADATA.json>
  docs/
  LICENSE, THIRD_PARTY_NOTICES.md, README.md, SECURITY.md
```

The management binary is native Rust. The JavaScript plugin runs in Claude's Mods
host. The installed kit needs no separate Node, Rust, Python, ffmpeg or Xcode
toolchain. Development and packaging do need the tools in [development](development.md).
Windows retains the existing native runtime distribution; this manager preview
does not claim Windows support.

The packager executes both native binaries with build-time loader variables
removed, requires identical plugin/Cargo/runtime/CLI versions, checks the runtime
manifest against every library, and rejects missing dependencies, symlinks,
hardlinks, unexpected files and checksum mismatches. Only an allowlist of plugin
inputs is copied; source trees, build caches and tests are excluded. A failed
validation leaves an earlier kit directory intact.

`KIT-METADATA.json` schema version 1 contains:

- `version`, `pluginVersion`, `runtimeVersion`, `cliVersion`, and `platform`
- `source.commit`, `source.workflowCommit`, and `source.dirty`
- `compatibility` from the verified runtime build
- `files`, an exhaustive list of `{file, sha256, size}` entries; `file` is relative
  to the kit root, not to the metadata directory
- `preview: true`, `unsigned: true`, and `microphoneTested: false`

The manifest excludes itself; the archive SHA-256 authenticates the complete
manifest and payload. This is integrity and provenance, not a signature or proof
that a source commit is trustworthy. The manager verifies the kit before copying
or activating it. Source-only npm tooling may retain a `-dev` version; it is not a
shipped executable. The shipped plugin, native helper and manager must agree.

## Registration and lifecycle

Homebrew's formula only stages files and links the `aximo-voice` command. It must
not register a plugin, download models, request microphone access or edit Claude
configuration during install, upgrade, bottle pour or uninstall. The user invokes
`aximo-voice setup` explicitly.

The formula installs the whole kit under its `libexec` and links the command from
there. The manager resolves its actual executable, validates the adjacent kit,
then installs a managed user-data copy and registers that copy through the
official Claude CLI in user scope. It does not write Claude's settings by hand.
Claude's documented local-directory marketplaces reference source files directly;
using a managed copy avoids making an active session depend on a removable
Homebrew Cellar version. See [Claude's local marketplace behavior](https://code.claude.com/docs/en/plugin-marketplaces).

Management operations and native recording/model setup coordinate with a lifecycle
lock. `aximo-voice update` coordinates Homebrew upgrade with managed-plugin refresh;
`brew upgrade` alone does not prove the active plugin changed. An active recording
must finish before managed files can be replaced. A failed managed activation must
retain or restore the earlier working copy. Downloaded models stay outside the
versioned kit and are reused after verification.

Use `aximo-voice uninstall` before `brew uninstall` to remove Aximo's registration.
Models are kept by default; deleting them is a separate, explicitly confirmed
operation. Brew's own uninstall must not remove user data or other plugins. Never
reset macOS microphone permission to make setup appear successful.

## Generate a reviewable formula from real artifacts

The generator in [packaging/homebrew](../packaging/homebrew/README.md) requires
existing archive files and calculates their actual SHA-256 values. It refuses a
dirty source tree, mismatched kit hash, inconsistent component versions, HTTP URLs,
unversioned source URLs and unsupported platforms. No placeholder formula that
looks installable is checked in.

Provide the exact source archive bytes that the specified HTTPS URL will serve.
The source URL must contain the exact 40-character commit from the kit. A locally
made `git archive` and a GitHub-generated archive can have different bytes even
when their contents describe the same commit: do not reuse one file's hash for
the other. Provide the final complete kit archive plus its generated build metadata.

```sh
# Set these to reviewed, real archive paths and intended immutable HTTPS URLs.
# The tool writes a local recipe only; URLs need not be published to inspect it.
node packaging/homebrew/generate-formula.mjs \
  --source-archive "$SOURCE_ARCHIVE" --source-url "$SOURCE_URL" \
  --kit-archive "$KIT_ARCHIVE" --kit-url "$KIT_URL" \
  --output "$REVIEW_DIRECTORY/aximo-voice.rb"
```

This is a custom-tap preview recipe with a pinned full `runtime-kit` resource and
a pinned source archive for provenance/version checks. It stages prebuilt files;
it does not pretend to be a Homebrew/core source-build submission. It is restricted
to the one architecture whose artifact was supplied. Do not advertise the other
architecture until its separate build and clean-Mac acceptance are complete.

Review the generated source and use `ruby -c` and Homebrew's `brew style`/`brew audit`
before adopting it in a separately approved tap. The generator creates neither a
tap nor a release and refuses to overwrite an existing recipe.

## Maintainer bottle acceptance

Only after a maintainer has approved publishing the exact source/runtime assets
and tap should the intended public installation instructions become user-facing.
For an approved, resolvable formula, the standard bottle workflow is:

```sh
brew install --build-bottle "$FORMULA"
brew test "$FORMULA"
brew bottle --json --skip-relocation "$FORMULA"
```

Keep the exact bottle tarball, emitted bottle JSON and SHA-256. Add a `bottle do`
block only from actual `brew bottle` output, with the real hosting location and
actual OS/architecture tag. See [Homebrew's bottle documentation](https://docs.brew.sh/Bottles)
and [formula cookbook](https://docs.brew.sh/Formula-Cookbook).

Homebrew normally rewrites some Mach-O install names. The generated formula uses
the documented `preserve_rpath` directive and skips cleaning its private `libexec`
payload. `--skip-relocation` avoids claiming the kit can be rewritten while its
hash manifest remains valid. These settings still need real installation and
bottle-pour verification; they are not proof of byte preservation. See the
[Homebrew Formula API](https://docs.brew.sh/rubydoc/Formula.html#preserve_rpath-class_method).

On a fresh supported Mac/profile, test both the recipe install and a bottle pour:

1. Run `aximo-voice doctor --package-only` after Homebrew's complete install/pour.
   It must pass all kit hashes and native ONNX loading with no Claude login,
   downloaded speech model, Node/Rust toolchain or microphone access.
2. Run ordinary `aximo-voice setup`, then normal Claude Code without `--plugin-dir`.
   Confirm both the plugin version and native bytes used by the managed installation.
3. Repeat setup; simulate failed registration, failed update and active recording
   during update. Confirm no duplicate plugin, no unrelated settings change and
   that the prior version remains usable after failure.
4. Upgrade, perform normal Brew cleanup, start a new Claude session and confirm the
   managed copy still works. Test uninstall, model retention and reinstall.
5. Repeat on each supported architecture, with the minimum macOS actually claimed.

If Homebrew changes any hashed executable/library, stop. Do not weaken checksum
verification or relabel changed bytes as the original signed artifact. Fix the
build/packaging layout, regenerate a reviewed final artifact and repeat acceptance.

## Release gates CI cannot replace

The workflow can build complete kits, validate hashes, run package doctor and test
official local-marketplace registration in an isolated Claude profile. It cannot
grant microphone permission or prove real speech works on a clean user's Mac.

Before inviting users, record exact source commit, artifact SHA-256, macOS version,
architecture and Claude version for:

- English and Russian real-microphone dictation, preserved existing prompt text,
  explicit Stop/Cancel and no automatic submission
- First model consent/download, cancellation, network loss, checksum failure,
  retry, disk-space failure and no activation of partial/unverified files
- Permission denial/recovery and actual microphone attribution for Terminal,
  iTerm and Claude Desktop; do not assume the system label is Aximo Voice
- Session close, 60-second cap, device loss, upgrade rollback and model preservation
- Developer ID, Hardened Runtime, audio entitlements, signing every nested native
  component, and notarization of the final distribution where applicable
- Complete third-party licensing/SBOM and no unintended audio network transmission

Signing changes bytes. The preview packager intentionally continues to label its
output unsigned; a reviewed release-signing pipeline must sign before recording
final hashes and must attest those checks separately. Never use certificate
bypasses, `xattr -d` or disabled Gatekeeper as normal installation instructions.
DMG/cask delivery remains a separate future GUI project.
