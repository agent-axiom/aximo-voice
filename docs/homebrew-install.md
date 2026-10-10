# Install the Aximo Voice 0.1.0 Homebrew preview

The public formula is hosted in this repository. The explicit tap URL is required:

```sh
brew tap agent-axiom/tap https://github.com/agent-axiom/aximo-voice
brew install agent-axiom/tap/aximo-voice
aximo-voice setup
```

Then start a new Claude Code session and run `/av`. Choose a model and approve its
download. Start recording only when you choose Start; the plugin does not submit
your prompt automatically.

Requires Homebrew and Claude Code 2.1.293 or newer. Supported native kits:
- Apple Silicon: macOS 14 or newer
- Intel: macOS 13.4 or newer

No separate Node, Rust, Python or ffmpeg toolchain is required to run the installed
kit. The formula downloads architecture-specific, SHA-256-pinned complete kits
from [the 0.1.0 preview release](https://github.com/agent-axiom/aximo-voice/releases/tag/v0.1.0).

This is an unsigned preview. Real microphone acceptance is still pending; do not
bypass macOS security warnings. Homebrew installation does not register Claude,
download speech models or activate the microphone. Setup is explicit.

Check package integrity with `aximo-voice doctor --package-only`. For upgrades use
`aximo-voice update`. To remove Claude registration, run `aximo-voice uninstall`
before `brew uninstall agent-axiom/tap/aximo-voice`; downloaded models are retained
unless their separate deletion is explicitly confirmed.
