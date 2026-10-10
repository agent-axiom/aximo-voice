use anyhow::{bail, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

const CHUNK_BYTES: usize = 65_536;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const MAX_PROGRESS_EVENTS: usize = 4096;
const SPACE_MARGIN: u64 = 16 * 1024 * 1024;
pub const PROGRESS_PROTOCOL: u32 = 1;

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

/// Only setup-model emits these events, and only when explicitly requested.
/// Filenames and engine names come from the bounded, pinned manifest. No URLs,
/// paths, audio, transcripts, or server response bodies are progress fields.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    operation: &'static str,
    protocol: u32,
    engine: &'a str,
    stage: &'static str,
    bytes_completed: u64,
    total_bytes: u64,
    reused_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_total_bytes: Option<u64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SetupOutcome {
    Ready,
    Cancelled,
}

#[derive(Debug)]
struct Cancelled;
impl std::fmt::Display for Cancelled {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("model setup cancelled")
    }
}
impl std::error::Error for Cancelled {}

struct SetupContext<'a> {
    engine: &'a str,
    total: u64,
    completed: u64,
    reused: u64,
    cancelled: &'a dyn Fn() -> bool,
    emit: &'a mut dyn FnMut(Progress<'_>) -> Result<()>,
    last_event: Option<Instant>,
    event_count: usize,
}

impl SetupContext<'_> {
    fn check(&self) -> Result<()> {
        if (self.cancelled)() {
            return Err(Cancelled.into());
        }
        Ok(())
    }

    fn progress(
        &mut self,
        stage: &'static str,
        item: Option<&ModelFile>,
        file_bytes: u64,
        force: bool,
    ) -> Result<()> {
        self.check()?;
        if self.event_count >= MAX_PROGRESS_EVENTS
            || (!force
                && self
                    .last_event
                    .is_some_and(|last| last.elapsed() < PROGRESS_INTERVAL))
        {
            return Ok(());
        }
        (self.emit)(Progress {
            kind: "progress",
            operation: "setup-model",
            protocol: PROGRESS_PROTOCOL,
            engine: self.engine,
            stage,
            bytes_completed: self.completed
                + if stage == "downloading" {
                    file_bytes
                } else {
                    0
                },
            total_bytes: self.total,
            reused_bytes: self.reused,
            file: item.map(|item| item.name.as_str()),
            file_bytes: item.map(|_| file_bytes),
            file_total_bytes: item.map(|item| item.size),
        })?;
        self.event_count += 1;
        self.last_event = Some(Instant::now());
        Ok(())
    }
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
            || model.files.is_empty()
            || model.files.len() > 8
        {
            bail!("invalid pinned model source");
        }
        let mut names = std::collections::BTreeSet::new();
        for item in &model.files {
            if !filename(&item.name)
                || !filename(&item.source)
                || !names.insert(&item.name)
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
        && value.len() <= 128
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
    let mut bytes = [0u8; CHUNK_BYTES];
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
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
            bail!("model storage is not a regular directory");
        }
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn verify_cancellable(
    path: &Path,
    expected: &ModelFile,
    context: &mut SetupContext<'_>,
) -> Result<bool> {
    context.check()?;
    if !regular(path) || fs::metadata(path)?.len() != expected.size {
        return Ok(false);
    }
    context.progress("verifying", Some(expected), 0, true)?;
    let mut file = File::open(path)?;
    let mut sha = Sha256::new();
    let mut bytes = [0u8; CHUNK_BYTES];
    let mut total = 0;
    loop {
        context.check()?;
        let count = file.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > expected.size {
            return Ok(false);
        }
        sha.update(&bytes[..count]);
        context.progress("verifying", Some(expected), total, false)?;
    }
    context.check()?;
    Ok(total == expected.size && format!("{:x}", sha.finalize()) == expected.sha256)
}

// The network worker never owns a file or install state. A bounded channel
// keeps setup responsive to cancellation even during DNS, TLS, or a stalled
// response read. Dropping the receiver stops it at the next send; the isolated
// CLI process exits without waiting for an outstanding network read.
enum DownloadMessage {
    Chunk(Vec<u8>),
    Done,
    Error(anyhow::Error),
}
type Download = Receiver<DownloadMessage>;

fn network_download(model: &Model, item: &ModelFile) -> Result<Download> {
    let url = format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        model.repo, model.revision, item.source
    );
    let expected_size = item.size;
    let (sender, receiver) = mpsc::sync_channel(2);
    thread::Builder::new()
        .name("model-download".into())
        .spawn(move || {
            let result = (|| -> Result<()> {
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
                let mut response = client
                    .get(url)
                    .send()
                    .context("model download failed; check network and retry setup")?
                    .error_for_status()?;
                if response
                    .content_length()
                    .is_some_and(|n| n != expected_size)
                {
                    bail!("model download size differs from the pinned manifest");
                }
                let mut bytes = [0u8; CHUNK_BYTES];
                loop {
                    let count = response.read(&mut bytes)?;
                    if count == 0 {
                        let _ = sender.send(DownloadMessage::Done);
                        return Ok(());
                    }
                    if sender
                        .send(DownloadMessage::Chunk(bytes[..count].to_vec()))
                        .is_err()
                    {
                        return Ok(());
                    }
                }
            })();
            if let Err(error) = result {
                let _ = sender.send(DownloadMessage::Error(error));
            }
        })?;
    Ok(receiver)
}

fn receive_file(
    receiver: Download,
    item: &ModelFile,
    file: &mut File,
    context: &mut SetupContext<'_>,
) -> Result<()> {
    let mut total = 0u64;
    context.progress("downloading", Some(item), 0, true)?;
    loop {
        context.check()?;
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(DownloadMessage::Chunk(bytes)) => {
                total += bytes.len() as u64;
                if total > item.size {
                    bail!("model download exceeds pinned size");
                }
                file.write_all(&bytes)?;
                context.progress("downloading", Some(item), total, false)?;
            }
            Ok(DownloadMessage::Done) => break,
            Ok(DownloadMessage::Error(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => bail!("model download ended unexpectedly"),
        }
    }
    if total != item.size {
        bail!("model download is incomplete; retry setup to download this file again");
    }
    context.progress("downloading", Some(item), total, true)?;
    context.completed += item.size;
    file.sync_all()?;
    context.check()
}

fn enough_space(available: u64, missing: u64) -> Result<()> {
    let required = missing.saturating_add(SPACE_MARGIN);
    if available < required {
        bail!(
            "not enough free space for model setup: need {required} bytes ({missing} download + {SPACE_MARGIN} safety margin), available {available} bytes; free space and retry"
        );
    }
    Ok(())
}

fn validate_destination(target: &Path) -> Result<()> {
    if fs::symlink_metadata(target)
        .map(|m| m.file_type().is_symlink() || !m.is_dir())
        .unwrap_or(false)
    {
        bail!("refusing a linked or non-directory model destination");
    }
    Ok(())
}

fn install_model(
    model: &Model,
    target: &Path,
    context: &mut SetupContext<'_>,
    download: &mut impl FnMut(&ModelFile) -> Result<Download>,
    available_space: &impl Fn(&Path) -> Result<u64>,
) -> Result<()> {
    context.check()?;
    let parent = target.parent().context("missing model parent directory")?;
    private_dir(parent)?;
    let lock_path = parent.join(format!(".setup-{}.lock", context.engine));
    if fs::symlink_metadata(&lock_path)
        .map(|m| !m.is_file() || m.file_type().is_symlink())
        .unwrap_or(false)
    {
        bail!("model setup lock is not a regular file");
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let lock = options.open(lock_path)?;
    lock.try_lock_exclusive()
        .context("another model setup is already running; wait for it to finish")?;
    validate_destination(target)?;
    let backup = parent.join(format!(".model-backup-{}", context.engine));
    validate_destination(&backup)?;
    // Recover an interrupted two-rename commit before doing any new work.
    if backup.exists() && !target.exists() {
        fs::rename(&backup, target).context("could not restore previous model")?;
    }
    context.progress("checking", None, 0, true)?;
    let mut ready = target.exists();
    if ready {
        for item in &model.files {
            if !verify_cancellable(&target.join(&item.name), item, context)? {
                ready = false;
                break;
            }
        }
    }
    if ready {
        context.completed = context.total;
        context.reused = context.total;
        context.progress("checking", None, 0, true)?;
        // A backup can remain if the last process exited after its commit.
        if backup.exists() {
            let _ = fs::remove_dir_all(&backup);
        }
        return Ok(());
    }
    if backup.exists() {
        bail!("previous model backup is still present; refusing to replace it");
    }

    // Keep only completely downloaded, hash-verified files across retries.
    // A revision-specific cache prevents confusion between pinned manifests.
    let staging = parent.join(format!(
        ".model-download-{}-{}",
        context.engine, model.revision
    ));
    private_dir(&staging)?;
    for entry in fs::read_dir(&staging)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !regular(&entry.path()) {
            bail!("model download cache contains a linked or non-regular file");
        }
        if name.starts_with(".partial-") {
            fs::remove_file(entry.path())?;
        } else if !model.files.iter().any(|item| item.name == name.as_ref()) {
            bail!("model download cache contains an unexpected file");
        }
    }
    let mut cached = Vec::new();
    for item in &model.files {
        let path = staging.join(&item.name);
        let verified = verify_cancellable(&path, item, context)?;
        if verified {
            context.reused += item.size;
            context.completed += item.size;
            context.progress("checking", Some(item), item.size, true)?;
        } else if path.exists() {
            fs::remove_file(path)?;
        }
        cached.push(verified);
    }
    enough_space(
        available_space(parent).context("cannot determine free space in model storage")?,
        context.total - context.reused,
    )?;
    for (item, cached) in model.files.iter().zip(cached) {
        if cached {
            continue;
        }
        context.check()?;
        let mut partial = tempfile::Builder::new()
            .prefix(".partial-")
            .tempfile_in(&staging)?;
        receive_file(download(item)?, item, partial.as_file_mut(), context)?;
        if !verify_cancellable(partial.path(), item, context)? {
            bail!("model checksum mismatch; existing model was kept; retry setup");
        }
        context.check()?;
        partial
            .persist_noclobber(staging.join(&item.name))
            .map_err(|error| error.error)
            .context("could not retain verified model file for retry")?;
    }
    context.progress("installing", None, 0, true)?;
    context.check()?;
    // Cancellation is cooperative: once this short commit begins, finish or
    // roll it back before returning. Never interrupt between the two renames.
    let had_old = target.exists();
    if had_old {
        fs::rename(target, &backup).context("could not preserve previous model")?;
    }
    if let Err(error) = fs::rename(&staging, target) {
        if had_old {
            fs::rename(&backup, target)
                .context("could not restore previous model; retained in model backup directory")?;
        }
        return Err(error).context("could not install verified model; previous model was kept");
    }
    if had_old {
        // The new model is committed. Backup cleanup is not an install error;
        // a later setup can safely retry it after verifying the active model.
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

// No network is reached unless the person explicitly invokes setup-model.
// Pin bytes as well as the model revision; never trust a moving main branch.
pub fn setup(engine: &str, target: &Path) -> Result<()> {
    setup_with_progress(engine, target, &|| false, &mut |_| Ok(()))?;
    Ok(())
}

pub fn setup_with_progress(
    engine: &str,
    target: &Path,
    cancelled: &dyn Fn() -> bool,
    emit: &mut dyn FnMut(Progress<'_>) -> Result<()>,
) -> Result<SetupOutcome> {
    let models = manifest()?;
    let model = models.get(engine).context("unknown model")?;
    let mut context = SetupContext {
        engine,
        total: model.files.iter().map(|item| item.size).sum(),
        completed: 0,
        reused: 0,
        cancelled,
        emit,
        last_event: None,
        event_count: 0,
    };
    match install_model(
        model,
        target,
        &mut context,
        &mut |item| network_download(model, item),
        &|path| Ok(fs2::available_space(path)?),
    ) {
        Ok(()) => Ok(SetupOutcome::Ready),
        Err(error) if error.is::<Cancelled>() => Ok(SetupOutcome::Cancelled),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn item(name: &str, bytes: &[u8]) -> ModelFile {
        ModelFile {
            name: name.into(),
            source: name.into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    fn fixture() -> Model {
        Model {
            repo: "fixture".into(),
            revision: "a".repeat(40),
            files: vec![item("a.onnx", b"abc"), item("b.onnx", b"def")],
        }
    }

    fn download(bytes: &[u8]) -> Download {
        let (sender, receiver) = mpsc::sync_channel(2);
        sender.send(DownloadMessage::Chunk(bytes.to_vec())).unwrap();
        sender.send(DownloadMessage::Done).unwrap();
        receiver
    }

    fn run_fixture(
        model: &Model,
        target: &Path,
        cancelled: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(Progress<'_>) -> Result<()>,
        download: &mut impl FnMut(&ModelFile) -> Result<Download>,
        space: u64,
    ) -> Result<()> {
        let mut context = SetupContext {
            engine: "fixture",
            total: model.files.iter().map(|item| item.size).sum(),
            completed: 0,
            reused: 0,
            cancelled,
            emit,
            last_event: None,
            event_count: 0,
        };
        install_model(model, target, &mut context, download, &|_| Ok(space))
    }

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
        assert!(!filename(&"a".repeat(129)));
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
        let mut m = item("a", b"abc");
        assert!(verify_file(&p, &m));
        m.size = 2;
        assert!(!verify_file(&p, &m));
        m.size = 3;
        m.sha256 = "0".repeat(64);
        assert!(!verify_file(&p, &m));
    }

    #[test]
    fn retry_reuses_only_fully_verified_files_and_keeps_old_model() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("model");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("old.onnx"), b"old verified model").unwrap();
        let model = fixture();
        let error = run_fixture(
            &model,
            &target,
            &|| false,
            &mut |_| Ok(()),
            &mut |file| {
                if file.name == "a.onnx" {
                    Ok(download(b"abc"))
                } else {
                    bail!("simulated network outage")
                }
            },
            u64::MAX,
        )
        .unwrap_err();
        assert!(error.to_string().contains("network outage"));
        assert_eq!(
            fs::read(target.join("old.onnx")).unwrap(),
            b"old verified model"
        );
        let fetched = RefCell::new(Vec::new());
        let events = RefCell::new(Vec::new());
        run_fixture(
            &model,
            &target,
            &|| false,
            &mut |event| {
                events.borrow_mut().push(serde_json::to_value(event)?);
                Ok(())
            },
            &mut |file| {
                fetched.borrow_mut().push(file.name.clone());
                Ok(download(b"def"))
            },
            u64::MAX,
        )
        .unwrap();
        assert_eq!(*fetched.borrow(), vec!["b.onnx"]);
        assert!(model
            .files
            .iter()
            .all(|file| verify_file(&target.join(&file.name), file)));
        assert!(events
            .borrow()
            .iter()
            .any(|event| event["reusedBytes"] == 3));
        let bytes: Vec<_> = events
            .borrow()
            .iter()
            .map(|event| event["bytesCompleted"].as_u64().unwrap())
            .collect();
        assert!(bytes.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn checksum_mismatch_never_replaces_old_model_or_keeps_bad_file() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("model");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("old"), b"working").unwrap();
        let model = fixture();
        let error = run_fixture(
            &model,
            &target,
            &|| false,
            &mut |_| Ok(()),
            &mut |_| Ok(download(b"bad")),
            u64::MAX,
        )
        .unwrap_err();
        assert!(error.to_string().contains("checksum mismatch"));
        assert_eq!(fs::read(target.join("old")).unwrap(), b"working");
        let cache = d
            .path()
            .join(format!(".model-download-fixture-{}", model.revision));
        assert_eq!(fs::read_dir(cache).unwrap().count(), 0);
    }

    #[test]
    fn cancel_mid_file_removes_partial_and_preserves_verified_cache() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("model");
        let model = fixture();
        let cancelled = Cell::new(false);
        let error = run_fixture(
            &model,
            &target,
            &|| cancelled.get(),
            &mut |event| {
                if event.stage == "downloading" && event.file == Some("b.onnx") {
                    cancelled.set(true);
                }
                Ok(())
            },
            &mut |file| {
                Ok(download(if file.name == "a.onnx" {
                    b"abc"
                } else {
                    b"def"
                }))
            },
            u64::MAX,
        )
        .unwrap_err();
        assert!(error.is::<Cancelled>());
        assert!(!target.exists());
        let cache = d
            .path()
            .join(format!(".model-download-fixture-{}", model.revision));
        assert!(verify_file(&cache.join("a.onnx"), &model.files[0]));
        assert_eq!(fs::read_dir(cache).unwrap().count(), 1);
    }

    #[test]
    fn stalled_download_is_cancellable_without_network_timeout() {
        let d = tempfile::tempdir().unwrap();
        let model = fixture();
        let started = Instant::now();
        let (sender, receiver) = mpsc::sync_channel(2);
        let mut receiver = Some(receiver);
        let result = run_fixture(
            &model,
            &d.path().join("model"),
            &|| started.elapsed() > Duration::from_millis(150),
            &mut |_| Ok(()),
            &mut |_| Ok(receiver.take().unwrap()),
            u64::MAX,
        );
        drop(sender);
        assert!(result.unwrap_err().is::<Cancelled>());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn insufficient_space_fails_before_network_and_reports_bytes() {
        let d = tempfile::tempdir().unwrap();
        let error = run_fixture(
            &fixture(),
            &d.path().join("model"),
            &|| false,
            &mut |_| Ok(()),
            &mut |_| panic!("must not download"),
            1,
        )
        .unwrap_err();
        assert!(error.to_string().contains("not enough free space"));
        assert!(error.to_string().contains("available 1 bytes"));
    }

    #[test]
    fn stale_complete_cache_is_rehashed_and_partial_is_not_resumed() {
        let d = tempfile::tempdir().unwrap();
        let model = fixture();
        let cache = d
            .path()
            .join(format!(".model-download-fixture-{}", model.revision));
        fs::create_dir(&cache).unwrap();
        fs::write(cache.join("a.onnx"), b"bad").unwrap();
        fs::write(cache.join(".partial-old"), b"a").unwrap();
        let fetched = Cell::new(0);
        run_fixture(
            &model,
            &d.path().join("model"),
            &|| false,
            &mut |_| Ok(()),
            &mut |file| {
                fetched.set(fetched.get() + 1);
                Ok(download(if file.name == "a.onnx" {
                    b"abc"
                } else {
                    b"def"
                }))
            },
            u64::MAX,
        )
        .unwrap();
        assert_eq!(fetched.get(), 2);
        assert!(!cache.exists());
    }

    #[test]
    fn ready_model_requires_no_free_space_or_download() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("model");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("a.onnx"), b"abc").unwrap();
        fs::write(target.join("b.onnx"), b"def").unwrap();
        run_fixture(
            &fixture(),
            &target,
            &|| false,
            &mut |_| Ok(()),
            &mut |_| panic!("already ready"),
            0,
        )
        .unwrap();
    }

    #[test]
    fn interrupted_commit_restores_old_model_before_retry_error() {
        let d = tempfile::tempdir().unwrap();
        let backup = d.path().join(".model-backup-fixture");
        fs::create_dir(&backup).unwrap();
        fs::write(backup.join("old"), b"working").unwrap();
        let target = d.path().join("model");
        assert!(run_fixture(
            &fixture(),
            &target,
            &|| false,
            &mut |_| Ok(()),
            &mut |_| bail!("offline"),
            u64::MAX,
        )
        .is_err());
        assert_eq!(fs::read(target.join("old")).unwrap(), b"working");
        assert!(!backup.exists());
    }

    #[test]
    fn failed_commit_rolls_back_old_model() {
        let d = tempfile::tempdir().unwrap();
        let model = fixture();
        let target = d.path().join("model");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("old"), b"working").unwrap();
        let cache = d
            .path()
            .join(format!(".model-download-fixture-{}", model.revision));
        let error = run_fixture(
            &model,
            &target,
            &|| false,
            &mut |event| {
                if event.stage == "installing" {
                    // Simulate a filesystem failure after all files verify.
                    fs::remove_dir_all(&cache)?;
                }
                Ok(())
            },
            &mut |file| {
                Ok(download(if file.name == "a.onnx" {
                    b"abc"
                } else {
                    b"def"
                }))
            },
            u64::MAX,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("could not install verified model"));
        assert_eq!(fs::read(target.join("old")).unwrap(), b"working");
        assert!(!d.path().join(".model-backup-fixture").exists());
    }

    #[test]
    fn cancel_before_commit_keeps_old_model_and_verified_retry_files() {
        let d = tempfile::tempdir().unwrap();
        let model = fixture();
        let target = d.path().join("model");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("old"), b"working").unwrap();
        let cancelled = Cell::new(false);
        let error = run_fixture(
            &model,
            &target,
            &|| cancelled.get(),
            &mut |event| {
                if event.stage == "installing" {
                    cancelled.set(true);
                }
                Ok(())
            },
            &mut |file| {
                Ok(download(if file.name == "a.onnx" {
                    b"abc"
                } else {
                    b"def"
                }))
            },
            u64::MAX,
        )
        .unwrap_err();
        assert!(error.is::<Cancelled>());
        assert_eq!(fs::read(target.join("old")).unwrap(), b"working");
        run_fixture(
            &model,
            &target,
            &|| false,
            &mut |_| Ok(()),
            &mut |_| panic!("all retry files should be verified"),
            SPACE_MARGIN,
        )
        .unwrap();
        assert!(model
            .files
            .iter()
            .all(|file| verify_file(&target.join(&file.name), file)));
    }

    #[test]
    fn progress_events_are_bounded_and_json_safe() {
        let events = RefCell::new(Vec::new());
        let mut emit = |event: Progress<'_>| {
            events.borrow_mut().push(serde_json::to_string(&event)?);
            Ok(())
        };
        let mut context = SetupContext {
            engine: "fixture",
            total: 6,
            completed: 0,
            reused: 0,
            cancelled: &|| false,
            emit: &mut emit,
            last_event: None,
            event_count: 0,
        };
        for _ in 0..MAX_PROGRESS_EVENTS + 50 {
            context.progress("checking", None, 0, true).unwrap();
        }
        assert_eq!(events.borrow().len(), MAX_PROGRESS_EVENTS);
        assert!(events
            .borrow()
            .iter()
            .all(|line| line.len() < 1024 && !line.contains('\n')));
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

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_retry_cache() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let model = fixture();
        symlink(
            elsewhere.path(),
            d.path()
                .join(format!(".model-download-fixture-{}", model.revision)),
        )
        .unwrap();
        assert!(run_fixture(
            &model,
            &d.path().join("model"),
            &|| false,
            &mut |_| Ok(()),
            &mut |_| panic!("must not download"),
            u64::MAX,
        )
        .is_err());
    }
}
