# Installation and readiness

## Current status

This is a source preview. There is no runtime release in `scripts/runtime-manifest.txt`,
so automatic runtime installation intentionally fails closed. Installing the plugin
alone does not make dictation work. The build workflow produces reviewable platform
artifacts without publishing releases, registries, or marketplace submissions.

Tested Mods host: Claude Code 2.1.293. Mods are an early-access API; managed policy
can disable them. The plugin checks no hidden flags and bypasses no policy.

## End-user path after a verified release

Inside an interactive Claude Code session:

```text
/plugin install aximo-voice --marketplace agent-axiom/aximo-voice
```

This adds the repository as a marketplace and opens the installation dialog.
Restart Claude Code if prompted. Run `/aximo-voice setup en` or
`/aximo-voice setup ru`. The dialog identifies the runtime/model sources and asks
before downloading up to 1 GB of model weights. No microphone capture occurs at
install, session start, or model setup. Your first explicit dictation requests OS
microphone access. Rejecting it leaves an actionable error and starts no fallback.

That combined `--marketplace` option is an **interactive slash command**, not a
supported flag for the shell's `claude plugin install`. The shell equivalent is:

```sh
claude plugin marketplace add agent-axiom/aximo-voice
claude plugin install aximo-voice@aximo
```

See [Anthropic's official install guide](https://code.claude.com/docs/en/plugins/install#add-a-marketplace-and-install-in-one-command).

## Developer preview now

1. Clone this repository and build the helper as described in [development](development.md),
   or obtain the matching artifact from a successful native-build workflow.
2. Copy only the verified platform helper into `bin/aximo-voice-native`
   (`bin/aximo-voice-native.exe` on Windows). Never rename another platform's binary.
3. Start `claude --plugin-dir /absolute/path/to/aximo-voice`.
4. Run `/aximo-voice setup en` or `setup ru`. An existing developer helper is reused;
   model download still needs consent.

## Platform matrix

Build targets: macOS Apple Silicon, macOS Intel, Linux x86-64, Windows x86-64.
A build artifact is not evidence of working microphone access. The release checklist
requires actual native microphone tests on every advertised platform. Linux needs a
working audio stack and ALSA runtime; headless containers and remote SSH sessions
usually have no local microphone. This version accepts start commands only from the local interactive Claude Code
prompt. Remote-control, SDK and other-plugin command origins are refused. Linux ARM64 and Windows ARM64 are not
included in this first build matrix.

The first macOS release must address code signing/notarization and its real
microphone permission flow. Do not bypass Gatekeeper or security warnings. Windows
SmartScreen/signing and Linux distribution compatibility need release verification.

## Commands

- `/aximo-voice`: start, or stop the current recording
- `/aximo-voice start`: start only when idle
- `/aximo-voice stop`: stop recording and transcribe
- `/aximo-voice cancel`: stop/discard, including a pending uninserted transcript
- `/aximo-voice insert`: retry inserting a pending transcript
- `/aximo-voice status`: show current state
- `/aximo-voice setup en|ru`: choose/install a model, without recording

Use Stop/Cancel buttons while recording so the command prompt itself need not be
changed. Insertion uses the current cursor position and preserves existing text.
A model load happens before recording; speak only after the status says Recording.
