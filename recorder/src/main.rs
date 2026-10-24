//! The meeting recorder: a standalone program that watches for calls, records
//! them, and writes a note into a Reflect graph — sharing this repository
//! with Reflect and nothing else. See `FORMAT.md` for the contract.

mod ai;
mod capture;
mod config;
mod detect;
mod note;
mod session;

use std::path::PathBuf;
use std::time::Instant;

use config::Config;
use detect::{Watch, Watcher};
use session::{Meeting, Outcome};

fn staging_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("reflect-recorder")
        .join("sessions")
}

fn main() {
    capture::set_trace_path(
        dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("reflect-recorder")
            .join("recorder.log"),
    );
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check") => check(),
        Some("watch") => watch(),
        Some("record") => {
            let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(8);
            record(seconds);
        }
        _ => {
            eprintln!("usage: reflect-recorder <check | watch | record [seconds]>");
            std::process::exit(2);
        }
    }
}

/// What this machine will and will not let us do, before anything is started.
fn check() {
    println!("macOS 14.2+ taps supported:   {}", capture::supported());
    println!("screen & system audio granted: {}", capture::access_granted());
    println!("config:                        {}", Config::path().display());
    match Config::load() {
        Ok(config) => {
            println!("graph:                         {}", config.graph.display());
            println!(
                "provider:                      {}",
                config
                    .provider
                    .map(|p| p.model)
                    .unwrap_or_else(|| "none — records without transcribing".into())
            );
        }
        Err(err) => println!("config problem:\n{err}"),
    }
    let candidates = capture::call_candidates();
    if candidates.is_empty() {
        println!("call candidates:               none");
    } else {
        println!("call candidates:");
        for candidate in candidates {
            println!(
                "  {:<22} pid {:<7} call={} {:?}",
                candidate.app,
                candidate.pid,
                detect::is_call(&candidate),
                candidate.windows
            );
        }
    }
}

/// Watch for calls and record them. The whole program, in one loop.
fn watch() {
    let config = match Config::load() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    if !capture::access_granted() && !capture::request_access() {
        eprintln!("Screen & System Audio Recording is not granted, so a tap would deliver silence.");
        std::process::exit(1);
    }

    let mut watcher = Watcher::new();
    let mut meeting: Option<(Meeting, String, i64)> = None;
    println!("watching for calls. graph: {}", config.graph.display());

    loop {
        // Take in whatever closed while we were waiting, so the note fills
        // during the call rather than all at once at the end.
        if let Some((live, _, _)) = meeting.as_mut() {
            live.drain();
        }
        let decision = watcher.poll(Instant::now(), capture::call_candidates());
        match decision {
            Watch::Start(candidate) => {
                let source = source_name(&candidate.app);
                match Meeting::start(
                    &config.graph,
                    staging_root(),
                    &source,
                    config.provider.clone(),
                    std::time::SystemTime::now(),
                ) {
                    Ok(live) => {
                        println!("recording {source} (pid {})", candidate.pid);
                        watcher.recording(candidate.pid);
                        meeting = Some((live, source, candidate.pid));
                    }
                    Err(err) => {
                        eprintln!("could not start: {err}");
                        // Leave this call alone rather than failing at it
                        // every two seconds for as long as it lasts.
                        watcher.exclude(candidate.pid);
                    }
                }
            }
            Watch::Ended => {
                if let Some((live, source, _)) = meeting.take() {
                    match live.finish(&source) {
                        Outcome::Kept { path, title } => {
                            println!("kept “{title}” → {}", path.display());
                        }
                        Outcome::Discarded => {
                            println!("discarded — nobody else was heard");
                        }
                    }
                }
            }
            Watch::Settling(_) | Watch::Idle => {}
        }
        std::thread::sleep(detect::POLL);
    }
}

/// `Slack.app` → `Slack`: what the note is named after.
fn source_name(app: &str) -> String {
    app.strip_suffix(".app").unwrap_or(app).to_string()
}

/// Record for `seconds`, printing each segment as it closes — the smoke test
/// for the capture itself, with no note and no provider involved.
fn record(seconds: u64) {
    let (tx, rx) = std::sync::mpsc::channel();
    let started = capture::start(
        staging_root(),
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

#[cfg(test)]
mod tests {
    #[test]
    fn names_the_note_after_the_app_not_its_bundle() {
        assert_eq!(super::source_name("Slack.app"), "Slack");
        assert_eq!(super::source_name("zoom.us.app"), "zoom.us");
        assert_eq!(super::source_name("Dia.app"), "Dia");
    }
}
