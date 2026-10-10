# Native helper

This executable opens the local default microphone and calls the embedded
`aximo-inference` library. It does not connect to an Aximo server. The Aximo
crates are pinned to `eca35cc89ad00953b3e5052a885a596a7c2a05b3`.

The commands return one JSON object on standard output, except the opt-in
`setup-model --progress-json` stream described below. Errors return
`{"type":"error","error":"..."}` and a nonzero exit code.

| Command | Result |
| --- | --- |
| `doctor --engine parakeet` | `type: doctor`, `modelReady`, `engine`, platform information and a native ONNX ABI check with telemetry disabled; never opens the microphone |
| `setup-model --engine parakeet` | Explicitly downloads the pinned, verified model, then returns `type: ready` |
| `record --session UUID --engine parakeet` | Blocks until stop, cancel or the limit; returns `type: transcript` with `text`, or `type: cancelled` |
| `transcribe-file --file input.wav --engine parakeet` | Transcribes an explicit local WAV without opening the microphone; uses the same verified model and returns `type: transcript` |
| `control --session UUID --action status` | Current `state`; does not renew the recording lease |
| `control --session UUID --action heartbeat` | Renews the lease and returns current `state` |
| `control --session UUID --action stop` | Finishes recording and starts transcription |
| `control --session UUID --action cancel` | Discards recording/transcription |

`gigaam` is the other supported engine. UUIDs must be nonzero, canonical,
lowercase UUID strings. Each recording needs a fresh UUID. Controls on a
nonexistent session return `state: idle` and never create a directory.

## Bounds and cleanup

- Capture stops after 60 seconds, regardless of user input.
- The plugin must send heartbeats at least once a second. After the initial
  10-second grace period, losing heartbeats for 5 seconds cancels the helper.
- A separate watchdog applies a 175-second total wall limit, including model
  loading, capture and synchronous inference. Claude's caller uses 180 seconds.
- Cancellation and lease expiry suppress the transcript, including during
  synchronous inference. The watchdog can terminate the isolated helper.
- Audio is bounded and downmixed in memory. Aximo normalizes it to mono 16 kHz
  PCM using its own resampler.
- Aximo's inference adapter briefly materializes a WAV. Before starting any
  threads, the helper points temporary-file environment variables at its
  exclusive session directory. Normal completion and cancellation remove it.
- On Unix, session directories are mode 0700, and IPC refuses symlink,
  foreign-owner, or group/world-accessible session directories. Unix signal
  handling also performs cancellation cleanup. An uncatchable kill or power
  loss can leave private temporary files behind; deletion is not secure erasure.
- The helper never stores the transcript on disk. Only state and control
  markers are used for IPC.
- File inference rejects inputs larger than 64 MiB or longer than 60 seconds.
  It does not require an interactive heartbeat. Both inference paths reject
  oversized transcripts rather than reporting a truncated result as success.

## Build checks

Use a supported Rust toolchain and the platform audio development libraries
(ALSA development headers on Linux):

```sh
cargo build --release --manifest-path native/Cargo.toml
cargo test --manifest-path native/Cargo.toml
cargo test --manifest-path native/Cargo.toml --lib
cargo fmt --manifest-path native/Cargo.toml --check
```

The binary is `native/target/release/aximo-voice-native` (with `.exe` on Windows).
Automated tests do not open a microphone or download models. Real microphone,
model inference, and Claude Code integration require a separate host smoke test.
The `--lib` command runs core audio, IPC, and model-verification tests separately;
keep the full test command in CI to also check the executable and ONNX linkage.

## Model setup stream and safe retry

`setup-model --engine parakeet --progress-json --session UUID` writes bounded
JSONL to stdout. `doctor` advertises `setupProgressProtocol: 1` and
`runtimeVersion`. Version 1 progress objects have `type: progress`,
`operation: setup-model`, `protocol: 1`, `engine`, `stage`, `bytesCompleted`,
`totalBytes`, and `reusedBytes`. Per-file events also include the pinned basename
`file`, `fileBytes`, and `fileTotalBytes`. Stages are `checking`, `downloading`,
`verifying` (SHA-256), and `installing`. `bytesCompleted` counts complete reused
files and downloaded bytes; `fileBytes` during verification is hashing progress.
Updates are throttled to four per second, except file/stage boundaries, with at
most 4096 progress events. Terminal `ready`, `cancelled`, or `error` is always a
separate final object; streamed terminals include the protocol, operation, and
engine. Errors still exit nonzero. Without the flag there is only the terminal
object. The transcript protocol is unchanged.

Setup never opens the microphone or initializes inference. With a session,
send the existing `control ... --action heartbeat` at least once per second;
Cancel, Stop, or a lost session lease cooperatively cancels setup. Without a
session, no heartbeat is needed. On Unix, SIGINT, SIGTERM, and SIGHUP also cancel.
Cancellation is polled during hashing and while waiting for the network. The
network worker has a bounded channel and never writes model files. Cancellation
waits for any already-started final rename transaction to complete or roll back.

Retry keeps and rehashes only whole verified files in a private revision-specific
cache beside the installed model. Incomplete files are deleted, including stale
partial files found after an interrupted process. No byte-range resume is
claimed or attempted. Free-space checks report required and available bytes
before downloading; allowance is the missing file bytes plus a 16 MiB margin.
The installed model stays in place until every new file is verified. A failed
commit restores the old directory; setup also recovers an interrupted directory
swap on the next invocation. Model setup and package management take an exclusive
lifecycle lock; inference holds a shared lock. Model files and helper binaries
cannot be replaced while inference is running.

## Packaged management CLI

`aximo-voice` is built alongside `aximo-voice-native`. It verifies complete kit
hashes and component versions, registers only its own local marketplace with
the official Claude CLI, and holds an exclusive lifecycle lock while changing
the installed kit. Capture and transcription hold shared locks; model setup
takes an exclusive lock.
Models live outside the versioned package. See [Homebrew](../docs/homebrew.md).
