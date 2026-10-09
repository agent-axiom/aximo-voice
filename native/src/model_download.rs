use anyhow::{bail, Context, Result};
use fs2::FileExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
    time::Duration,
};

#[derive(Deserialize)]
struct Model {
    repo: String,
    revision: String,
    files: Vec<ModelFile>,
}
#[derive(Deserialize)]
struct ModelFile {
    name: String,
    source: String,
    size: u64,
    sha256: String,
}

fn manifest() -> Result<BTreeMap<String, Model>> {
    let models: BTreeMap<String, Model> = serde_json::from_str(include_str!("../models.json"))?;
    for model in models.values() {
        if model.revision.len() != 40
            || !model.revision.bytes().all(|b| b.is_ascii_hexdigit())
            || ![
                "istupakov/parakeet-tdt-0.6b-v3-onnx",
                "istupakov/gigaam-v3-onnx",
            ]
            .contains(&model.repo.as_str())
        {
            bail!("invalid pinned model source");
        }
        for item in &model.files {
            if !filename(&item.name)
                || !filename(&item.source)
                || item.size == 0
                || item.size > 1_000_000_000
                || item.sha256.len() != 64
                || !item.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                bail!("invalid pinned model file");
            }
        }
    }
    Ok(models)
}
fn filename(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && !value.starts_with('.')
        && Path::new(value)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.is_file() && !m.file_type().is_symlink())
        .unwrap_or(false)
}
fn verify_file(path: &Path, expected: &ModelFile) -> bool {
    if !regular(path) || fs::metadata(path).map(|m| m.len()).ok() != Some(expected.size) {
        return false;
    }
    File::open(path)
        .and_then(|mut file| digest(&mut file).map(|(_, hash)| hash))
        .map(|hash| hash == expected.sha256)
        .unwrap_or(false)
}
fn digest(reader: &mut impl Read) -> std::io::Result<(u64, String)> {
    let mut sha = Sha256::new();
    let mut bytes = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let count = reader.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        sha.update(&bytes[..count]);
        total += count as u64;
    }
    Ok((total, format!("{:x}", sha.finalize())))
}
pub fn is_ready(engine: &str, target: &Path) -> bool {
    let Ok(models) = manifest() else {
        return false;
    };
    let Some(model) = models.get(engine) else {
        return false;
    };
    if fs::symlink_metadata(target)
        .map(|m| !m.is_dir() || m.file_type().is_symlink())
        .unwrap_or(true)
    {
        return false;
    }
    model
        .files
        .iter()
        .all(|item| verify_file(&target.join(&item.name), item))
}
fn private_dir(path: &Path) -> Result<()> {
    if path.exists() {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            bail!("model storage is not a regular directory");
        }
    } else {
        fs::create_dir_all(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

// No network is reached unless the person explicitly invokes setup-model.
// Pin bytes as well as the model revision; never trust a moving main branch.
pub fn setup(engine: &str, target: &Path) -> Result<()> {
    let models = manifest()?;
    let model = models.get(engine).context("unknown model")?;
    let parent = target.parent().context("missing model parent directory")?;
    private_dir(parent)?;
    let lock_path = parent.join(format!(".setup-{engine}.lock"));
    if fs::symlink_metadata(&lock_path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        bail!("model setup lock is a symlink");
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(lock_path)?;
    lock.try_lock_exclusive()
        .context("another model setup is already running; wait for it to finish")?;
    if is_ready(engine, target) {
        return Ok(());
    }
    if fs::symlink_metadata(target)
        .map(|m| m.file_type().is_symlink() || !m.is_dir())
        .unwrap_or(false)
    {
        bail!("refusing a linked or non-directory model destination");
    }
    let staging = tempfile::Builder::new()
        .prefix(".model-download-")
        .tempdir_in(parent)?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(540))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" || attempt.previous().len() >= 5 {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()?;
    for item in &model.files {
        let url = format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            model.repo, model.revision, item.source
        );
        let mut response = client
            .get(url)
            .send()
            .context("model download failed; check network and retry setup")?
            .error_for_status()?;
        if response.content_length().is_some_and(|n| n != item.size) {
            bail!("model download size differs from the pinned manifest");
        }
        let path = staging.path().join(&item.name);
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        let mut sha = Sha256::new();
        let mut bytes = [0u8; 65536];
        let mut total = 0u64;
        loop {
            let count = response.read(&mut bytes)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > item.size {
                bail!("model download exceeds pinned size");
            }
            file.write_all(&bytes[..count])?;
            sha.update(&bytes[..count]);
        }
        file.sync_all()?;
        if total != item.size || format!("{:x}", sha.finalize()) != item.sha256 {
            bail!("model checksum mismatch; existing model was kept");
        }
    }
    // Download and verify everything first. Retain the previous version until
    // the atomic rename succeeds, and roll it back if final installation fails.
    let backup = parent.join(format!(".model-backup-{}", uuid::Uuid::new_v4()));
    let had_old = target.exists();
    if had_old {
        fs::rename(target, &backup)?;
    }
    if let Err(error) = fs::rename(staging.path(), target) {
        if had_old {
            let _ = fs::rename(&backup, target);
        }
        return Err(error).context("could not install verified model");
    }
    if had_old {
        fs::remove_dir_all(backup)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_has_two_pinned_models() {
        let m = manifest().unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m["parakeet"].files.len(), 4);
        assert_eq!(m["gigaam"].files.len(), 2);
    }
    #[test]
    fn rejects_traversal_names() {
        for p in ["../model", "/model", ".", "a/b", "a\\b", "", ".hidden"] {
            assert!(!filename(p));
        }
        assert!(filename("model.int8.onnx"));
    }
    #[test]
    fn hashes_known_bytes() {
        assert_eq!(
            digest(&mut &b"abc"[..]).unwrap(),
            (
                3,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into()
            )
        );
    }
    #[test]
    fn missing_or_unknown_models_are_not_ready() {
        let d = tempfile::tempdir().unwrap();
        assert!(!is_ready("parakeet", d.path()));
        assert!(!is_ready("other", d.path()));
    }
    #[test]
    fn verifies_size_and_hash() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a");
        fs::write(&p, b"abc").unwrap();
        let mut m = ModelFile {
            name: "a".into(),
            source: "a".into(),
            size: 3,
            sha256: digest(&mut &b"abc"[..]).unwrap().1,
        };
        assert!(verify_file(&p, &m));
        m.size = 2;
        assert!(!verify_file(&p, &m));
        m.size = 3;
        m.sha256 = "0".repeat(64);
        assert!(!verify_file(&p, &m));
    }
    #[cfg(unix)]
    #[test]
    fn refuses_model_file_symlinks() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("a"), b"abc").unwrap();
        symlink(d.path().join("a"), d.path().join("b")).unwrap();
        assert!(!regular(&d.path().join("b")));
    }
}
