# Privacy and cleanup

Aximo Voice has no transcription service, telemetry endpoint, API key, background
listening, or persisted audio/transcript history. Installing or loading the plugin
does not start recording. Only a local interactive user start does; engine-stamped
remote, SDK, automated and other-plugin command origins are refused.

## Data flow

- CPAL captures the default local input device after an explicit start.
- The native helper keeps a bounded recording in memory, downmixes and normalizes it.
- The pinned Aximo adapter materializes a temporary WAV for local ONNX inference.
- The helper passes only its final transcript over stdout to the mod.
- The mod holds a pending transcript in memory, then fills Claude Code's editable
  prompt with `mode: 'insert'`. It never calls prompt submission or a model API.
- The user can edit/delete that draft. Submitting sends it through Claude Code's
  normal configured provider and retention behavior.

Other installed Claude Code mods can observe/intercept Mods API calls, including
prompt filling and process output. The terminal application and Claude Code own
their own memory/logging behavior; this plugin cannot override their policies.

## Local storage

Models live in the OS's per-user local data directory under `aximo-voice/models`.
They remain after plugin removal and can be deleted through the user's file manager.
Only the selected engine name is saved in Claude's plugin store. No transcripts are
written to that store, command output, logs, or model context by the plugin.

Control/status/heartbeat files and inference WAV files use an exclusive per-session
private directory. Unix directories are 0700. On Windows, directories are created
atomically with a protected DACL granting only the current user and SYSTEM, with
owner/ACL checks and retained handles during use. Unsafe shared-write, remote,
removable/non-ACL and reparse-point TEMP paths are refused. Control writes are atomic. The native helper removes them on normal completion and best-effort cancellation.
A process crash, SIGKILL, Windows file lock, or power loss can leave private temporary
files. This is **not a RAM-only guarantee**. Inspect/remove stale `aximo-voice-*`
session directories only when no dictation process is running. See the native
[implementation notes](../native/README.md) for exact directory naming.

## Failure safety

Recording is capped at 60 seconds and a helper at 175 seconds. A live plugin sends
a heartbeat every second; after startup grace, loss of that lease stops the helper
and discards its result. Cancel and session changes also suppress late transcripts.
If the prompt is blocked, text remains pending for Insert/Cancel rather than being
submitted automatically. There is no remote transcription fallback.

Network is used for explicit runtime/model setup only. Model files are downloaded
from fixed HTTPS Hugging Face revisions with exact byte counts and SHA-256 checks.
Runtime installation fails unless a checksum-pinned release entry exists.
