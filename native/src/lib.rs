//! Testable microphone, private control IPC, and verified model-storage pieces.
//! The executable owns process lifecycle and inference orchestration.
pub mod audio;
pub mod control;
pub mod lifecycle_lock;
pub mod model_download;

#[cfg(windows)]
mod windows_security;
