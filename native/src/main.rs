use aximo_voice::{audio, control, model_download};

use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use aximo_core::ShortAudioRequest;
use aximo_inference::runtime::{EngineKind, EngineSpec, RuntimeEngineFactory};
use serde_json::{json, Value};

const MAX_WALL_TIME: Duration = Duration::from_secs(175);

fn main() {
    let emitted = Arc::new(AtomicBool::new(false));
    match dispatch(&emitted) {
        Ok(value) => emit(&emitted, value),
        Err(error) => {
            emit(
                &emitted,
                json!({"type": "error", "error": bounded(&format!("{error:#}"), 1000)}),
            );
            std::process::exit(1);
        }
    }
}

fn emit(emitted: &AtomicBool, value: Value) {
    if !emitted.swap(true, Ordering::SeqCst) {
        let mut out = io::stdout().lock();
        let _ = serde_json::to_writer(&mut out, &value);
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

fn bounded(text: &str, limit: usize) -> String {
    text.chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .take(limit)
        .collect()
}

fn dispatch(emitted: &Arc<AtomicBool>) -> Result<Value> {
    let mut args = std::env::args().skip(1);
    let command = args
        .next()
        .context("use record, control, doctor, setup-model, or transcribe-file")?;
    if command == "--version" {
        return Ok(json!({"version": env!("CARGO_PKG_VERSION")}));
    }
    let mut options = BTreeMap::new();
    while let Some(key) = args.next() {
        if !matches!(
            key.as_str(),
            "--session" | "--engine" | "--action" | "--file"
        ) {
            bail!("unknown option {key}");
        }
        let value = args
            .next()
            .with_context(|| format!("missing value for {key}"))?;
        if options.insert(key.clone(), value).is_some() {
            bail!("duplicate option {key}");
        }
    }
    if command == "control" {
        return control::control(
            required(&options, "--session")?,
            required(&options, "--action")?,
        );
    }
    let engine = options
        .get("--engine")
        .map(String::as_str)
        .unwrap_or("parakeet");
    let kind = EngineKind::from_str(engine)?;
    let model = model_path(engine)?;
    match command.as_str() {
        "doctor" => Ok(json!({
            "type": "doctor", "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH,
            "engine": engine, "modelReady": model_download::is_ready(engine, &model),
            "modelPath": model, "captureLimitSeconds": audio::MAX_RECORD_SECONDS,
            "microphoneChecked": false,
        })),
        "setup-model" => {
            model_download::setup(engine, &model)?;
            Ok(json!({"type": "ready", "engine": engine, "modelPath": model}))
        }
        "record" => record(required(&options, "--session")?, kind, model, emitted),
        "transcribe-file" => transcribe_file(required(&options, "--file")?, kind, model, emitted),
        _ => bail!("unknown command; use record, control, doctor, or setup-model"),
    }
}

fn required<'a>(options: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str> {
    options
        .get(key)
        .map(String::as_str)
        .with_context(|| format!("missing {key}"))
}

fn model_path(engine: &str) -> Result<PathBuf> {
    let base =
        directories::BaseDirs::new().context("cannot determine the user's local data directory")?;
    Ok(base
        .data_local_dir()
        .join("aximo-voice")
        .join("models")
        .join(engine))
}

fn record(
    session_id: &str,
    kind: EngineKind,
    model_path: PathBuf,
    emitted: &Arc<AtomicBool>,
) -> Result<Value> {
    let session = control::SessionDir::create(session_id)?;
    // These are changed before CPAL, ONNX, or watchdog threads are started.
    // Aximo's adapter uses tempfile::NamedTempFile; contain it in this 0700 dir.
    std::env::set_var("TMPDIR", &session.path);
    std::env::set_var("TMP", &session.path);
    std::env::set_var("TEMP", &session.path);

    let done = Arc::new(AtomicBool::new(false));
    let cancelled_signal = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        signal_hook::flag::register(signal_hook::consts::SIGTERM, cancelled_signal.clone())?;
        signal_hook::flag::register(signal_hook::consts::SIGINT, cancelled_signal.clone())?;
        signal_hook::flag::register(signal_hook::consts::SIGHUP, cancelled_signal.clone())?;
    }
    let watchdog_path = session.path.clone();
    let watchdog_done = done.clone();
    let watchdog_emitted = emitted.clone();
    let watchdog_signal = cancelled_signal.clone();
    let started = Instant::now();
    thread::spawn(move || {
        while !watchdog_done.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(100));
            if watchdog_done.load(Ordering::Acquire) {
                break;
            }
            let cancelled = watchdog_signal.load(Ordering::Relaxed)
                || watchdog_path.join("cancel").exists()
                || control::lease_expired(&watchdog_path, started.elapsed());
            let timed_out = started.elapsed() > MAX_WALL_TIME;
            if cancelled || timed_out {
                // Native inference is synchronous and cannot be interrupted safely
                // in-process. End this isolated helper, suppressing any transcript.
                let _ = std::fs::remove_dir_all(&watchdog_path);
                if cancelled {
                    emit(&watchdog_emitted, json!({"type": "cancelled"}));
                    std::process::exit(0);
                } else {
                    emit(
                        &watchdog_emitted,
                        json!({"type": "error", "error": "local dictation exceeded its time limit"}),
                    );
                    std::process::exit(1);
                }
            }
        }
    });
    let result = (|| {
        require_model(kind, &model_path)?;
        let engine = RuntimeEngineFactory.build(&EngineSpec { kind, model_path })?;
        if session.cancelled()
            || cancelled_signal.load(Ordering::Relaxed)
            || control::lease_expired(&session.path, started.elapsed())
        {
            return Ok(json!({"type": "cancelled"}));
        }
        if session.stopped() {
            return Ok(json!({"type": "cancelled"}));
        }
        let capture = audio::Capture::start()?;
        session.set_state("recording")?;
        let recording_started = Instant::now();
        while recording_started.elapsed() < Duration::from_secs(audio::MAX_RECORD_SECONDS as u64)
            && !session.stopped()
        {
            if session.cancelled() {
                return Ok(json!({"type": "cancelled"}));
            }
            if capture.failed() {
                bail!("microphone capture failed");
            }
            thread::sleep(Duration::from_millis(50));
        }
        let audio = capture.finish()?;
        session.set_state("transcribing")?;
        let result = engine.transcribe_short(ShortAudioRequest {
            audio_bytes: audio.audio_bytes,
            content_type: audio.content_type.to_owned(),
            engine: Some(kind.as_str().to_owned()),
            language_hint: None,
            timestamps: false,
        })?;
        if session.cancelled()
            || cancelled_signal.load(Ordering::Relaxed)
            || control::lease_expired(&session.path, started.elapsed())
        {
            return Ok(json!({"type": "cancelled"}));
        }
        transcript(&result.text, kind, audio.duration_ms)
    })();
    done.store(true, Ordering::Release);
    result
}

fn require_model(kind: EngineKind, path: &std::path::Path) -> Result<()> {
    if !model_download::is_ready(kind.as_str(), path) {
        bail!(
            "{} model is not installed or incomplete; run /aximo-voice setup {} first",
            kind.as_str(),
            if kind == EngineKind::Gigaam {
                "ru"
            } else {
                "en"
            }
        );
    }
    Ok(())
}

fn transcript(text: &str, kind: EngineKind, duration_ms: u64) -> Result<Value> {
    // Never silently truncate a successful transcription.
    if text.chars().count() > 32_000 {
        bail!("transcript exceeds the output limit");
    }
    Ok(
        json!({"type": "transcript", "text": bounded(text.trim(), 32_000), "engine": kind.as_str(), "durationMs": duration_ms}),
    )
}

/// Explicit local-file inference for reproducible model smoke tests. It never
/// opens a microphone and never truncates a file to fit a limit.
fn transcribe_file(
    file: &str,
    kind: EngineKind,
    model_path: PathBuf,
    emitted: &Arc<AtomicBool>,
) -> Result<Value> {
    const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
    let input = std::fs::File::open(file).context("cannot read the requested WAV file")?;
    let metadata = input.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        bail!("input must be a regular WAV file no larger than 64 MiB");
    }
    let mut bytes = Vec::new();
    input.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        bail!("input grew beyond the 64 MiB file limit");
    }
    let audio = aximo_audio::prepare_short_audio_with_limits(
        &bytes,
        "audio/wav",
        aximo_audio::ShortAudioLimits {
            max_raw_pcm_bytes: 16_000 * audio::MAX_RECORD_SECONDS * 2,
            max_duration_ms: (audio::MAX_RECORD_SECONDS * 1000) as u64,
            max_decoded_samples: 192_000 * audio::MAX_RECORD_SECONDS,
        },
    )?;
    let session = control::SessionDir::create(&uuid::Uuid::new_v4().to_string())?;
    std::env::set_var("TMPDIR", &session.path);
    std::env::set_var("TMP", &session.path);
    std::env::set_var("TEMP", &session.path);
    let done = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        signal_hook::flag::register(signal_hook::consts::SIGTERM, cancelled.clone())?;
        signal_hook::flag::register(signal_hook::consts::SIGINT, cancelled.clone())?;
        signal_hook::flag::register(signal_hook::consts::SIGHUP, cancelled.clone())?;
    }
    let done2 = done.clone();
    let cancelled2 = cancelled.clone();
    let output = emitted.clone();
    let path = session.path.clone();
    thread::spawn(move || {
        let start = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(100));
            if done2.load(Ordering::Acquire) {
                break;
            }
            if cancelled2.load(Ordering::Relaxed) || start.elapsed() > MAX_WALL_TIME {
                let _ = std::fs::remove_dir_all(path);
                emit(
                    &output,
                    json!({"type": "error", "error": "file inference interrupted or timed out"}),
                );
                std::process::exit(1);
            }
        }
    });
    let result = (|| {
        require_model(kind, &model_path)?;
        let engine = RuntimeEngineFactory.build(&EngineSpec { kind, model_path })?;
        session.set_state("transcribing")?;
        let result = engine.transcribe_short(ShortAudioRequest {
            audio_bytes: audio.audio_bytes,
            content_type: audio.content_type.to_owned(),
            engine: Some(kind.as_str().to_owned()),
            language_hint: None,
            timestamps: false,
        })?;
        if cancelled.load(Ordering::Relaxed) {
            bail!("file inference interrupted");
        }
        transcript(&result.text, kind, audio.duration_ms)
    })();
    done.store(true, Ordering::Release);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_output_preserves_unicode_without_controls() {
        assert_eq!(bounded("Привет\0\u{1b}мир", 8), "Приветми");
    }

    #[test]
    fn oversized_transcripts_are_errors_not_partial_success() {
        assert!(transcript(&"a".repeat(32_001), EngineKind::Parakeet, 1).is_err());
        assert_eq!(
            transcript(" Hello ", EngineKind::Parakeet, 10).unwrap()["text"],
            "Hello"
        );
    }
}
