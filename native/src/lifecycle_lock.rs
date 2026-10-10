//! Coordinate package changes with capture, inference and model setup.
use anyhow::{bail, Context, Result};
use fs2::FileExt;
use std::{fs::{self, File, OpenOptions}, path::PathBuf};

pub fn data_dir() -> Result<PathBuf> {
    let path = directories::BaseDirs::new().context("cannot determine local data directory")?
        .data_local_dir().join("aximo-voice");
    if !path.exists() {
        #[cfg(unix)] {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).recursive(true).create(&path)?;
        }
        #[cfg(not(unix))] fs::create_dir_all(&path)?;
    }
    let meta = fs::symlink_metadata(&path)?;
    if !meta.is_dir() || meta.file_type().is_symlink() { bail!("Aximo data directory must be a regular private directory"); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 {
            bail!("Aximo data directory must be owned by this user and not writable by others");
        }
        // Migrate read-only 0755 directories created by the source preview.
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}
fn open() -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let path = data_dir()?.join(".lifecycle.lock");
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) { bail!("unsafe lifecycle lock"); }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() { bail!("unsafe lifecycle lock"); }
    Ok(file)
}
pub fn shared() -> Result<File> {
    let file = open()?;
    FileExt::try_lock_shared(&file).context("Aximo setup/update/uninstall is running; retry when it finishes")?;
    Ok(file)
}
pub fn exclusive() -> Result<File> {
    let file = open()?;
    file.try_lock_exclusive().context("Aximo is recording, transcribing, downloading, or updating; finish/cancel it and retry")?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_capture_prevents_update() {
        let d = tempfile::tempdir().unwrap();
        let a = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(d.path().join("lock")).unwrap();
        let b = OpenOptions::new().read(true).write(true).open(d.path().join("lock")).unwrap();
        FileExt::try_lock_shared(&a).unwrap();
        assert!(b.try_lock_exclusive().is_err());
        FileExt::unlock(&a).unwrap();
        b.try_lock_exclusive().unwrap();
        assert!(FileExt::try_lock_shared(&a).is_err());
    }
}
