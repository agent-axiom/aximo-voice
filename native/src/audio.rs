use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use anyhow::{bail, Context, Result};
use aximo_audio::{prepare_short_audio_with_limits, PreparedAudio, ShortAudioLimits};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub const MAX_RECORD_SECONDS: usize = 60;
const MAX_RATE: u32 = 192_000;
const MAX_CHANNELS: u16 = 32;

pub struct Capture {
    // Keep the stream alive until capture finishes; dropping it stops the mic.
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    failed: Arc<AtomicBool>,
    sample_rate: u32,
}

impl Capture {
    pub fn start() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .context("no default microphone is available")?;
        let supported = device
            .default_input_config()
            .context("microphone configuration is unavailable; check microphone permission")?;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        validate_format(config.sample_rate.0, config.channels)?;
        let samples = Arc::new(Mutex::new(Vec::with_capacity(
            config.sample_rate.0 as usize * MAX_RECORD_SECONDS,
        )));
        let failed = Arc::new(AtomicBool::new(false));
        let stream = match format {
            cpal::SampleFormat::F32 => {
                build::<f32>(&device, &config, samples.clone(), failed.clone())
            }
            cpal::SampleFormat::I16 => {
                build::<i16>(&device, &config, samples.clone(), failed.clone())
            }
            cpal::SampleFormat::U16 => {
                build::<u16>(&device, &config, samples.clone(), failed.clone())
            }
            cpal::SampleFormat::I8 => {
                build::<i8>(&device, &config, samples.clone(), failed.clone())
            }
            cpal::SampleFormat::U8 => {
                build::<u8>(&device, &config, samples.clone(), failed.clone())
            }
            cpal::SampleFormat::I32 => {
                build::<i32>(&device, &config, samples.clone(), failed.clone())
            }
            cpal::SampleFormat::U32 => {
                build::<u32>(&device, &config, samples.clone(), failed.clone())
            }
            cpal::SampleFormat::F64 => {
                build::<f64>(&device, &config, samples.clone(), failed.clone())
            }
            _ => bail!("unsupported microphone sample format"),
        }
        .context("cannot open microphone; allow microphone access for the terminal")?;
        stream.play().context("cannot start microphone capture")?;
        Ok(Self {
            stream,
            samples,
            failed,
            sample_rate: config.sample_rate.0,
        })
    }

    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Relaxed)
    }

    pub fn finish(self) -> Result<PreparedAudio> {
        drop(self.stream);
        if self.failed.load(Ordering::Relaxed) {
            bail!("microphone capture failed");
        }
        let samples = self
            .samples
            .lock()
            .map_err(|_| anyhow::anyhow!("audio buffer unavailable"))?;
        if samples.len() < (self.sample_rate / 10) as usize {
            bail!("recording is too short; hold the microphone for at least a moment");
        }
        normalize(&samples, self.sample_rate)
    }
}

fn validate_format(sample_rate: u32, channels: u16) -> Result<()> {
    if sample_rate == 0 || sample_rate > MAX_RATE || channels == 0 || channels > MAX_CHANNELS {
        bail!("unsupported microphone rate or channel count");
    }
    Ok(())
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    samples: Arc<Mutex<Vec<f32>>>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = usize::from(config.channels);
    let capacity = config.sample_rate.0 as usize * MAX_RECORD_SECONDS;
    device.build_input_stream(
        config,
        move |input: &[T], _| {
            if let Ok(mut output) = samples.try_lock() {
                append_frames(&mut output, input, channels, capacity);
            }
        },
        move |_| {
            failed.store(true, Ordering::Relaxed);
        },
        None,
    )
}

fn append_frames<T>(output: &mut Vec<f32>, input: &[T], channels: usize, capacity: usize)
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    for frame in input.chunks_exact(channels) {
        if output.len() >= capacity {
            break;
        }
        let sum: f32 = frame
            .iter()
            .map(|sample| {
                let value: f32 = (*sample).to_sample();
                if value.is_finite() {
                    value.clamp(-1.0, 1.0)
                } else {
                    0.0
                }
            })
            .sum();
        output.push(sum / channels as f32);
    }
}

fn normalize(samples: &[f32], sample_rate: u32) -> Result<PreparedAudio> {
    validate_format(sample_rate, 1)?;
    if samples.len() > sample_rate as usize * MAX_RECORD_SECONDS {
        bail!("audio exceeds the recording limit");
    }
    let mut wav = Cursor::new(Vec::with_capacity(samples.len() * 4 + 64));
    {
        let mut writer = hound::WavWriter::new(
            &mut wav,
            hound::WavSpec {
                channels: 1,
                sample_rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )?;
        for sample in samples {
            writer.write_sample(*sample)?;
        }
        writer.finalize()?;
    }
    // Aximo's windowed-sinc resampler yields mono, 16 kHz signed 16-bit PCM.
    Ok(prepare_short_audio_with_limits(
        &wav.into_inner(),
        "audio/wav",
        ShortAudioLimits {
            max_raw_pcm_bytes: 16_000 * MAX_RECORD_SECONDS * 2,
            max_duration_ms: (MAX_RECORD_SECONDS * 1000) as u64,
            max_decoded_samples: MAX_RATE as usize * MAX_RECORD_SECONDS,
        },
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_and_channels_are_bounded() {
        assert!(validate_format(48_000, 2).is_ok());
        for (rate, channels) in [(0, 1), (48_000, 0), (192_001, 1), (48_000, 33)] {
            assert!(validate_format(rate, channels).is_err());
        }
    }

    #[test]
    fn capture_downmixes_sanitizes_and_never_exceeds_capacity() {
        let mut samples = Vec::new();
        append_frames(&mut samples, &[1.0f32, -1.0, f32::NAN, 2.0, 0.2, 0.2], 2, 2);
        assert_eq!(samples, [0.0, 0.5]);
        append_frames(&mut samples, &[0.1f32; 16], 1, 2);
        assert_eq!(samples.len(), 2);
    }

    #[test]
    fn signed_integer_capture_uses_full_sample_scale() {
        let mut samples = Vec::new();
        append_frames(&mut samples, &[i16::MIN, 0, i16::MAX], 1, 3);
        assert_eq!(samples[0], -1.0);
        assert_eq!(samples[1], 0.0);
        assert!(samples[2] > 0.99 && samples[2] <= 1.0);
    }

    #[test]
    fn audio_is_normalized_using_aximo() {
        let prepared = normalize(&vec![0.0; 48_000], 48_000).unwrap();
        assert_eq!(prepared.content_type, "audio/pcm");
        assert_eq!(prepared.duration_ms, 1000);
        assert_eq!(prepared.audio_bytes.len(), 32_000);
    }

    #[test]
    fn oversized_capture_is_rejected_before_encoding() {
        assert!(normalize(&vec![0.0; 61], 1).is_err());
    }
}
