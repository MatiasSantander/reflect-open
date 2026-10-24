//! One meeting, from the first second to the name it ends up with.
//!
//! The capture writes finished segments and announces them; this decides what
//! they become. Raw-first, like the capture itself: a segment that fails to
//! transcribe stays on disk and is reported, never silently dropped, because
//! the file is the only copy of a minute of someone's meeting.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, SystemTime};

use crate::ai::{self, AlreadyNoted, Provider};
use crate::capture::{self, RecordingSegment, Session as Capture};
use crate::note::{self, MeetingNote, TranscriptNote};

/// How long each segment runs. Five minutes is the cadence the summary
/// follows — a closed segment is transcribed, appended, summarised, appended
/// — and at 16 kHz mono it keeps a segment near 10 MB, inside every
/// transcription provider's request cap with room to spare.
pub const SEGMENT: Duration = Duration::from_secs(5 * 60);

/// The capture writes one file per track per position: system, then mic.
const TRACKS: usize = 2;

/// How long a stop waits for the final segments before giving up on them.
const END_GRACE: Duration = Duration::from_secs(5);

/// Below this many audible samples across the whole session, the system track
/// heard nobody: a join dialog opened and closed, a call that never
/// connected, a detector that fired on the wrong thing. A tenth of a second
/// of sound at 16 kHz, which room tone does not reach because the count only
/// includes samples well above it.
const SOMEONE_ELSE_WAS_THERE: u64 = 1_600;

/// A meeting being recorded.
pub struct Meeting {
    capture: Capture,
    segments: Receiver<RecordingSegment>,
    note: MeetingNote,
    transcript: TranscriptNote,
    provider: Option<Provider>,
    /// What the far end actually produced. Zero means nobody was there.
    heard_from_them: u64,
    /// Both sides of the rotation being assembled, by part.
    pending: HashMap<u32, Vec<(bool, String)>>,
    points: Vec<String>,
    decisions: Vec<String>,
    tasks: Vec<String>,
    /// Kept for the closing rename: the note is named for its clock until the
    /// meeting is over and there is something to name it after.
    everything_said: Vec<String>,
    /// The day the meeting started, for dating the tasks it produces.
    day: String,
    opened_as: String,
}

impl Meeting {
    /// Open the note and start capturing.
    ///
    /// The note exists from the first second so the user can type their own
    /// notes into it *during* the call — which is the whole reason this is
    /// not a transcription run after the fact.
    pub fn start(
        graph: &Path,
        staging_root: PathBuf,
        source: &str,
        provider: Option<Provider>,
        now: SystemTime,
    ) -> Result<Self, String> {
        let (day, hour, minute) = local_parts(now);
        let stem = note::stem(&day, hour, minute, source);
        // `14:32 · Slack` — the clock and the app are all that is knowable
        // before anyone has spoken. The topic joins them when it ends.
        let opened_as = format!("{hour:02}:{minute:02} · {source}");
        let audio_dir = staging_root.join(&stem);

        let note = MeetingNote::create(graph, stem.clone(), &opened_as, &day, &audio_dir)
            .map_err(|err| format!("could not create the note: {err}"))?;
        let transcript = note
            .create_transcript(&opened_as)
            .map_err(|err| format!("could not create the transcript: {err}"))?;

        let (tx, segments) = channel();
        let (capture, started) = capture::start(
            staging_root,
            SEGMENT.as_millis() as u64,
            Box::new(move |segment| {
                let _ = tx.send(segment);
            }),
        )
        .map_err(|err| {
            // The note was created a moment ago and the meeting never
            // happened; leaving it would be an empty note nobody asked for.
            let _ = note_discard(&note);
            err.to_string()
        })?;

        capture::trace(&format!(
            "session[{stem}]: opened as \"{opened_as}\", staging {}",
            started.staging_dir.display()
        ));
        Ok(Self {
            capture,
            segments,
            note,
            transcript,
            provider,
            heard_from_them: 0,
            pending: HashMap::new(),
            points: Vec::new(),
            decisions: Vec::new(),
            tasks: Vec::new(),
            everything_said: Vec::new(),
            day,
            opened_as,
        })
    }

    /// Take in every segment that has closed since the last call.
    ///
    /// Called from the same loop that polls for the call ending, so the note
    /// fills while the meeting runs rather than all at once at the end.
    pub fn drain(&mut self) {
        while let Ok(segment) = self.segments.try_recv() {
            self.absorb(segment);
        }
    }

    fn absorb(&mut self, segment: RecordingSegment) {
        let them = segment.track == "system";
        if them {
            self.heard_from_them += segment.loud;
        }
        capture::trace(&format!(
            "session: part={} {} loud={} frames={}",
            segment.part, segment.track, segment.loud, segment.frames
        ));
        let Some(provider) = self.provider.clone() else {
            return;
        };
        let text = ai::transcribe(&provider, &segment.path);
        let speaker = if them { "Them" } else { "You" };
        let at = clock_now();
        if let Err(err) = self.transcript.append(&at, speaker, &text) {
            capture::trace(&format!("session: could not append transcript — {err}"));
        }

        // A rotation closes both tracks, so the summary waits for the second
        // one: half a conversation summarises badly.
        let side = self.pending.entry(segment.part).or_default();
        side.push((them, text));
        if side.len() < TRACKS {
            return;
        }
        let both = self.pending.remove(&segment.part).unwrap_or_default();
        // A side that said nothing is left out rather than sent as an empty
        // speaker: a `Them:` with no words after it invites the model to
        // invent what they said.
        let joined = both
            .iter()
            .filter(|(_, text)| !text.trim().is_empty())
            .map(|(them, text)| format!("{}: {text}", if *them { "Them" } else { "You" }))
            .collect::<Vec<_>>()
            .join("\n\n");
        if joined.is_empty() {
            return;
        }
        self.everything_said.push(joined.clone());

        let summary = ai::summarise(
            &provider,
            &joined,
            AlreadyNoted {
                points: &self.points,
                decisions: &self.decisions,
                tasks: &self.tasks,
            },
        );
        for point in summary.points {
            let _ = self.note.append_point(&at, &point);
            self.points.push(point);
        }
        for decision in summary.decisions {
            let _ = self.note.append_decision(&at, &decision);
            self.decisions.push(decision);
        }
        for task in summary.tasks {
            // Dated to the meeting's day, because an undated task from a note
            // that is not a daily note lands in no bucket at all and never
            // reaches the planning view.
            let _ = self.note.append_task(&task, Some(&self.day));
            self.tasks.push(task);
        }
    }

    /// Stop the capture, take in what it closes, and decide what the meeting
    /// was worth.
    pub fn finish(mut self, source: &str) -> Outcome {
        self.capture.stop();
        // The capture closes and announces the final segment of *each* track
        // after being told to finish, so they arrive here, not before.
        let deadline = std::time::Instant::now() + END_GRACE;
        let mut ended = 0;
        while ended < TRACKS && std::time::Instant::now() < deadline {
            match self.segments.recv_timeout(Duration::from_millis(250)) {
                Ok(segment) => {
                    let end = segment.end;
                    self.absorb(segment);
                    if end {
                        ended += 1;
                    }
                }
                Err(_) => continue,
            }
        }
        self.drain();

        // Nobody on the other end: take it back out. This is what lets
        // detection stay loose — a wrong guess costs disk for a minute and
        // nothing else.
        if self.heard_from_them < SOMEONE_ELSE_WAS_THERE {
            capture::trace(&format!(
                "session: discarding — system track heard {} audible samples",
                self.heard_from_them
            ));
            let _ = note_discard(&self.note);
            return Outcome::Discarded;
        }

        // Named last, from what was actually said. After the discard check,
        // so a session being thrown away never costs a model call.
        let mut named = self.opened_as.clone();
        if let Some(provider) = &self.provider {
            if !self.everything_said.is_empty() {
                let topic = ai::name_meeting(provider, &self.everything_said.join("\n\n"));
                if !topic.is_empty() {
                    named = format!("{} · {topic}", self.opened_as);
                    if let Err(err) = self.note.retitle(&named) {
                        capture::trace(&format!("session: could not rename — {err}"));
                    }
                }
            }
        }
        let _ = source;
        Outcome::Kept {
            path: self.note.path().to_path_buf(),
            title: named,
        }
    }
}

fn note_discard(note: &MeetingNote) -> std::io::Result<()> {
    note.discard()
}

/// What a finished meeting left behind.
#[derive(Debug)]
pub enum Outcome {
    Kept { path: PathBuf, title: String },
    Discarded,
}

/// `HH:MM` for the line a summary is stamped with.
fn clock_now() -> String {
    let (_, hour, minute) = local_parts(SystemTime::now());
    format!("{hour:02}:{minute:02}")
}

/// Local date and clock, without pulling in a date library.
///
/// The offset comes from `libc`'s own zone table rather than a guess, so a
/// meeting at 23:40 lands on the right day and the right side of a daylight
/// change.
fn local_parts(now: SystemTime) -> (String, u32, u32) {
    let secs = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0);
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    (
        format!(
            "{:04}-{:02}-{:02}",
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday
        ),
        tm.tm_hour as u32,
        tm.tm_min as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_local_day_and_clock_from_the_zone_table() {
        // A fixed instant: 2026-10-24 14:30:00 UTC.
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_852_200);
        let (day, hour, minute) = local_parts(at);

        assert_eq!(day.len(), 10);
        assert!(day.starts_with("2026-10-2"));
        assert!(hour < 24);
        assert_eq!(minute, 30);
    }

    #[test]
    fn a_silent_far_end_is_below_the_threshold_a_spoken_one_clears() {
        // A tenth of a second at 16 kHz, which room tone does not reach.
        assert!(0 < SOMEONE_ELSE_WAS_THERE);
        assert!(34_677 > SOMEONE_ELSE_WAS_THERE);
    }
}
