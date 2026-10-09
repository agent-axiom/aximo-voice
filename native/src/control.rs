//! Only control/status metadata is written here. Audio and transcripts never
//! travel through this IPC directory, except the inference adapter's private
//! temporary WAV, which is deleted when the session ends.
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub const LEASE_TIMEOUT: Duration = Duration::from_secs(5);
pub const STARTUP_GRACE: Duration = Duration::from_secs(10);

pub fn session_path(session: &str) -> Result<PathBuf> {
    let parsed = uuid::Uuid::parse_str(session).context("session must be a canonical UUID")?;
    if parsed.hyphenated().to_string() != session || parsed.is_nil() {
        bail!("session must be a nonzero lowercase canonical UUID");
    }
    Ok(std::env::temp_dir().join(format!("aximo-voice-{session}")))
}

/// A watchdog may close the Windows guard just before terminating the helper.
/// Cleanup is bounded and best-effort; forced process termination can still
/// leave private files. It must only be called after claiming a terminal result.
#[derive(Clone)]
pub struct SessionCleanup {
    path: PathBuf,
    #[cfg(windows)]
    guard: std::sync::Arc<std::sync::Mutex<Option<crate::windows_security::DirectoryGuard>>>,
}

impl SessionCleanup {
    pub fn cleanup(&self) {
        #[cfg(windows)]
        {
            // No live recording-path handle may block normal root removal.
            // Even a poisoned lock must release the guard during cleanup.
            let guard = self
                .guard
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            drop(guard);
            // A concurrent, already-running control command may briefly retain
            // its own guard. Do not make one sharing violation a permanent leak.
            for _ in 0..6 {
                match fs::remove_dir_all(&self.path) {
                    Ok(()) => return,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                    Err(_) => std::thread::sleep(Duration::from_millis(25)),
                }
            }
        }
        #[cfg(not(windows))]
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub struct SessionDir {
    pub path: PathBuf,
    cleanup: SessionCleanup,
}

impl SessionDir {
    pub fn create(session: &str) -> Result<Self> {
        Self::create_at(session_path(session)?)
    }

    fn create_at(path: PathBuf) -> Result<Self> {
        #[cfg(not(windows))]
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        #[cfg(not(windows))]
        builder
            .create(&path)
            .context("cannot create exclusive session directory")?;
        #[cfg(windows)]
        let guard = std::sync::Arc::new(std::sync::Mutex::new(Some(
            crate::windows_security::create_private(&path)?,
        )));
        let cleanup = SessionCleanup {
            path: path.clone(),
            #[cfg(windows)]
            guard,
        };
        let session = Self { path, cleanup };
        validate_dir(&session.path)?;
        session.set_state("loading")?;
        atomic_write(&session.path, "heartbeat", b"alive")?;
        Ok(session)
    }

    pub fn cleanup_handle(&self) -> SessionCleanup {
        self.cleanup.clone()
    }

    pub fn set_state(&self, state: &str) -> Result<()> {
        atomic_write(&self.path, "status", state.as_bytes())
    }

    pub fn cancelled(&self) -> bool {
        self.path.join("cancel").exists()
    }

    pub fn stopped(&self) -> bool {
        self.path.join("stop").exists()
    }
}

impl Drop for SessionDir {
    fn drop(&mut self) {
        self.cleanup.cleanup();
    }
}

pub fn validate_dir(path: &Path) -> Result<()> {
    #[cfg(windows)]
    let _guard = crate::windows_security::open_private(path)?;
    let metadata = fs::symlink_metadata(path).context("session directory is unavailable")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("unsafe session directory");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // geteuid has no preconditions or side effects.
        let uid = unsafe { libc::geteuid() };
        if metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
            bail!("session directory is not private to this user");
        }
    }
    Ok(())
}

pub fn atomic_write(dir: &Path, name: &str, data: &[u8]) -> Result<()> {
    #[cfg(windows)]
    let _guard = crate::windows_security::open_private(dir)?;
    validate_dir(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    file.write_all(data)?;
    file.flush()?;
    file.persist(dir.join(name)).map_err(|error| error.error)?;
    Ok(())
}

pub fn lease_expired(path: &Path, elapsed: Duration) -> bool {
    if elapsed < STARTUP_GRACE {
        return false;
    }
    match fs::metadata(path.join("heartbeat")).and_then(|metadata| metadata.modified()) {
        Ok(modified) => {
            SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default()
                > LEASE_TIMEOUT
        }
        Err(_) => true,
    }
}

pub fn control(session: &str, action: &str) -> Result<Value> {
    if !matches!(action, "status" | "heartbeat" | "stop" | "cancel") {
        bail!("action must be status, heartbeat, stop, or cancel");
    }
    let path = session_path(session)?;
    control_at(&path, action)
}

fn control_at(path: &Path, action: &str) -> Result<Value> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"state": "idle"}));
        }
        Err(error) => return Err(error.into()),
        Ok(_) => validate_dir(path)?,
    }
    #[cfg(windows)]
    let _guard = crate::windows_security::open_private(path)?;
    match action {
        "heartbeat" => atomic_write(path, "heartbeat", b"alive")?,
        "stop" => atomic_write(path, "stop", b"stop")?,
        "cancel" => atomic_write(path, "cancel", b"cancel")?,
        "status" => (),
        _ => bail!("unknown control action"),
    }
    let mut state = String::new();
    match File::open(path.join("status")) {
        Ok(file) => {
            file.take(64).read_to_string(&mut state)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => state.push_str("idle"),
        Err(error) => return Err(error.into()),
    }
    if !matches!(
        state.as_str(),
        "loading" | "recording" | "transcribing" | "idle"
    ) {
        bail!("invalid session status");
    }
    Ok(json!({"state": state}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_canonical_session_ids_are_accepted() {
        for invalid in [
            "../escape",
            "",
            "00000000-0000-0000-0000-000000000000",
            "AAAAAAAA-1111-4111-8111-111111111111",
        ] {
            assert!(session_path(invalid).is_err());
        }
        assert!(session_path("aaaaaaaa-1111-4111-8111-111111111111").is_ok());
    }

    #[test]
    fn record_owns_directory_and_status_never_renews_lease() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("session");
        let session = SessionDir::create_at(path.clone()).unwrap();
        assert!(SessionDir::create_at(path.clone()).is_err());
        let before = fs::metadata(path.join("heartbeat"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(control_at(&path, "status").unwrap()["state"], "loading");
        let after = fs::metadata(path.join("heartbeat"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(control_at(&path, "stop").unwrap()["state"], "loading");
        assert!(session.stopped());
        assert!(!session.cancelled());
        control_at(&path, "cancel").unwrap();
        assert!(session.cancelled());
        drop(session);
        assert!(!path.exists());
        assert_eq!(control_at(&path, "status").unwrap()["state"], "idle");
    }

    #[test]
    fn missing_lease_expires_after_startup_grace() {
        let parent = tempfile::tempdir().unwrap();
        assert!(!lease_expired(parent.path(), Duration::from_secs(1)));
        assert!(lease_expired(parent.path(), Duration::from_secs(11)));
    }

    #[cfg(windows)]
    #[test]
    fn explicit_cleanup_closes_shared_guard_and_is_idempotent() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("session");
        let session = SessionDir::create_at(path.clone()).unwrap();
        fs::write(path.join("synthetic.wav"), b"synthetic test data").unwrap();
        let cleanup = session.cleanup_handle();
        cleanup.cleanup();
        assert!(!path.exists());
        cleanup.cleanup();
        drop(session);
        assert!(!path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_retries_until_concurrent_control_guard_closes() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("session");
        let session = SessionDir::create_at(path.clone()).unwrap();
        let control_guard = crate::windows_security::open_private(&path).unwrap();
        let control = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(75));
            drop(control_guard);
        });
        drop(session);
        control.join().unwrap();
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_nonprivate_directories_are_refused() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let parent = tempfile::tempdir().unwrap();
        let target = parent.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(validate_dir(&target).is_err());
        let link = parent.path().join("link");
        symlink(&target, &link).unwrap();
        assert!(validate_dir(&link).is_err());
    }
}
