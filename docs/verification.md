# Verification and remaining limits

Updated: 2026-10-09. This is a source preview, not a published release or a
clean-machine end-user installation.

## Exact-commit CI

Use the checks attached to [implementation PR #1](https://github.com/agent-axiom/aximo-voice/pull/1)
for its current head. A passing older commit is not evidence that a newer commit
passed. The workflows check out the PR's exact source head; native artifacts record
both that source commit and GitHub's workflow commit in build metadata.

The workflows cover:

- 39 Node tests: command aliases/collisions, lifecycle, consent, prompt insertion,
  cancellation, runtime installer integrity/rollback, and native dependency metadata parsing
- 14 tests in the real Claude Code 2.1.293 Mods test host, plus plugin/marketplace validation
  (registration/native-process responses are mocked; all three command matchers and
  shared-state cancellation run through the real host)
- 5 Windows PowerShell installer integrity/failure cases
- Rust tests, rustfmt, Clippy with warnings denied, and release builds on Linux x86-64,
  macOS Apple Silicon, macOS Intel, and Windows x86-64
- Windows protected temporary-directory DACLs, WAV inheritance, pinned path handles,
  unsafe-parent refusal, and bounded concurrent cleanup
- Relocation of each complete runtime bundle into an unrelated directory with build
  loader environment variables removed; `doctor` creates a real ONNX session builder
  without opening a microphone and verifies explicit telemetry opt-out
- ELF/Mach-O/PE dependency checks, platform minimums, SHA-256/build metadata, and
  bundled native runtime notices
- Fresh checksum-verified Parakeet and GigaAM downloads and actual synthetic-silence
  inference from the relocated Linux package
- Dependency auditing against the advisory database available at CI run time

The pre-hardening source commit
[`df4b063`](https://github.com/agent-axiom/aximo-voice/commit/df4b06388ef631780a341aa82625844dd5da60fa)
passed [general CI](https://github.com/agent-axiom/aximo-voice/actions/runs/37860773590)
and [all four native builds](https://github.com/agent-axiom/aximo-voice/actions/runs/37860773838).
Its archive and per-file hashes were independently verified. Subsequent Windows
privacy and native-runtime probe changes require their own passing exact-head checks.
Download only a matching artifact from a successful run; Actions artifacts expire.
They are development artifacts, not signed end-user releases.

## Pinned build inputs

Rust 1.94.1; exact transcribe-rs 0.3.11; Aximo commit
`eca35cc89ad00953b3e5052a885a596a7c2a05b3`; dependency versions in Cargo.lock.

ONNX Runtime 1.24.2 is explicitly provisioned from SHA-256-verified official Microsoft
archives. Intel macOS has no official archive for this version, so CI builds the
same official release commit, `058787ceead760166e3c50a0a4cba8a833a6f53f`.
The provisioner never silently substitutes another runtime version or disables
TLS verification. See [the runtime manifest](../scripts/onnx-runtime-manifest.json).

## Original local baseline

On 2026-10-08, local Linux verification passed the then-current 26 Node tests,
6 real Mods-host tests, 17 Rust tests, plugin validation, Cargo check/rustfmt/Clippy,
native CLI refusal/cleanup cases, and both real-model silence tests. Cargo audit
0.22.2 checked 300 dependencies with zero known vulnerabilities or warnings against
advisory commit `b8a1a33e246a0a9a3b5f377248c41a503defec74`.

An initial inference process was killed while its model cache occupied a small
RAM-backed temporary filesystem. Both complete model tests passed after moving the
cache onto ordinary workspace storage. No integrity or certificate checks were disabled.
This historical baseline does not substitute for current-head CI.

## Still required before end-user release

- Actual microphone capture and permission grant/denial on every advertised platform
- Live dictation in an interactive Claude Code session, including existing prompt
  text, Stop/Cancel, blocked insertion and no turn starting until the user submits
- Real-speech accuracy, latency, device loss, repeated sessions and acoustic conditions
- Clean-machine portability, OS security dialogs, macOS signing/notarization and
  Windows signing/SmartScreen behavior
- Complete binary license inventory/SBOM and maintainer-approved versioned release
- Pinned release URLs and hashes in `scripts/runtime-manifest.txt`, followed by a
  clean-machine installer test

The runtime manifest deliberately has no release asset entries. Automatic setup
therefore fails closed instead of claiming a ready-to-download runtime. Use the
[release checklist](development.md#required-before-a-user-ready-release) before
changing readiness claims. Silence validates wiring, not speech quality. ACL tests
inspect real Windows descriptors; they are not a second-user logon penetration test.
