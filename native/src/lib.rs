//! Testable microphone, private control IPC, and verified model-storage pieces.
//! The executable owns process lifecycle and inference orchestration.
pub mod audio;
pub mod control;
pub mod model_download;
