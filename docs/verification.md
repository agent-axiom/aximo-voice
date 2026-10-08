# Verification snapshot

Date: 2026-10-08. This snapshot describes local Linux development verification,
not a published release or a clean-machine end-user installation.

## Passed

- 26 Node tests: plugin lifecycle and offline runtime-installer integrity/failure cases
- 6 tests in the real Claude Code 2.1.293 Mods host, including terminal/desktop
  controls, editable insertion, cancellation, errors and non-person origin refusal
- Claude plugin/marketplace validator, with no warnings
- 17 native Rust tests (15 library + 2 binary)
- Cargo check, rustfmt, and Clippy across all targets with warnings denied
- Native CLI doctor, invalid UUID, missing-model refusal and session cleanup checks
- Parakeet: fresh pinned download, all sizes/SHA-256 values, readiness check, actual
  ONNX inference on one second of generated silence, valid transcript response
- GigaAM: the same fresh-cache test, including its model/vocabulary filename mapping
- Documentation links, manifests, shell syntax, JavaScript syntax, workflow YAML parsing
- Cargo audit 0.22.2: 300 dependencies, zero known vulnerabilities, zero warnings,
  no ignored advisories. Advisory database commit:
  `b8a1a33e246a0a9a3b5f377248c41a503defec74` (updated 2026-10-07)

## Verification environment details

Rust 1.94.1. Exact transcribe-rs 0.3.11; Aximo pinned to
`eca35cc89ad00953b3e5052a885a596a7c2a05b3`; complete versions in Cargo.lock.

The development environment could not reach the default ONNX build CDN. Local
linked tests used the official Microsoft ONNX Runtime 1.24.2 Linux archive after
verifying its published SHA-256:
`43725474ba5663642e17684717946693850e2005efbd724ac72da278fead25e6`.
That temporary dynamic-link configuration is not part of any release artifact.
Normal CI retains the upstream default runtime build path and separately tests
relocated executables before making development artifacts available.

An initial inference process was killed while its model cache occupied a small
RAM-backed temporary filesystem. Both complete model tests passed after moving
that test cache onto ordinary workspace storage. No model/runtime integrity checks
were disabled. Native TLS uses the operating system's trusted roots; certificate
verification remains enabled.

## Not yet verified or completed

- Actual microphone capture or permission prompts on any physical user machine
- Live end-to-end dictation in an interactive Claude Code session
- Real-speech transcription accuracy, latency, device loss and acoustic conditions
- macOS/Windows executable builds or microphone permissions, signing/notarization
- Clean-machine portability of published static/native runtime packages
- Remote GitHub CI and release/marketplace publication (being checked separately from this local snapshot)

This records the original local source-preview verification. The public repository
is now available; the implementation is being submitted as a draft PR. Consult
that PR and its exact-commit checks for the current remote build results. `scripts/runtime-manifest.txt` deliberately contains no release
asset entries. Automated setup cannot claim a ready-to-download runtime yet.

Use the [release checklist](development.md#required-before-a-user-ready-release)
before changing those readiness claims. Silence validates wiring, not speech quality.
