//! System-audio capability: Core Audio process taps (macOS 14.2+).
//!
//! Rust owns the capability only — whether this machine can tap system audio,
//! and whether a tap actually delivers it. Deciding that a meeting started,
//! what to record and what the audio becomes is policy in `@reflect/core`
//! (docs/plans/25-meeting-notes.md).
//!
//! Taps are the right primitive here rather than ScreenCaptureKit: the entry
//! points are plain C, where `SCStream` would need an Objective-C protocol
//! implementation to receive sample buffers, and a tap can be scoped to the
//! processes in a call instead of mixing in every other sound on the machine.
//!
//! **The whole surface lies on failure.** Every tap call returns `noErr` even
//! when the user denied "Screen & System Audio Recording" or the binary has
//! no stable code-signing identity; the tap is created, the `IOProc` fires,
//! and every delivered sample is digital zero. Silence is therefore not
//! evidence of a quiet room, which is why {@link recording_system_audio_preflight}
//! exists: it runs a throwaway tap and reports whether the samples were
//! silent *while the default output device was rendering for someone* — the
//! only observable signature of a denial.

use serde::Serialize;

use crate::error::AppResult;

/// What a throwaway tap observed. A discriminated union so the TypeScript
/// side branches on `kind` rather than parsing prose.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SystemAudioPreflight {
    /// Non-silent samples arrived: system audio works on this machine.
    Granted,
    /// Every sample was zero while the default output device was rendering
    /// for some process — consent is missing or the signature is unstable.
    SilentWhilePlaying,
    /// Nothing was playing, so silence proves nothing. Ask again with audio.
    Inconclusive,
    /// This macOS predates process taps (14.2), or the platform has none.
    Unsupported,
    /// A Core Audio call refused outright — the rare honest failure.
    Failed { message: String },
}

/// Whether this machine can tap system audio at all. Cheap and side-effect
/// free: it only checks that the API exists, never that it is permitted.
#[tauri::command]
pub fn recording_system_audio_supported() -> AppResult<bool> {
    Ok(platform::supported())
}

/// Has the user already granted "Screen & System Audio Recording"? Never
/// prompts — this is the state to render, not the ask.
#[tauri::command]
pub fn recording_system_audio_access_granted() -> AppResult<bool> {
    Ok(platform::access_granted())
}

/// Trigger the macOS permission prompt and resolve with whether capture is
/// now allowed. The OS prompts **once ever** per app identity: after a
/// refusal this returns `false` immediately and the only way back is
/// System Settings → Privacy & Security → Screen & System Audio Recording.
/// Same posture as the calendar's `calendar_request_access`.
#[tauri::command]
pub async fn recording_request_system_audio_access() -> AppResult<bool> {
    Ok(
        tauri::async_runtime::spawn_blocking(platform::request_access)
            .await
            .unwrap_or(false),
    )
}

/// Run a tap for `duration_ms` and classify what it delivered. Caller-facing
/// guidance belongs to the UI: `silentWhilePlaying` means "grant the
/// permission", `inconclusive` means "play something and try again".
#[tauri::command]
pub async fn recording_system_audio_preflight(duration_ms: u64) -> AppResult<SystemAudioPreflight> {
    let clamped = duration_ms.clamp(200, 10_000);
    Ok(tauri::async_runtime::spawn_blocking(move || platform::preflight(clamped))
        .await
        .unwrap_or_else(|err| SystemAudioPreflight::Failed {
            message: format!("preflight task failed: {err}"),
        }))
}

/// One finished segment, announced as `recording:segment` the moment its file
/// is closed and complete. The payload is deliberately placeless: Rust writes
/// into a staging directory and says what it wrote, and `@reflect/core`
/// decides where in the graph it belongs — the same split
/// `audio_memo_import` already serves for the iOS recorder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSegment {
    /// 1-based position in the session.
    pub part: u32,
    /// The last segment of a cleanly stopped session.
    pub end: bool,
    /// `system` (what the meeting played) or `mic` (what the user said).
    pub track: &'static str,
    /// Absolute path of the finished file, in the staging directory.
    pub path: String,
    pub frames: u64,
    pub rate: u32,
}

/// What a started session reports back, so the caller can describe it without
/// waiting for the first segment.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStarted {
    pub staging_dir: String,
    pub system_rate: u32,
    pub mic_rate: u32,
    /// The input the microphone half opened, for the "recording from…" line.
    pub mic_device: String,
}

/// Start capturing the meeting: system audio and the microphone as two
/// tracks, rotated every `segment_ms`. Fails loudly when a session is
/// already running — a second recorder would fight the first for the device.
#[tauri::command]
pub async fn recording_start(
    app: tauri::AppHandle,
    segment_ms: u64,
    state: tauri::State<'_, RecordingState>,
) -> AppResult<RecordingStarted> {
    platform::start(app, segment_ms.max(5_000), state)
}

/// Stop the session, closing the final segment with `end: true`. Idempotent:
/// stopping a session that already ended is not an error, because the UI and
/// a meeting ending can race.
#[tauri::command]
pub async fn recording_stop(state: tauri::State<'_, RecordingState>) -> AppResult<()> {
    platform::stop(state);
    Ok(())
}

/// The live session, if any. Managed state so the recorder outlives the
/// command that started it.
#[derive(Default)]
pub struct RecordingState(std::sync::Mutex<Option<platform::Session>>);

/// One process that currently has the microphone open, with the windows of
/// the app that contains it.
///
/// Rust reports the measurement and nothing more: which app, whether its
/// microphone is open, and what its windows are called. Whether that adds up
/// to a call — the app list, the window patterns, the settling delay — is
/// policy in `@reflect/core`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallCandidate {
    /// The audio process's bundle id, e.g. `com.tinyspeck.slackmacgap.helper`.
    pub bundle_id: String,
    pub pid: i64,
    /// The `.app` containing the process. A browser plays call audio from a
    /// helper whose windows belong to its parent, so this is what groups them.
    pub app: String,
    /// Titles of that app's on-screen windows. Empty when macOS redacted them,
    /// which it does for any process without the screen-recording permission.
    pub windows: Vec<String>,
}

/// Every process holding the microphone open right now. Cheap enough to poll:
/// one property read per audio process, plus one window list.
#[tauri::command]
pub fn recording_call_candidates() -> AppResult<Vec<CallCandidate>> {
    Ok(platform::call_candidates())
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use core_foundation::array::CFArray;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use objc2::runtime::AnyClass;
    use objc2::AnyThread;
    use objc2_core_audio::{
        kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioDevicePropertyDeviceUID,
        kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyElementMain,
        kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioTapPropertyFormat,
        AudioDeviceCreateIOProcIDWithBlock, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID,
        AudioDeviceStart, AudioDeviceStop, AudioHardwareCreateAggregateDevice,
        AudioHardwareDestroyAggregateDevice, AudioObjectGetPropertyData,
        AudioObjectGetPropertyDataSize, AudioObjectID,
        AudioObjectPropertyAddress, CATapDescription,
    };
    use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
    use objc2_foundation::NSArray;

    use super::SystemAudioPreflight;

    // Screen-recording consent, the gate the tap itself never reports: a tap
    // created without it is created happily and delivers digital silence.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn access_granted() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn request_access() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    /// `kAudioFormatFlagIsFloat` (CoreAudioBaseTypes.h) — a tap always hands
    /// over Float32 LPCM, and anything else means we misread the format.
    const FORMAT_FLAG_IS_FLOAT: u32 = 1;

    type CreateTapFn =
        unsafe extern "C-unwind" fn(*const CATapDescription, *mut AudioObjectID) -> i32;
    type DestroyTapFn = unsafe extern "C-unwind" fn(AudioObjectID) -> i32;

    /// The tap entry points, resolved at runtime rather than linked: they
    /// arrived in macOS 14.2, and a build that links them unconditionally
    /// would refuse to launch on anything older.
    fn tap_functions() -> Option<(CreateTapFn, DestroyTapFn)> {
        extern "C" {
            fn dlsym(handle: *mut c_void, symbol: *const std::os::raw::c_char) -> *mut c_void;
        }
        // RTLD_DEFAULT — CoreAudio is already in the process, no dlopen needed.
        const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
        unsafe {
            let create = dlsym(RTLD_DEFAULT, c"AudioHardwareCreateProcessTap".as_ptr());
            let destroy = dlsym(RTLD_DEFAULT, c"AudioHardwareDestroyProcessTap".as_ptr());
            if create.is_null() || destroy.is_null() {
                return None;
            }
            Some((
                std::mem::transmute::<*mut c_void, CreateTapFn>(create),
                std::mem::transmute::<*mut c_void, DestroyTapFn>(destroy),
            ))
        }
    }

    pub fn supported() -> bool {
        AnyClass::get(c"CATapDescription").is_some() && tap_functions().is_some()
    }

    fn address(selector: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    /// Read a fixed-size Core Audio property.
    ///
    /// # Safety
    /// `T` must be the property's own type — Core Audio writes
    /// `size_of::<T>()` bytes with no further checking.
    unsafe fn property<T>(object: AudioObjectID, selector: u32) -> Result<T, String> {
        let address = address(selector);
        let mut value = std::mem::zeroed::<T>();
        let mut size = std::mem::size_of::<T>() as u32;
        let status = AudioObjectGetPropertyData(
            object,
            NonNull::from(&address),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::new_unchecked(&mut value as *mut T as *mut c_void),
        );
        if status == 0 {
            Ok(value)
        } else {
            Err(format!("AudioObjectGetPropertyData failed (OSStatus {status})"))
        }
    }

    /// A live tap feeding mono `i16` blocks to a sink: the process tap itself,
    /// the aggregate device it has to ride, and the `IOProc` reading it.
    /// Dropping it tears the three down in order.
    pub struct Tap {
        /// The rate the tap delivers at, before any resampling downstream.
        pub rate: u32,
        tap_id: AudioObjectID,
        aggregate_id: AudioObjectID,
        proc_id: AudioDeviceIOProcID,
        destroy_tap: DestroyTapFn,
        default_output: AudioObjectID,
        _io_block: IoBlock,
        _queue: dispatch2::DispatchRetained<dispatch2::DispatchQueue>,
    }

    type IoBlock = RcBlock<
        dyn Fn(
            NonNull<AudioTimeStamp>,
            NonNull<AudioBufferList>,
            NonNull<AudioTimeStamp>,
            NonNull<AudioBufferList>,
            NonNull<AudioTimeStamp>,
        ),
    >;

    impl Tap {
        pub fn start<F>(sink: F) -> Result<Self, String>
        where
            F: Fn(&[i16]) + Send + Sync + 'static,
        {
            let (create_tap, destroy_tap) =
                tap_functions().ok_or("process taps unavailable")?;

            // A global tap — everything every process plays — rather than a
            // process list: scoping to the meeting app is a refinement that
            // needs the app's PID, and the capture must work before that.
            let description = unsafe {
                CATapDescription::initStereoGlobalTapButExcludeProcesses(
                    CATapDescription::alloc(),
                    &NSArray::new(),
                )
            };
            // Private: the tap must not show up in other apps' device lists.
            unsafe { description.setPrivate(true) };
            let tap_uuid = unsafe { description.UUID().UUIDString().to_string() };

            let mut tap_id: AudioObjectID = 0;
            let status = unsafe { create_tap(&*description, &mut tap_id) };
            if status != 0 {
                return Err(format!(
                    "AudioHardwareCreateProcessTap failed (OSStatus {status})"
                ));
            }
            match Self::build(tap_id, &tap_uuid, destroy_tap, Arc::new(sink)) {
                Ok(tap) => Ok(tap),
                Err(err) => {
                    unsafe {
                        let _ = destroy_tap(tap_id);
                    }
                    Err(err)
                }
            }
        }

        fn build<F>(
            tap_id: AudioObjectID,
            tap_uuid: &str,
            destroy_tap: DestroyTapFn,
            sink: Arc<F>,
        ) -> Result<Self, String>
        where
            F: Fn(&[i16]) + Send + Sync + 'static,
        {
            // The format is read to assert Float32 LPCM and to learn the
            // channel layout the IOProc will hand over.
            let format: AudioStreamBasicDescription =
                unsafe { property(tap_id, kAudioTapPropertyFormat) }?;
            let rate = format.mSampleRate as u32;
            let channels = format.mChannelsPerFrame.max(1) as usize;
            if rate == 0 || format.mFormatFlags & FORMAT_FLAG_IS_FLOAT == 0 {
                return Err(format!(
                    "unexpected tap format (rate {rate}, flags {:#x})",
                    format.mFormatFlags
                ));
            }
            let interleaved = format.mBytesPerFrame >= (4 * channels) as u32;

            // A tap is not readable on its own: it rides an aggregate device
            // whose main sub-device is the output it follows. The keys are the
            // string values of the kAudioAggregateDevice… constants;
            // `tapautostart` spares an explicit start ordering and drift
            // compensation keeps the tap on the output's clock.
            let default_output: AudioObjectID = unsafe {
                property(
                    kAudioObjectSystemObject as AudioObjectID,
                    kAudioHardwarePropertyDefaultOutputDevice,
                )
            }?;
            let output_uid = unsafe {
                let uid: CFStringRef = property(default_output, kAudioDevicePropertyDeviceUID)?;
                if uid.is_null() {
                    return Err("default output device has no UID".into());
                }
                CFString::wrap_under_create_rule(uid).to_string()
            };

            let pair =
                |key: &str, value: CFString| (CFString::new(key).as_CFType(), value.as_CFType());
            let flag = |key: &str, value: bool| {
                (
                    CFString::new(key).as_CFType(),
                    if value {
                        CFBoolean::true_value()
                    } else {
                        CFBoolean::false_value()
                    }
                    .as_CFType(),
                )
            };
            let sub_device =
                CFDictionary::from_CFType_pairs(&[pair("uid", CFString::new(&output_uid))]);
            let sub_tap = CFDictionary::from_CFType_pairs(&[
                pair("uid", CFString::new(tap_uuid)),
                flag("drift", true),
            ]);
            let aggregate = CFDictionary::from_CFType_pairs(&[
                pair(
                    "uid",
                    CFString::new(&format!("app.reflect.tap-{}", std::process::id())),
                ),
                pair("name", CFString::new("Reflect system audio")),
                pair("master", CFString::new(&output_uid)),
                flag("private", true),
                flag("stacked", false),
                flag("tapautostart", true),
                (
                    CFString::new("subdevices").as_CFType(),
                    CFArray::from_CFTypes(&[sub_device.as_CFType()]).as_CFType(),
                ),
                (
                    CFString::new("taps").as_CFType(),
                    CFArray::from_CFTypes(&[sub_tap.as_CFType()]).as_CFType(),
                ),
            ]);

            let mut aggregate_id: AudioObjectID = 0;
            let status = unsafe {
                // Toll-free bridge: core-foundation's CFDictionaryRef is the
                // same object the generated signature asks for.
                AudioHardwareCreateAggregateDevice(
                    &*(aggregate.as_concrete_TypeRef()
                        as *const objc2_core_foundation::CFDictionary),
                    NonNull::from(&mut aggregate_id),
                )
            };
            if status != 0 {
                return Err(format!(
                    "AudioHardwareCreateAggregateDevice failed (OSStatus {status})"
                ));
            }

            let io_block: IoBlock = RcBlock::new(
                move |_now: NonNull<AudioTimeStamp>,
                      input: NonNull<AudioBufferList>,
                      _input_time: NonNull<AudioTimeStamp>,
                      _output: NonNull<AudioBufferList>,
                      _output_time: NonNull<AudioTimeStamp>| unsafe {
                    let list = input.as_ref();
                    let buffers = std::slice::from_raw_parts(
                        list.mBuffers.as_ptr(),
                        list.mNumberBuffers.min(8) as usize,
                    );
                    let Some(first) = buffers.first().filter(|buffer| !buffer.mData.is_null())
                    else {
                        return;
                    };
                    let (frames, stride) = if interleaved {
                        (first.mDataByteSize as usize / (4 * channels), channels)
                    } else {
                        (first.mDataByteSize as usize / 4, 1)
                    };
                    if frames == 0 {
                        return;
                    }
                    let samples =
                        std::slice::from_raw_parts(first.mData as *const f32, frames * stride);
                    let mono: Vec<i16> = (0..frames)
                        .map(|frame| {
                            let value = if stride == 1 {
                                samples[frame]
                            } else {
                                let start = frame * stride;
                                samples[start..start + stride].iter().sum::<f32>() / stride as f32
                            };
                            (value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                        })
                        .collect();
                    sink(&mono);
                },
            );

            let queue = dispatch2::DispatchQueue::new("app.reflect.tap", None);
            let mut proc_id: AudioDeviceIOProcID = None;
            let created = unsafe {
                AudioDeviceCreateIOProcIDWithBlock(
                    NonNull::from(&mut proc_id),
                    aggregate_id,
                    Some(&queue),
                    &*io_block as *const _ as *mut _,
                )
            };
            if created != 0 {
                unsafe {
                    let _ = AudioHardwareDestroyAggregateDevice(aggregate_id);
                }
                return Err(format!(
                    "AudioDeviceCreateIOProcIDWithBlock failed (OSStatus {created})"
                ));
            }
            let started = unsafe { AudioDeviceStart(aggregate_id, proc_id) };
            if started != 0 {
                unsafe {
                    let _ = AudioDeviceDestroyIOProcID(aggregate_id, proc_id);
                    let _ = AudioHardwareDestroyAggregateDevice(aggregate_id);
                }
                return Err(format!("AudioDeviceStart failed (OSStatus {started})"));
            }

            Ok(Self {
                rate,
                tap_id,
                aggregate_id,
                proc_id,
                destroy_tap,
                default_output,
                _io_block: io_block,
                _queue: queue,
            })
        }

        /// Is the default output rendering for *any* process right now? Half
        /// the preflight verdict: silence only accuses when something played.
        fn output_is_rendering(&self) -> bool {
            unsafe {
                property::<u32>(
                    self.default_output,
                    kAudioDevicePropertyDeviceIsRunningSomewhere,
                )
            }
            .is_ok_and(|running| running != 0)
        }
    }

    impl Drop for Tap {
        fn drop(&mut self) {
            unsafe {
                let _ = AudioDeviceStop(self.aggregate_id, self.proc_id);
                let _ = AudioDeviceDestroyIOProcID(self.aggregate_id, self.proc_id);
                let _ = AudioHardwareDestroyAggregateDevice(self.aggregate_id);
                let _ = (self.destroy_tap)(self.tap_id);
            }
        }
    }

    pub fn preflight(duration_ms: u64) -> SystemAudioPreflight {
        if !supported() {
            return SystemAudioPreflight::Unsupported;
        }
        let nonzero = Arc::new(AtomicU64::new(0));
        let counter = nonzero.clone();
        let tap = match Tap::start(move |samples| {
            let loud = samples.iter().filter(|sample| **sample != 0).count() as u64;
            if loud > 0 {
                counter.fetch_add(loud, Ordering::Relaxed);
            }
        }) {
            Ok(tap) => tap,
            Err(message) => return SystemAudioPreflight::Failed { message },
        };
        std::thread::sleep(std::time::Duration::from_millis(duration_ms));
        // Read the output's state before the tap goes away: tearing the
        // aggregate device down can stop the render we are asking about.
        let rendering = tap.output_is_rendering();
        drop(tap);

        if nonzero.load(Ordering::Relaxed) > 0 {
            SystemAudioPreflight::Granted
        } else if rendering {
            SystemAudioPreflight::SilentWhilePlaying
        } else {
            SystemAudioPreflight::Inconclusive
        }
    }

    // ---- the recorder: two tracks, rotated on a timer ----

    use std::fs::File;
    use std::io::BufWriter;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc::{channel, Sender};
    use std::time::Instant;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use hound::{WavSpec, WavWriter};
    use tauri::{Emitter, Manager};

    use crate::error::{AppError, AppResult};

    use super::{RecordingSegment, RecordingStarted, RecordingState};

    /// Transcription wants 16 kHz mono; the tap and most microphones hand over
    /// 48 kHz. Decimating by averaging keeps a five-minute segment near 10 MB
    /// instead of 28 — inside every provider's request cap — and costs nothing
    /// a speech model can hear. A sharper filter (or AAC via `ExtAudioFile`)
    /// is the upgrade if music ever matters.
    const TARGET_RATE: u32 = 16_000;

    /// One track's segmented writer. The padding is the reason this type
    /// exists: a tap delivers *no callbacks* while nothing is playing, so an
    /// unpadded system track ends up shorter than the meeting and slides out
    /// of alignment with the microphone.
    struct Track {
        name: &'static str,
        rate: u32,
        dir: PathBuf,
        inner: Mutex<TrackInner>,
    }

    struct TrackInner {
        writer: Option<WavWriter<BufWriter<File>>>,
        part: u32,
        frames: u64,
        /// Carried across callbacks so decimation never drops a remainder.
        pending: Vec<i16>,
    }

    impl Track {
        fn new(name: &'static str, rate: u32, dir: &Path) -> Result<Self, String> {
            let track = Self {
                name,
                rate,
                dir: dir.to_path_buf(),
                inner: Mutex::new(TrackInner {
                    writer: None,
                    part: 0,
                    frames: 0,
                    pending: Vec::new(),
                }),
            };
            track.open(1)?;
            Ok(track)
        }

        fn path(&self, part: u32) -> PathBuf {
            self.dir.join(format!("part-{part:03}.{}.wav", self.name))
        }

        fn open(&self, part: u32) -> Result<(), String> {
            let writer = WavWriter::create(
                self.path(part),
                WavSpec {
                    channels: 1,
                    sample_rate: TARGET_RATE,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .map_err(|err| err.to_string())?;
            let mut inner = self.inner.lock().unwrap();
            inner.writer = Some(writer);
            inner.part = part;
            inner.frames = 0;
            inner.pending.clear();
            Ok(())
        }

        /// Append mono samples at the source rate, decimating to
        /// {@link TARGET_RATE} on the way in.
        fn write(&self, samples: &[i16]) {
            let step = (self.rate / TARGET_RATE).max(1) as usize;
            let mut inner = self.inner.lock().unwrap();
            inner.pending.extend_from_slice(samples);
            let usable = inner.pending.len() / step * step;
            if usable == 0 {
                return;
            }
            let decimated: Vec<i16> = inner.pending[..usable]
                .chunks(step)
                .map(|group| {
                    (group.iter().map(|sample| *sample as i32).sum::<i32>() / step as i32) as i16
                })
                .collect();
            inner.pending.drain(..usable);
            if let Some(writer) = inner.writer.as_mut() {
                for sample in &decimated {
                    let _ = writer.write_sample(*sample);
                }
            }
            inner.frames += decimated.len() as u64;
        }

        /// Fill the gap between what arrived and how long the segment has
        /// actually been running. A fifth of a second of slack absorbs the
        /// fact that callbacks arrive in blocks.
        fn pad_to(&self, elapsed_ms: u64) {
            let expected = elapsed_ms * TARGET_RATE as u64 / 1000;
            let mut inner = self.inner.lock().unwrap();
            if expected <= inner.frames + TARGET_RATE as u64 / 5 {
                return;
            }
            let gap = expected - inner.frames;
            if let Some(writer) = inner.writer.as_mut() {
                for _ in 0..gap {
                    let _ = writer.write_sample(0i16);
                }
            }
            inner.frames += gap;
        }

        /// Close the current segment and open the next unless this was the
        /// last. Returns what the caller needs to announce it.
        fn rotate(&self, end: bool) -> Result<(u32, u64, PathBuf), String> {
            let (part, frames) = {
                let mut inner = self.inner.lock().unwrap();
                if let Some(writer) = inner.writer.take() {
                    writer.finalize().map_err(|err| err.to_string())?;
                }
                (inner.part, inner.frames)
            };
            if !end {
                self.open(part + 1)?;
            }
            Ok((part, frames, self.path(part)))
        }
    }

    /// A running session. Dropping it stops both captures; the rotation
    /// thread notices the channel closing and exits.
    pub struct Session {
        stop: Sender<()>,
    }

    pub fn start(
        app: tauri::AppHandle,
        segment_ms: u64,
        state: tauri::State<'_, RecordingState>,
    ) -> AppResult<RecordingStarted> {
        let mut slot = state.0.lock().map_err(|_| AppError::Unknown {
            message: "recording state is poisoned".into(),
        })?;
        if slot.is_some() {
            return Err(AppError::Unknown {
                message: "a recording is already running".into(),
            });
        }
        if !supported() {
            return Err(AppError::Unknown {
                message: "system audio capture needs macOS 14.2 or newer".into(),
            });
        }

        let staging = app
            .path()
            .app_cache_dir()
            .map_err(|err| AppError::io(err.to_string()))?
            .join(format!("recording-{}", std::process::id()));
        std::fs::create_dir_all(&staging).map_err(AppError::from)?;

        let (mic_rate, mic_device) = default_input().unwrap_or((48_000, "(unknown)".into()));
        let mic_track = Arc::new(
            Track::new("mic", mic_rate, &staging).map_err(|message| AppError::Unknown { message })?,
        );
        let system_track = Arc::new(
            Track::new("system", 48_000, &staging)
                .map_err(|message| AppError::Unknown { message })?,
        );

        // Neither capture can cross a thread boundary: the tap owns an
        // Objective-C block and cpal's stream owns a platform callback, both
        // `!Send` by construction. So the recording thread *builds* them and
        // never lets go, and start() only waits to hear that it worked.
        let (ready, started) = channel::<Result<u32, String>>();
        let (stop, stopped) = channel::<()>();
        let thread_system = system_track.clone();
        let thread_mic = mic_track.clone();
        std::thread::spawn(move || {
            let mic_sink = thread_mic.clone();
            let microphone = match start_microphone(move |samples| mic_sink.write(samples)) {
                Ok(stream) => stream,
                Err(message) => {
                    let _ = ready.send(Err(message));
                    return;
                }
            };
            let system_sink = thread_system.clone();
            let tap = match Tap::start(move |samples| system_sink.write(samples)) {
                Ok(tap) => tap,
                Err(message) => {
                    let _ = ready.send(Err(message));
                    return;
                }
            };
            let _ = ready.send(Ok(tap.rate));

            let mut part_started = Instant::now();
            loop {
                let ending = !matches!(
                    stopped.recv_timeout(std::time::Duration::from_millis(250)),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                );
                let elapsed = part_started.elapsed().as_millis() as u64;
                // Padding is what keeps the two tracks aligned: the tap stops
                // delivering callbacks entirely while nothing is playing.
                thread_system.pad_to(elapsed);
                thread_mic.pad_to(elapsed);
                if !ending && elapsed < segment_ms {
                    continue;
                }
                for track in [&thread_system, &thread_mic] {
                    match track.rotate(ending) {
                        Ok((part, frames, path)) => {
                            let _ = app.emit(
                                "recording:segment",
                                RecordingSegment {
                                    part,
                                    end: ending,
                                    track: track.name,
                                    path: path.to_string_lossy().into_owned(),
                                    frames,
                                    rate: TARGET_RATE,
                                },
                            );
                        }
                        Err(message) => {
                            let _ = app.emit("recording:error", message);
                        }
                    }
                }
                part_started = Instant::now();
                if ending {
                    break;
                }
            }
            drop(tap);
            drop(microphone);
        });

        let system_rate = started
            .recv()
            .map_err(|_| AppError::Unknown {
                message: "the recording thread died before it started".into(),
            })?
            .map_err(|message| AppError::Unknown { message })?;

        *slot = Some(Session { stop });
        Ok(RecordingStarted {
            staging_dir: staging.to_string_lossy().into_owned(),
            system_rate,
            mic_rate,
            mic_device,
        })
    }

    pub fn stop(state: tauri::State<'_, RecordingState>) {
        let Ok(mut slot) = state.0.lock() else { return };
        if let Some(session) = slot.take() {
            let _ = session.stop.send(());
        }
    }

    fn default_input() -> Option<(u32, String)> {
        let device = cpal::default_host().default_input_device()?;
        let name = device.name().unwrap_or_else(|_| "(unnamed)".into());
        let config = device.default_input_config().ok()?;
        Some((config.sample_rate().0, name))
    }

    /// The microphone half. Separate from the tap on purpose: mixing them
    /// would cost format conversion and resampling, and would throw away
    /// which side of the conversation each word came from.
    fn start_microphone<F>(sink: F) -> Result<cpal::Stream, String>
    where
        F: Fn(&[i16]) + Send + 'static,
    {
        let device = cpal::default_host()
            .default_input_device()
            .ok_or("no default input device")?;
        let config = device.default_input_config().map_err(|e| e.to_string())?;
        let channels = config.channels() as usize;
        let format = config.sample_format();
        let stream_config: cpal::StreamConfig = config.into();
        let report = |err| eprintln!("recording: microphone stream error — {err}");
        let stream = match format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &_| {
                    sink(&data
                        .chunks(channels.max(1))
                        .map(|frame| {
                            let value = frame.iter().sum::<f32>() / frame.len() as f32;
                            (value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                        })
                        .collect::<Vec<_>>())
                },
                report,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &_| {
                    sink(&data
                        .chunks(channels.max(1))
                        .map(|frame| {
                            (frame.iter().map(|s| *s as i32).sum::<i32>() / frame.len() as i32)
                                as i16
                        })
                        .collect::<Vec<_>>())
                },
                report,
                None,
            ),
            other => return Err(format!("unsupported microphone format: {other:?}")),
        }
        .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(stream)
    }


    // ---- who has the microphone open, and what are their windows called ----

    use super::CallCandidate;

    const PROCESS_LIST: u32 = u32::from_be_bytes(*b"prs#");
    const PROCESS_BUNDLE_ID: u32 = u32::from_be_bytes(*b"pbid");
    const PROCESS_PID: u32 = u32::from_be_bytes(*b"ppid");
    const PROCESS_RUNNING_INPUT: u32 = u32::from_be_bytes(*b"piri");

    /// The `.app` bundle containing a process. A browser plays a call from a
    /// helper process whose windows belong to the parent, so matching a window
    /// to a conversation has to group by this rather than by pid.
    fn app_of(pid: i64) -> String {
        extern "C" {
            fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
        }
        let mut buffer = vec![0u8; 4096];
        let written =
            unsafe { proc_pidpath(pid as i32, buffer.as_mut_ptr() as *mut c_void, 4096) };
        if written <= 0 {
            return String::new();
        }
        let path = String::from_utf8_lossy(&buffer[..written as usize]).into_owned();
        match path.find(".app/") {
            Some(at) => path[..at + 4].rsplit('/').next().unwrap_or("").to_string(),
            None => path.rsplit('/').next().unwrap_or("").to_string(),
        }
    }

    /// On-screen windows as `(containing app, title)`. Titles come back empty
    /// unless this process holds the screen-recording permission.
    fn on_screen_windows() -> Vec<(String, String)> {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGWindowListCopyWindowInfo(
                option: u32,
                relative_to: u32,
            ) -> core_foundation::array::CFArrayRef;
        }
        const ON_SCREEN_ONLY: u32 = 1;
        const EXCLUDE_DESKTOP: u32 = 1 << 4;
        let mut out = Vec::new();
        unsafe {
            let raw = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
            if raw.is_null() {
                return out;
            }
            let list: CFArray<CFDictionary<CFString, core_foundation::base::CFType>> =
                CFArray::wrap_under_create_rule(raw);
            for window in list.iter() {
                let title = window
                    .find(CFString::new("kCGWindowName"))
                    .and_then(|value| value.downcast::<CFString>())
                    .map(|value| value.to_string())
                    .unwrap_or_default();
                if title.is_empty() {
                    continue;
                }
                let Some(pid) = window
                    .find(CFString::new("kCGWindowOwnerPID"))
                    .and_then(|value| value.downcast::<core_foundation::number::CFNumber>())
                    .and_then(|value| value.to_i64())
                else {
                    continue;
                };
                out.push((app_of(pid), title));
            }
        }
        out
    }

    fn audio_process_ids() -> Vec<AudioObjectID> {
        let addr = address(PROCESS_LIST);
        let mut size: u32 = 0;
        unsafe {
            if AudioObjectGetPropertyDataSize(
                kAudioObjectSystemObject as AudioObjectID,
                NonNull::from(&addr),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
            ) != 0
            {
                return Vec::new();
            }
            let mut ids =
                vec![0 as AudioObjectID; size as usize / std::mem::size_of::<AudioObjectID>()];
            if AudioObjectGetPropertyData(
                kAudioObjectSystemObject as AudioObjectID,
                NonNull::from(&addr),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::new_unchecked(ids.as_mut_ptr() as *mut c_void),
            ) != 0
            {
                return Vec::new();
            }
            ids
        }
    }

    pub fn call_candidates() -> Vec<CallCandidate> {
        let windows = on_screen_windows();
        audio_process_ids()
            .into_iter()
            .filter_map(|object| {
                if unsafe { property::<u32>(object, PROCESS_RUNNING_INPUT) }.unwrap_or(0) == 0 {
                    return None;
                }
                let bundle_id = unsafe {
                    let raw: CFStringRef = property(object, PROCESS_BUNDLE_ID).ok()?;
                    (!raw.is_null()).then(|| CFString::wrap_under_create_rule(raw).to_string())
                }?;
                let pid = unsafe { property::<i32>(object, PROCESS_PID) }.unwrap_or(0) as i64;
                let app = app_of(pid);
                let titles = windows
                    .iter()
                    .filter(|(owner, _)| !app.is_empty() && *owner == app)
                    .map(|(_, title)| title.clone())
                    .collect();
                Some(CallCandidate { bundle_id, pid, app, windows: titles })
            })
            .collect()
    }

}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::SystemAudioPreflight;

    pub fn supported() -> bool {
        false
    }

    pub fn access_granted() -> bool {
        false
    }

    pub fn request_access() -> bool {
        false
    }

    pub fn preflight(_duration_ms: u64) -> SystemAudioPreflight {
        SystemAudioPreflight::Unsupported
    }

    pub fn call_candidates() -> Vec<super::CallCandidate> {
        Vec::new()
    }
}
