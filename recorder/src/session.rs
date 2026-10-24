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

use crate::ai::{AlreadyNoted, Assistant, Provider};
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
    /// `None` only in tests, which feed segments directly.
    capture: Option<Capture>,
    segments: Receiver<RecordingSegment>,
    note: MeetingNote,
    transcript: TranscriptNote,
    assistant: Option<Box<dyn Assistant>>,
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
        let (tx, segments) = channel();
        let mut meeting = Self::open(
            graph,
            &staging_root,
            source,
            provider.map(|p| Box::new(p) as Box<dyn Assistant>),
            now,
            segments,
        )?;
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
            let _ = meeting.note.discard();
            err.to_string()
        })?;
        capture::trace(&format!(
            "session: opened as \"{}\", staging {}",
            meeting.opened_as,
            started.staging_dir.display()
        ));
        meeting.capture = Some(capture);
        Ok(meeting)
    }

    /// Everything `start` does except touch the hardware.
    ///
    /// Split out so the part that can fail silently — whether a summary
    /// reaches the note, whether a silent far end is discarded, whether the
    /// rename lands — can be tested without a microphone and without a
    /// provider.
    fn open(
        graph: &Path,
        staging_root: &Path,
        source: &str,
        assistant: Option<Box<dyn Assistant>>,
        now: SystemTime,
        segments: Receiver<RecordingSegment>,
    ) -> Result<Self, String> {
        let (day, hour, minute) = local_parts(now);
        let stem = note::stem(&day, hour, minute, source);
        // `14:32 · Slack` — the clock and the app are all that is knowable
        // before anyone has spoken. The topic joins them when it ends.
        let opened_as = format!("{hour:02}:{minute:02} · {source}");
        let audio_dir = staging_root.join(&stem);

        let note = MeetingNote::create(graph, stem, &opened_as, &day, &audio_dir)
            .map_err(|err| format!("could not create the note: {err}"))?;
        let transcript = note
            .create_transcript(&opened_as)
            .map_err(|err| format!("could not create the transcript: {err}"))?;

        Ok(Self {
            capture: None,
            segments,
            note,
            transcript,
            assistant,
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
        if self.assistant.is_none() {
            return;
        }
        let text = self.assistant.as_ref().expect("checked").transcribe(&segment.path);
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

        let summary = self.assistant.as_ref().expect("checked").summarise(
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
        if let Some(capture) = &self.capture {
            capture.stop();
        }
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
            let _ = self.note.discard();
            return Outcome::Discarded;
        }

        // Named last, from what was actually said. After the discard check,
        // so a session being thrown away never costs a model call.
        let mut named = self.opened_as.clone();
        if let Some(assistant) = &self.assistant {
            if !self.everything_said.is_empty() {
                let topic = assistant.name_meeting(&self.everything_said.join("\n\n"));
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
    use crate::ai::Summary;
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, Mutex};

    /// An assistant that answers from a script, and remembers what it was
    /// asked — which is how the "does it hand back what is already noted"
    /// rule gets checked without a network.
    #[derive(Default)]
    struct Scripted {
        /// Keyed by the WAV's filename, so each track answers differently.
        transcripts: HashMap<String, String>,
        summaries: Mutex<Vec<Summary>>,
        name: String,
        asked: Arc<Mutex<Vec<String>>>,
        tasks_seen: Arc<Mutex<Vec<Vec<String>>>>,
        /// Set by the test that checks a side transcribing to nothing.
        silence_is_the_point: bool,
    }

    impl Assistant for Scripted {
        fn transcribe(&self, wav: &Path) -> String {
            let key = wav.file_name().unwrap_or_default().to_string_lossy().to_string();
            if let Some(scripted) = self.transcripts.get(&key) {
                return scripted.clone();
            }
            // Unscripted parts still say *something*, unless the test asked
            // for silence by scripting the other track and not this one.
            match (self.transcripts.is_empty(), key.contains("system")) {
                (false, _) if self.silence_is_the_point => String::new(),
                (_, true) => "algo dijeron".into(),
                (_, false) => "algo dije".into(),
            }
        }
        fn summarise(&self, segment: &str, so_far: AlreadyNoted<'_>) -> Summary {
            self.asked.lock().unwrap().push(segment.to_string());
            self.tasks_seen.lock().unwrap().push(so_far.tasks.to_vec());
            let mut queue = self.summaries.lock().unwrap();
            if queue.is_empty() { Summary::default() } else { queue.remove(0) }
        }
        fn name_meeting(&self, _transcript: &str) -> String {
            self.name.clone()
        }
    }

    struct Fixture {
        graph: PathBuf,
        meeting: Option<Meeting>,
        feed: Sender<RecordingSegment>,
    }

    impl Fixture {
        fn new(name: &str, assistant: Option<Box<dyn Assistant>>) -> Self {
            let graph = std::env::temp_dir().join(format!("recorder-sess-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&graph);
            std::fs::create_dir_all(graph.join("notes")).unwrap();
            let (feed, segments) = channel();
            let meeting = Meeting::open(
                &graph,
                &graph.join("audio"),
                "Slack",
                assistant,
                SystemTime::now(),
                segments,
            )
            .unwrap();
            Self { graph, meeting: Some(meeting), feed }
        }

        /// Both sides of one rotation, which is what the capture announces.
        fn rotation(&self, part: u32, them_loud: u64, end: bool) {
            for (track, loud) in [("system", them_loud), ("mic", 40_000)] {
                let _ = self.feed.send(RecordingSegment {
                    part,
                    end,
                    track,
                    path: PathBuf::from(format!("part-{part:03}.{track}.wav")),
                    frames: 48_000,
                    loud,
                    rate: 16_000,
                });
            }
        }

        fn note_body(&self) -> String {
            let meeting = self.meeting.as_ref().unwrap();
            std::fs::read_to_string(meeting.note.path()).unwrap()
        }

        fn transcript_body(&self) -> String {
            let meeting = self.meeting.as_ref().unwrap();
            std::fs::read_to_string(meeting.note.transcript_path()).unwrap()
        }

        fn finish(&mut self) -> Outcome {
            self.meeting.take().unwrap().finish("Slack")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.graph);
        }
    }

    fn scripted() -> (Box<Scripted>, Arc<Mutex<Vec<String>>>, Arc<Mutex<Vec<Vec<String>>>>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let tasks_seen = Arc::new(Mutex::new(Vec::new()));
        let mut transcripts = HashMap::new();
        transcripts.insert("part-001.system.wav".into(), "¿Cuántos colegios?".to_string());
        transcripts.insert("part-001.mic.wav".into(), "Tres por ahora".to_string());
        let assistant = Box::new(Scripted {
            transcripts,
            summaries: Mutex::new(vec![Summary {
                points: vec!["Hablaron de cobertura".into()],
                decisions: vec!["Partimos con tres colegios".into()],
                tasks: vec!["Martín: enviar precios".into()],
            }]),
            name: "Precios por colegio".into(),
            asked: asked.clone(),
            tasks_seen: tasks_seen.clone(),
            silence_is_the_point: false,
        });
        (assistant, asked, tasks_seen)
    }

    #[test]
    fn fills_the_note_while_the_meeting_runs() {
        let (assistant, _, _) = scripted();
        let mut fixture = Fixture::new("fills", Some(assistant));

        // The note exists before a single segment has closed: that is the
        // whole reason this is not a transcription run after the fact.
        assert!(fixture.note_body().contains("## Puntos clave"));

        fixture.rotation(1, 50_000, false);
        fixture.meeting.as_mut().unwrap().drain();

        let body = fixture.note_body();
        assert!(body.contains("Hablaron de cobertura"), "{body}");
        assert!(body.contains("Partimos con tres colegios"), "{body}");
        // Dated, or it lands in no bucket and never reaches the Tasks view.
        assert!(body.contains("- [ ] Martín: enviar precios [["), "{body}");

        let transcript = fixture.transcript_body();
        assert!(transcript.contains("· Them** — ¿Cuántos colegios?"));
        assert!(transcript.contains("· You** — Tres por ahora"));
        // The long thing stays out of the note that gets read.
        assert!(!fixture.note_body().contains("Tres por ahora"));
    }

    #[test]
    fn summarises_a_rotation_once_both_sides_have_landed() {
        let (assistant, asked, _) = scripted();
        let mut fixture = Fixture::new("both-sides", Some(assistant));

        // One side alone is half a conversation and summarises badly.
        let _ = fixture.feed.send(RecordingSegment {
            part: 1, end: false, track: "system",
            path: PathBuf::from("part-001.system.wav"),
            frames: 48_000, loud: 50_000, rate: 16_000,
        });
        fixture.meeting.as_mut().unwrap().drain();
        assert!(asked.lock().unwrap().is_empty());

        let _ = fixture.feed.send(RecordingSegment {
            part: 1, end: false, track: "mic",
            path: PathBuf::from("part-001.mic.wav"),
            frames: 48_000, loud: 40_000, rate: 16_000,
        });
        fixture.meeting.as_mut().unwrap().drain();
        assert_eq!(
            asked.lock().unwrap().as_slice(),
            ["Them: ¿Cuántos colegios?\n\nYou: Tres por ahora"],
        );
    }

    #[test]
    fn hands_back_the_tasks_already_written_so_they_are_not_repeated() {
        // The bug that produced eleven near-duplicates of four real tasks.
        let (assistant, _, tasks_seen) = scripted();
        let mut fixture = Fixture::new("no-repeats", Some(assistant));
        fixture.rotation(1, 50_000, false);
        fixture.meeting.as_mut().unwrap().drain();
        fixture.rotation(2, 50_000, false);
        fixture.meeting.as_mut().unwrap().drain();

        let seen = tasks_seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "the second rotation never reached the model");
        assert_eq!(seen[0], Vec::<String>::new());
        assert_eq!(seen[1], vec!["Martín: enviar precios".to_string()]);
    }

    #[test]
    fn leaves_a_silent_side_out_rather_than_sending_an_empty_speaker() {
        // Straight from a real session: the system track transcribed to
        // nothing. A `Them:` with no words invites the model to invent some.
        let asked = Arc::new(Mutex::new(Vec::new()));
        let mut transcripts = HashMap::new();
        transcripts.insert("part-001.mic.wav".into(), "cerremos con Next.js".to_string());
        let assistant = Box::new(Scripted {
            transcripts,
            asked: asked.clone(),
            silence_is_the_point: true,
            ..Default::default()
        });
        let mut fixture = Fixture::new("silent-side", Some(assistant));
        fixture.rotation(1, 50_000, false);
        fixture.meeting.as_mut().unwrap().drain();

        assert_eq!(asked.lock().unwrap().as_slice(), ["You: cerremos con Next.js"]);
    }

    #[test]
    fn discards_a_meeting_nobody_else_was_heard_in() {
        let (assistant, _, _) = scripted();
        let mut fixture = Fixture::new("discard", Some(assistant));
        let note = fixture.meeting.as_ref().unwrap().note.path().to_path_buf();
        let transcript = fixture.meeting.as_ref().unwrap().note.transcript_path();

        fixture.rotation(1, 0, true);
        assert!(matches!(fixture.finish(), Outcome::Discarded));

        assert!(!note.exists(), "the note survived a meeting nobody was in");
        assert!(!transcript.exists());
    }

    #[test]
    fn names_the_meeting_from_what_was_said_once_it_is_over() {
        let (assistant, _, _) = scripted();
        let mut fixture = Fixture::new("rename", Some(assistant));
        fixture.rotation(1, 50_000, true);

        let outcome = fixture.finish();
        let Outcome::Kept { path, title } = outcome else {
            panic!("a meeting somebody spoke in was discarded");
        };
        assert!(title.ends_with(" · Precios por colegio"), "{title}");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains(&format!("# {title}")));
        // The filename is an address: it does not move.
        assert!(path.to_string_lossy().contains("-slack.md"));
    }

    #[test]
    fn records_without_a_provider_because_the_audio_is_the_durable_part() {
        let mut fixture = Fixture::new("no-provider", None);
        fixture.rotation(1, 50_000, true);

        // Kept: somebody was heard. Named as it opened, with no model call.
        let Outcome::Kept { title, .. } = fixture.finish() else {
            panic!("discarded a meeting somebody spoke in");
        };
        assert!(title.ends_with(" · Slack"), "{title}");
    }

    #[test]
    fn reads_the_local_day_and_clock_from_the_zone_table() {
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_852_200);
        let (day, hour, minute) = local_parts(at);
        assert_eq!(day.len(), 10);
        assert!(day.starts_with("2026-10-2"));
        assert!(hour < 24);
        assert_eq!(minute, 30);
    }
}
