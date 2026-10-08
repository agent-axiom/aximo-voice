# Development and verification

## Requirements for contributors

- Node.js 22+ for dependency-free tests and CI scripts
- Claude Code 2.1.293 for the actual Mods validator/test host (no sign-in needed)
- Rust 1.94.1, Cargo and native C/C++ tooling
- Linux: pkg-config and ALSA development package (`libasound2-dev`)

End users are not expected to install this development toolchain after verified
prebuilt releases exist.

```sh
npm test
npm run check
claude plugin validate .
claude plugin test .
cargo fmt --manifest-path native/Cargo.toml --check
cargo test --manifest-path native/Cargo.toml --locked
cargo clippy --manifest-path native/Cargo.toml --all-targets --locked -- -D warnings
cargo build --manifest-path native/Cargo.toml --release --locked
mkdir -p bin
# For a portable install, use the complete verified CI runtime archive.
# A developer-built helper may require its build-time runtime library paths.
cp native/target/release/aximo-voice-native bin/
claude --plugin-dir "$PWD"
```

Windows: use the complete matching runtime bundle, including its DLLs; copying
only `aximo-voice-native.exe` is insufficient. The engine git revision, exact
transcribe-rs version, Cargo.lock and model manifests are reviewed source inputs.
No workflow publishes a release, a package registry entry, or a marketplace listing.

## Test layers

- Node lifecycle tests exercise asynchronous cancellation, retries, empty/invalid
  results, blocked insertion, setup consent, and session teardown.
- Claude's real Mods test host validates sandbox API calls, prompt insertion and
  terminal/desktop control trees. These are host tests, not a physical UI recording.
- Native Rust tests cover audio normalization/bounds, model integrity checks,
  private IPC, lease expiry, argument bounds and cleanup.
- Native CI builds four platforms, relocates each executable, invokes doctor, and
  produces exact SHA-256/build metadata. Linux additionally downloads the real pinned
  Parakeet and GigaAM models and runs synthetic-silence inference from the relocated binary.
- Dependency auditing runs independently. No badge claims static coverage numbers.

## Required before a user-ready release

1. All exact-commit CI checks pass, including real-model wiring.
2. Real microphone tests pass on every advertised OS/architecture: permission grant
   and denial, silence, English/Russian speech, Stop, Cancel while loading/recording/
   inferencing, 60-second cap, device loss, repeated starts and concurrent sessions.
3. Confirm pre-existing prompt text is preserved and no turn starts until Enter.
4. Verify hot reload, `/clear`, `/resume`, terminal shutdown, forced kill, lease expiry,
   blocked prompt retry and temporary-file behavior.
5. Validate model quality with representative real speech; silence proves no accuracy.
6. Resolve macOS signing/notarization/microphone attribution, Windows SmartScreen and
   Linux runtime compatibility. Do not ship a security-warning bypass instruction.
7. Obtain maintainer approval to publish a versioned release. Review binary artifacts,
   hashes, dependencies, platform metadata, and model attributions. Generate an SBOM
   and a complete license inventory; include all required third-party license texts
   with distributed binaries (see [notices](../THIRD_PARTY_NOTICES.md)).
8. Add exact release asset URLs and SHA-256 values to `scripts/runtime-manifest.txt`;
   verify installer rollback, integrity failure and clean-machine setup.
9. Only then remove the source-preview caveat and advertise one-command installation.

## Deliberate limits

A model loads for each recording, with no incremental partial transcripts. No
custom global hotkey or built-in `/voice` override is claimed. The default local
microphone is used; selecting devices is future work. Models remain cached after
uninstall. Network setup can take several minutes, and model consent must be repeated
when explicitly selecting another model.
