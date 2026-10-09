# Model sources and licenses

The source code is MIT. Model weights have separate licenses and are downloaded
only after the user approves setup. Aximo Voice redistributes no model weights in
the repository or runtime helper.

## Parakeet

- Model: NVIDIA Parakeet TDT 0.6B v3, ONNX conversion by Ivan Stupakov
- [Source model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [Pinned ONNX snapshot](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/tree/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce)
- [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/)
- Download: encoder INT8, decoder/joint INT8, preprocessing model, vocabulary;
  approximately 671 MB total (decimal)

The upstream model card lists multiple languages including Russian and English.
The pinned Aximo/transcribe-rs adapter reports English in its capability metadata;
this preview provides Parakeet as the English/default option and makes no measured
multilingual accuracy claim. Russian setup explicitly selects GigaAM.

## GigaAM

- Model: ai-sage GigaAM v3 E2E CTC, ONNX conversion by Ivan Stupakov
- [Source model](https://huggingface.co/ai-sage/GigaAM-v3)
- [Pinned ONNX snapshot and MIT license](https://huggingface.co/istupakov/gigaam-v3-onnx/tree/322c3b29492673eb7d0b434bfa9dfb8653e34d02)
- Download: `v3_e2e_ctc.onnx` and vocabulary, approximately 886 MB total
- Local names: `model.onnx` and `vocab.txt`, matching the pinned Aximo adapter

Exact snapshots, source filenames, byte counts, SHA-256 values and model-license
identifiers are recorded in [native/models.json](../native/models.json). Large-file
hashes come from Hugging Face's LFS metadata; vocabulary hashes were verified from
the pinned downloaded files. The models are unmodified except for local filenames.
Speech quality, punctuation, accents, and background noise require representative
human-speech evaluation. Silence smoke tests establish wiring, not accuracy.
