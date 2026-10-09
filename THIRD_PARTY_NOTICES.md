# Third-party components

This source preview uses these primary components. Exact transitive dependency
versions and source checksums are in [Cargo.lock](native/Cargo.lock).

- [Aximo](https://github.com/agent-axiom/aximo), MIT, pinned commit
  `eca35cc89ad00953b3e5052a885a596a7c2a05b3`
- [transcribe-rs](https://github.com/cjpais/transcribe-rs), MIT, version 0.3.11
- [CPAL](https://github.com/RustAudio/cpal), Apache-2.0, version 0.15.3
- [ONNX Runtime](https://github.com/microsoft/onnxruntime), MIT; the ort bindings
  and binary-build dependencies have their own Cargo-declared licenses
- [Claude Code](https://code.claude.com/docs/), a separately installed product;
  not redistributed in this source or native helper

Downloaded speech models have separate attribution and licenses described in
[model licenses](docs/model-licenses.md). No speech weights are committed here.

Before distributing a binary release, maintainers must generate and review a
complete dependency license inventory, preserve required copyright/license texts,
and include those notices and the build SBOM beside each released artifact.
The current CI artifacts are unsigned development builds, not an approved release.
