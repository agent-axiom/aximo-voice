# Aximo Voice

[![CI](https://github.com/agent-axiom/aximo-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-axiom/aximo-voice/actions/workflows/ci.yml)
[![Native builds](https://github.com/agent-axiom/aximo-voice/actions/workflows/native.yml/badge.svg)](https://github.com/agent-axiom/aximo-voice/actions/workflows/native.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Speak into **Claude Code's editable prompt**, using a local microphone and the
[Aximo](https://github.com/agent-axiom/aximo) speech engine. Review the words and
press Enter yourself. Dictation never sends a prompt automatically.

**Source preview:** the plugin and native helper are implemented; no downloadable
runtime release is published yet. One-command end-user setup remains gated on
verified platform builds and microphone testing. See [installation](docs/installation.md).

## How it works

1. Run `/aximo-voice setup en` (Parakeet) or `/aximo-voice setup ru` (GigaAM).
2. Approve the runtime/model download once. Allow your OS microphone prompt when recording starts.
3. Run `/aximo-voice`, speak, then choose **Stop** or run `/aximo-voice stop`.
4. The transcript appears at the cursor. Edit it, then press Enter when ready.

**Cancel** discards dictation. If a dialog blocks insertion, the transcript stays
in memory until you choose **Insert** or **Cancel**. Recording stops after 60 seconds.

## Intended installation

Once a verified native release is available, inside Claude Code:

```text
/plugin install aximo-voice --marketplace agent-axiom/aximo-voice
```

The native package is designed to require no Rust, Python, Docker, ffmpeg, or Node
setup for users. The current source preview still requires a developer-built or
CI-built native helper. Claude Code 2.1.293 is the tested Mods host.

## Local by default

- Audio capture and speech recognition run on your computer
- No API key, cloud transcription account, telemetry, or audio history
- Models download from checksum-pinned Hugging Face snapshots, only after consent
- Aximo uses a private temporary WAV during inference, removed on normal completion
- A crash or forced kill can leave private temporary files; see [privacy](docs/privacy.md)
- Claude Code receives the inserted draft; it is sent to Claude when you submit it

This adds `/aximo-voice`; it does not replace Claude Code's built-in `/voice`.
The first version loads its local model for each dictation; it is not streaming ASR.

## Details

- [Installation and platform readiness](docs/installation.md)
- [Architecture and lifecycle](docs/architecture.md)
- [Privacy and cleanup](docs/privacy.md)
- [Development, tests, and release checklist](docs/development.md)
- [Verified checks and remaining limits](docs/verification.md)
- [Model sources and licenses](docs/model-licenses.md)
- [Security policy](SECURITY.md)
