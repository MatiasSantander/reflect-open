//! The meeting recorder: a standalone program that records a call, writes a
//! note into a Reflect graph, and shares this repository with Reflect and
//! nothing else. See `FORMAT.md` for the contract between the two.

mod capture;
mod note;

use std::path::PathBuf;
use std::sync::mpsc::channel;

fn staging_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("reflect-recorder")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check") => check(),
        Some("record") => {
            let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(8);
            record(seconds);
        }
        _ => {
            eprintln!("usage: reflect-recorder <check | record [seconds]>");
            std::process::exit(2);
        }
    }
}

/// What this machine will and will not let us do, before anything is started.
fn check() {
    println!("macOS 14.2+ taps supported: {}", capture::supported());
    println!("screen & system audio granted: {}", capture::access_granted());
    match capture::call_candidates() {
        candidates if candidates.is_empty() => println!("call candidates: none"),
        candidates => {
            println!("call candidates:");
            for candidate in candidates {
                println!("  {} ({}) {:?}", candidate.app, candidate.pid, candidate.windows);
            }
        }
    }
}

/// Record for `seconds`, printing each segment as it closes.
///
/// A `loud` of zero on the system track is the signature of a missing
/// permission, not of a quiet room: a tap created without it is created
/// happily and delivers digital silence.
fn record(seconds: u64) {
    capture::set_trace_path(staging_root().join("recorder.log"));
    let (tx, rx) = channel();
    let started = capture::start(
        staging_root().join("sessions"),
        // Rotate well inside the run so a short test still sees a rotation.
        (seconds * 1000).max(2_000) / 2,
        Box::new(move |segment| {
            let _ = tx.send(segment);
        }),
    );
    let (session, info) = match started {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("could not start: {err}");
            std::process::exit(1);
        }
    };
    println!("staging:    {}", info.staging_dir.display());
    println!("system:     {} Hz", info.system_rate);
    println!("microphone: {} Hz — {}", info.mic_rate, info.mic_device);
    println!("recording {seconds}s…");

    std::thread::sleep(std::time::Duration::from_secs(seconds));
    session.stop();
    // The capture closes each track after being told to finish, so the final
    // segments arrive here, not before.
    std::thread::sleep(std::time::Duration::from_millis(800));
    drop(session);

    let mut heard_from_them = 0;
    for segment in rx.try_iter() {
        println!(
            "  part={} {:<6} end={} frames={:<7} loud={:<8} {}",
            segment.part,
            segment.track,
            segment.end,
            segment.frames,
            segment.loud,
            segment.path.display()
        );
        if segment.track == "system" {
            heard_from_them += segment.loud;
        }
    }
    println!(
        "\nsystem track heard {heard_from_them} audible samples{}",
        if heard_from_them == 0 {
            " — silence, which is also what a missing permission looks like"
        } else {
            ""
        }
    );
}
