//! System-audio capture: Core Audio process taps (macOS 14.2+).
//!
//! Moved out of Reflect's desktop shell unchanged in substance — the tap, the
//! aggregate device, the two tracks and the pad-to-clock rotation are the
//! same code that worked there. What left with Tauri is the plumbing: a
//! segment is announced through a callback instead of an event, the staging
//! root arrives as an argument instead of an app handle, and the session is
//! an owned value instead of a slot in managed state.
//!
//! Taps are the right primitive rather than ScreenCaptureKit: the entry
//! points are plain C, where `SCStream` would need an Objective-C protocol
//! implementation to receive sample buffers, and a tap can be scoped to the
//! processes in a call instead of mixing in every other sound on the machine.
//!
//! **The whole surface lies on failure.** Every tap call returns `noErr` even
//! when the user denied "Screen & System Audio Recording"; the tap is
//! created, the `IOProc` fires, and every delivered sample is digital zero.
//! Nothing downstream can tell that from a quiet room, so the permission is
//! asked for before a recording starts rather than discovered afterwards.

/// Anything the capture refuses to do, with the reason the user should read.
#[derive(Debug)]
pub struct CaptureError(pub String);

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CaptureError {}

/// Called on the rotation thread as each segment closes. Must not block.
pub type OnSegment = Box<dyn Fn(RecordingSegment) + Send + 'static>;

/// One finished segment of one track.
#[derive(Debug, Clone)]
pub struct RecordingSegment {
    pub part: u32,
    /// The last segment of this track: the marker that tells a clean ending
    /// from a crash.
    pub end: bool,
    pub track: &'static str,
    pub path: PathBuf,
    pub frames: u64,
    /// Samples loud enough to be something rather than room tone. On the
    /// system track this is the evidence that anyone else was there.
    pub loud: u64,
    pub rate: u32,
}

/// What a started capture reports about itself.
#[derive(Debug, Clone)]
pub struct RecordingStarted {
    pub staging_dir: PathBuf,
    pub system_rate: u32,
    pub mic_rate: u32,
    pub mic_device: String,
}

/// A process that might be in a call: an app with the microphone open.
#[derive(Debug, Clone, PartialEq)]
pub struct CallCandidate {
    pub bundle_id: String,
    pub pid: i64,
    pub app: String,
    pub windows: Vec<String>,
}

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, Ordering};
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
    kAudioDevicePropertyDeviceUID,
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
                  _output_time: NonNull<AudioTimeStamp>| {
                // Last line of defence: a panic unwinding into CoreAudio's
                // C++ IO thread aborts the process. Losing a block of
                // audio is a recording with a gap; losing the process is
                // a recording that never existed.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
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
                }));
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
            _io_block: io_block,
            _queue: queue,
        })
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

// ---- the recorder: two tracks, rotated on a timer ----

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};


/// Transcription wants 16 kHz mono; the tap and most microphones hand over
/// 48 kHz. Decimating by averaging keeps a five-minute segment near 10 MB
/// instead of 28 — inside every provider's request cap — and costs nothing
/// a speech model can hear. A sharper filter (or AAC via `ExtAudioFile`)
/// is the upgrade if music ever matters.
const TARGET_RATE: u32 = 16_000;

/// A lock that survives a panic elsewhere.
///
/// Once any holder panics the mutex is poisoned and every later `lock`
/// returns `Err`, so an `unwrap` here turns one fault into a permanent
/// one — on the audio thread, into an aborted app.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One track's segmented writer. The padding is the reason this type
/// exists: a tap delivers *no callbacks* while nothing is playing, so an
/// unpadded system track ends up shorter than the meeting and slides out
/// of alignment with the microphone.
struct Track {
    name: &'static str,
    /// The source rate, learned from the device rather than assumed. A
    /// tap reports it only once it exists, so this is set just after.
    rate: AtomicU32,
    dir: PathBuf,
    inner: Mutex<TrackInner>,
}

struct TrackInner {
    writer: Option<WavWriter<BufWriter<File>>>,
    part: u32,
    frames: u64,
    /// Samples loud enough to be something rather than room tone. The
    /// system track's count is the evidence that anyone else was there.
    loud: u64,
    /// Carried across callbacks so resampling never drops a remainder.
    pending: Vec<i16>,
    /// Where the next output sample falls in `pending`, in input samples.
    cursor: f64,
}

impl Track {
    fn new(name: &'static str, rate: u32, dir: &Path) -> Result<Self, String> {
        let track = Self {
            name,
            rate: AtomicU32::new(rate),
            dir: dir.to_path_buf(),
            inner: Mutex::new(TrackInner {
                writer: None,
                part: 0,
                frames: 0,
                loud: 0,
                pending: Vec::new(),
                cursor: 0.0,
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
        let mut inner = lock(&self.inner);
        inner.writer = Some(writer);
        inner.part = part;
        inner.frames = 0;
        inner.loud = 0;
        inner.pending.clear();
        inner.cursor = 0.0;
        Ok(())
    }

    /// Append mono samples at the source rate, resampled to
    /// {@link TARGET_RATE} on the way in.
    ///
    /// Linear interpolation rather than dropping every nth sample,
    /// because the ratio is rarely a whole number: a 44.1 kHz microphone
    /// decimated by `44100 / 16000 = 2` would be written at 22 050 Hz
    /// under a 16 kHz header and play back a third too slow — and drift
    /// away from the other track, which is the one thing two tracks must
    /// never do.
    ///
    /// Every index here is bounded by the loop condition rather than by
    /// argument: this runs on CoreAudio's IO thread, where a panic
    /// crosses an FFI boundary and takes the whole app with it.
    fn write(&self, samples: &[i16]) {
        if samples.is_empty() {
            return;
        }
        let ratio = (self.rate.load(Ordering::Relaxed) as f64 / TARGET_RATE as f64).max(0.001);
        let mut inner = lock(&self.inner);
        inner.pending.extend_from_slice(samples);
        let mut resampled: Vec<i16> = Vec::new();
        // `cursor` is where the next output sample falls in input space,
        // carried across calls so a block boundary is not a glitch. The
        // condition keeps `left + 1` inside `pending` by construction.
        while inner.cursor + 1.0 < inner.pending.len() as f64 {
            let left = inner.cursor as usize;
            let fraction = inner.cursor - left as f64;
            let before = inner.pending[left] as f64;
            let after = inner.pending[left + 1] as f64;
            resampled.push((before + (after - before) * fraction).round() as i16);
            inner.cursor += ratio;
        }
        // Consume what the cursor has passed, never more than exists.
        let consumed = (inner.cursor as usize).min(inner.pending.len());
        if consumed > 0 {
            inner.pending.drain(..consumed);
            inner.cursor -= consumed as f64;
        }
        let decimated = resampled;
        // Well above dither and room tone, well below speech.
        const AUDIBLE: i16 = 300;
        let loud = decimated.iter().filter(|sample| sample.abs() > AUDIBLE).count() as u64;
        if let Some(writer) = inner.writer.as_mut() {
            for sample in &decimated {
                let _ = writer.write_sample(*sample);
            }
        }
        inner.frames += decimated.len() as u64;
        inner.loud += loud;
    }

    /// Correct the source rate once the device reports its own.
    fn set_rate(&self, rate: u32) {
        if rate > 0 {
            self.rate.store(rate, Ordering::Relaxed);
        }
    }

    /// Fill the gap between what arrived and how long the segment has
    /// actually been running. A fifth of a second of slack absorbs the
    /// fact that callbacks arrive in blocks.
    fn pad_to(&self, elapsed_ms: u64) {
        let expected = elapsed_ms * TARGET_RATE as u64 / 1000;
        let mut inner = lock(&self.inner);
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
    fn rotate(&self, end: bool) -> Result<(u32, u64, u64, PathBuf), String> {
        let (part, frames, loud) = {
            let mut inner = lock(&self.inner);
            if let Some(writer) = inner.writer.take() {
                writer.finalize().map_err(|err| err.to_string())?;
            }
            (inner.part, inner.frames, inner.loud)
        };
        if !end {
            // Advance regardless: a failed open leaves no writer, and a
            // track that kept its old number would re-emit a part the
            // graph already has while recording nothing into it. Moving
            // on costs one segment; standing still costs the rest.
            lock(&self.inner).part = part + 1;
            self.open(part + 1)?;
        }
        Ok((part, frames, loud, self.path(part)))
    }
}

/// A running session. Dropping it stops both captures; the rotation
/// thread notices the channel closing and exits.
pub struct Session {
    stop: Sender<()>,
}

/// Start capturing into `staging_root`, announcing each finished segment
/// through `on_segment`.
///
/// The callback runs on the rotation thread, so it must not block: the
/// next rotation waits behind it, and a slow consumer would desynchronise
/// the two tracks it is being handed.
pub fn start(
    staging_root: PathBuf,
    segment_ms: u64,
    on_segment: OnSegment,
) -> Result<(Session, RecordingStarted), CaptureError> {
    if !supported() {
        return Err(CaptureError("system audio capture needs macOS 14.2 or newer".into()));
    }

    let staging = staging_root
        // Per session, not per process: two recordings in one app run
        // would otherwise share a directory and the second would
        // overwrite the first's segments, which both start at part 1.
        .join(format!(
            "recording-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_millis())
                .unwrap_or(0)
        ));
    std::fs::create_dir_all(&staging).map_err(|err| CaptureError(err.to_string()))?;
    sweep_abandoned_staging(&staging);

    let (mic_rate, mic_device) = default_input().unwrap_or((48_000, "(unknown)".into()));
    let mic_track = Arc::new(
        Track::new("mic", mic_rate, &staging).map_err(CaptureError)?,
    );
    // Provisional: corrected from the tap the moment it reports its own.
    let system_track = Arc::new(
        Track::new("system", 48_000, &staging)
            .map_err(CaptureError)?,
    );


    // Neither capture can cross a thread boundary: the tap owns an
    // Objective-C block and cpal's stream owns a platform callback, both
    // `!Send` by construction. So the recording thread *builds* them and
    // never lets go, and start() only waits to hear that it worked.
    let (ready, started) = channel::<Result<u32, String>>();
    let (stop, stopped) = channel::<()>();
    let staging_for_thread = staging.clone();
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
        // The tap only reports the rate it delivers at once it exists, so
        // the track is told now rather than built on an assumption: an
        // output running at 44.1 or 96 kHz would otherwise be written
        // under a header that lies about its speed.
        thread_system.set_rate(tap.rate);
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
                    Ok((part, frames, loud, path)) => {
                        trace(&format!(
                                "rust: segment part={part} track={} end={ending} frames={frames} loud={loud} {}",
                                track.name,
                                path.display()
                            ),
                        );
                        on_segment(RecordingSegment {
                                part,
                                end: ending,
                                track: track.name,
                                path,
                                frames,
                                loud,
                                rate: TARGET_RATE,
                            },
                        );
                    }
                    Err(message) => {
                        trace(&format!("rust: rotate failed — {message}"));
                        // Reported through the trace above; the capture
                        // keeps going, because the other track may still
                        // be rotating cleanly.
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
        // Deliberately *not* cleared here. The final segments were
        // announced moments ago and the import runs in the webview; a
        // capture thread that deletes on its way out can take the last
        // five minutes with it. The sweep at the next session's start is
        // late enough to be safe, and nothing accumulates in between but
        // one session's audio.
        let _ = &staging_for_thread;
    });

    let system_rate = started
        .recv()
        .map_err(|_| CaptureError("the recording thread died before it started".into()))?
        .map_err(CaptureError)?;

    trace(&format!("rust: started, staging {}", staging.display()));
    Ok((
        Session { stop },
        RecordingStarted {
            staging_dir: staging,
            system_rate,
            mic_rate,
            mic_device,
        },
    ))
}

impl Session {
    /// Tell the capture to finish. The rotation thread closes each track
    /// with `end: true` afterwards, which is the marker a reader uses to
    /// tell a clean ending from a crash.
    pub fn stop(&self) {
        let _ = self.stop.send(());
    }
}

/// Remove staging directories a previous run left behind. A crash mid
/// recording cannot clean up after itself, so the next session does it —
/// anything whose segments mattered was imported as it was written, and
/// what is left is the open segment nobody will ever transcribe.
fn sweep_abandoned_staging(current: &Path) {
    let Some(parent) = current.parent() else { return };
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == current || !path.is_dir() {
            continue;
        }
        let is_staging = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("recording-"));
        if is_staging && std::fs::remove_dir_all(&path).is_ok() {
            trace(&format!("rust: swept abandoned staging {}", path.display()));
        }
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


// ---- the trace file ----

/// Where the trace lands. Set once at startup; `None` until then, which
/// is why every trace is best-effort rather than an error path.
static TRACE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_trace_path(path: PathBuf) {
    *lock(&TRACE_PATH) = Some(path);
}

fn trace_path() -> Option<PathBuf> {
    lock(&TRACE_PATH).clone()
}

/// Best-effort by design: losing a trace line must never disturb a
/// recording, which is the thing actually worth protecting.
pub fn trace(line: &str) {
    use std::io::Write;
    let Some(path) = trace_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    let day = (stamp as i64 - 3 * 3600).rem_euclid(86_400);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            file,
            "{:02}:{:02}:{:02}  {line}",
            day / 3600,
            (day % 3600) / 60,
            day % 60
        );
    }
}

// ---- who has the microphone open, and what are their windows called ----


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

