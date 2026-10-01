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

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use block2::RcBlock;
    use core_foundation::array::CFArray;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use dispatch2::DispatchQueue;
    use objc2::runtime::AnyClass;
    use objc2::AnyThread;
    use objc2_core_audio::{
        kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioDevicePropertyDeviceUID,
        kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyElementMain,
        kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioTapPropertyFormat,
        AudioDeviceCreateIOProcIDWithBlock, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID,
        AudioDeviceStart, AudioDeviceStop, AudioHardwareCreateAggregateDevice,
        AudioHardwareDestroyAggregateDevice, AudioObjectGetPropertyData, AudioObjectID,
        AudioObjectPropertyAddress, CATapDescription,
    };
    use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
    use objc2_foundation::NSArray;

    use super::SystemAudioPreflight;

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

    /// Is the default output device rendering for *any* process right now?
    /// Paired with a silent tap this is the denial signature; on its own it
    /// is what separates "denied" from "nothing was playing".
    fn output_is_rendering(device: AudioObjectID) -> bool {
        unsafe { property::<u32>(device, kAudioDevicePropertyDeviceIsRunningSomewhere) }
            .is_ok_and(|running| running != 0)
    }

    pub fn preflight(duration_ms: u64) -> SystemAudioPreflight {
        if !supported() {
            return SystemAudioPreflight::Unsupported;
        }
        match probe(duration_ms) {
            Ok(outcome) => outcome,
            Err(message) => SystemAudioPreflight::Failed { message },
        }
    }

    fn probe(duration_ms: u64) -> Result<SystemAudioPreflight, String> {
        let (create_tap, destroy_tap) = tap_functions().ok_or("process taps unavailable")?;

        // A global tap (everything every process plays) rather than a process
        // list: the probe only asks "does audio reach us at all", and the
        // answer must not depend on which app happens to be making noise.
        let description = unsafe {
            CATapDescription::initStereoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &NSArray::new(),
            )
        };
        // Private: the tap must not appear in other apps' device lists.
        unsafe { description.setPrivate(true) };
        let tap_uuid = unsafe { description.UUID().UUIDString().to_string() };

        let mut tap_id: AudioObjectID = 0;
        let status = unsafe { create_tap(&*description, &mut tap_id) };
        if status != 0 {
            return Err(format!(
                "AudioHardwareCreateProcessTap failed (OSStatus {status})"
            ));
        }

        let outcome = listen(tap_id, &tap_uuid, duration_ms);
        unsafe {
            let _ = destroy_tap(tap_id);
        }
        outcome
    }

    fn listen(
        tap_id: AudioObjectID,
        tap_uuid: &str,
        duration_ms: u64,
    ) -> Result<SystemAudioPreflight, String> {
        // Read the format only to assert the tap hands over Float32 LPCM: the
        // probe counts non-zero samples, and a non-zero float is signal
        // whether the buffer is interleaved or not. A recorder that writes
        // frames does have to know, and will read the layout then.
        let format: AudioStreamBasicDescription =
            unsafe { property(tap_id, kAudioTapPropertyFormat) }?;
        if format.mSampleRate == 0.0 || format.mFormatFlags & FORMAT_FLAG_IS_FLOAT == 0 {
            return Err(format!(
                "unexpected tap format (rate {}, flags {:#x})",
                format.mSampleRate, format.mFormatFlags
            ));
        }

        // A tap is not readable on its own: it has to ride an aggregate
        // device whose main sub-device is the output it follows. The keys are
        // the string values of the kAudioAggregateDevice… constants;
        // `tapautostart` spares an explicit start ordering, and drift
        // compensation keeps the tap aligned to the output's clock.
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

        let pair = |key: &str, value: CFString| (CFString::new(key).as_CFType(), value.as_CFType());
        let flag = |key: &str, value: bool| {
            (
                CFString::new(key).as_CFType(),
                if value {
                    CFBoolean::true_value().as_CFType()
                } else {
                    CFBoolean::false_value().as_CFType()
                },
            )
        };
        let sub_device = CFDictionary::from_CFType_pairs(&[pair("uid", CFString::new(&output_uid))]);
        let sub_tap = CFDictionary::from_CFType_pairs(&[
            pair("uid", CFString::new(tap_uuid)),
            flag("drift", true),
        ]);
        let aggregate = CFDictionary::from_CFType_pairs(&[
            pair(
                "uid",
                CFString::new(&format!("app.reflect.tap-probe-{}", std::process::id())),
            ),
            pair("name", CFString::new("Reflect system audio probe")),
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
            // Toll-free bridge: core-foundation's CFDictionaryRef is the same
            // object the generated signature asks for.
            AudioHardwareCreateAggregateDevice(
                &*(aggregate.as_concrete_TypeRef() as *const objc2_core_foundation::CFDictionary),
                NonNull::from(&mut aggregate_id),
            )
        };
        if status != 0 {
            return Err(format!(
                "AudioHardwareCreateAggregateDevice failed (OSStatus {status})"
            ));
        }

        let nonzero = Arc::new(AtomicU64::new(0));
        let io_block = {
            let nonzero = nonzero.clone();
            RcBlock::new(
                move |_now: NonNull<AudioTimeStamp>,
                      input: NonNull<AudioBufferList>,
                      _input_time: NonNull<AudioTimeStamp>,
                      _output: NonNull<AudioBufferList>,
                      _output_time: NonNull<AudioTimeStamp>| {
                    // Counting is all the probe needs; the recorder that
                    // follows this plan is what writes files.
                    unsafe {
                        let list = input.as_ref();
                        let buffers = std::slice::from_raw_parts(
                            list.mBuffers.as_ptr(),
                            list.mNumberBuffers.min(8) as usize,
                        );
                        let Some(first) = buffers.first().filter(|b| !b.mData.is_null()) else {
                            return;
                        };
                        let count = first.mDataByteSize as usize / 4;
                        if count == 0 {
                            return;
                        }
                        let samples = std::slice::from_raw_parts(first.mData as *const f32, count);
                        let loud = samples.iter().filter(|sample| **sample != 0.0).count();
                        if loud > 0 {
                            nonzero.fetch_add(loud as u64, Ordering::Relaxed);
                        }
                    }
                },
            )
        };

        let queue = DispatchQueue::new("app.reflect.tap-probe", None);
        let mut proc_id: AudioDeviceIOProcID = None;
        let create = unsafe {
            AudioDeviceCreateIOProcIDWithBlock(
                NonNull::from(&mut proc_id),
                aggregate_id,
                Some(&queue),
                &*io_block as *const _ as *mut _,
            )
        };
        if create != 0 {
            unsafe {
                let _ = AudioHardwareDestroyAggregateDevice(aggregate_id);
            }
            return Err(format!(
                "AudioDeviceCreateIOProcIDWithBlock failed (OSStatus {create})"
            ));
        }

        let started = unsafe { AudioDeviceStart(aggregate_id, proc_id) };
        if started == 0 {
            std::thread::sleep(std::time::Duration::from_millis(duration_ms));
            unsafe {
                let _ = AudioDeviceStop(aggregate_id, proc_id);
            }
        }
        // Read the output's state before tearing the aggregate down: it is
        // half the verdict, and destroying the device can stop the render.
        let rendering = output_is_rendering(default_output);
        unsafe {
            let _ = AudioDeviceDestroyIOProcID(aggregate_id, proc_id);
            let _ = AudioHardwareDestroyAggregateDevice(aggregate_id);
        }
        if started != 0 {
            return Err(format!("AudioDeviceStart failed (OSStatus {started})"));
        }

        Ok(if nonzero.load(Ordering::Relaxed) > 0 {
            SystemAudioPreflight::Granted
        } else if rendering {
            SystemAudioPreflight::SilentWhilePlaying
        } else {
            SystemAudioPreflight::Inconclusive
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::SystemAudioPreflight;

    pub fn supported() -> bool {
        false
    }

    pub fn preflight(_duration_ms: u64) -> SystemAudioPreflight {
        SystemAudioPreflight::Unsupported
    }
}
