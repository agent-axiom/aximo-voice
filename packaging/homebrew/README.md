# Aximo Voice Homebrew preview tooling

`generate-formula.mjs` is the recipe template and generator. It creates a local
`AximoVoice` formula from actual source and complete-kit archive hashes. There is
no published tap or fabricated release asset in this directory.

Read [the complete maintainer workflow](../../docs/homebrew.md) for build commands,
the manifest contract, managed-copy lifecycle, bottle acceptance and release gates.

Inputs:

- Clean-commit source tarball and its exact immutable HTTPS URL
- macOS full-kit tarball from `scripts/package-kit.mjs`, its matching `.build.json`,
  and its immutable HTTPS URL
- An unused local formula output path

The generated formula:

- Installs the whole kit to `libexec` with a command symlink in `bin`
- Uses a hash-pinned `runtime-kit` resource, verifies every file before staging,
  and restricts architecture/macOS deployment floor to the supplied build
- Preserves bundle-relative runtime linkage; requires actual post-install and
  post-bottle-pour checksum verification
- Never calls Claude, starts recording, downloads models or registers a plugin
  from a Homebrew lifecycle callback
- Tests the manager version and `doctor --package-only`
- Has no Node/Rust/Python/ffmpeg runtime dependency

The source archive is provenance input, not an excuse to label precompiled kit
staging a source build. This custom-tap preview is not a Homebrew/core submission.
Do not add fake SHA-256 values, a speculative `bottle do` block, or a working-install
claim before real release and clean-Mac acceptance.
