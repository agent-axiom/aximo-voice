# Security

Please report vulnerabilities privately through the repository's GitHub security
advisory flow when enabled. Do not post audio, transcripts, credentials, or private
machine paths in a public issue. For a non-sensitive bug, include the plugin/helper
version, OS, state, and a minimal synthetic reproduction.

Security invariants:

- Microphone capture begins only on the person's explicit start action.
- No recording tool is exposed to the model; no prompt is submitted automatically.
- Audio and inference stay local; there is no network transcription fallback.
- Recordings, helper lifetime, decoded audio, stdout and download sizes are bounded.
- Model/runtime downloads are consent-gated and checksum-pinned.
- Session paths use canonical UUIDs, exclusive private directories and atomic controls.
- Cancellation/session changes reject late results; missing heartbeats terminate work.
- Shell commands receive fixed argv; recognized text is never executed.

Read [privacy](docs/privacy.md) for temporary-file and surrounding-host limitations.
Release builds are not yet signed or published. Do not bypass operating-system
security warnings to use them. See [release requirements](docs/development.md).
