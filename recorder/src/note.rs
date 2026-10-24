//! The meeting note: the one file this program writes into the graph.
//!
//! Everything here follows `FORMAT.md`, which is the contract with Reflect.
//! The two rules worth repeating where the code can see them:
//!
//! - **Append, never rewrite.** The user is typing in this file while the
//!   meeting runs. Every append re-reads it first, because a cached copy is
//!   stale by exactly the words they just wrote.
//! - **A deleted note stays deleted.** If the file is gone when a segment
//!   lands, that is a decision, not a glitch.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Where the running summary accumulates.
const KEY_POINTS: &str = "Puntos clave";

/// Where what was actually settled goes, separate from what was discussed.
const DECISIONS: &str = "Decisiones";

/// Where commitments made out loud become checkboxes.
const TASKS: &str = "Tareas";

/// The directory inside the graph, ours alone.
const MEETINGS_DIR: &str = "meetings";

/// A meeting's note: its address on disk, fixed when the meeting opened.
pub struct MeetingNote {
    path: PathBuf,
    /// The filename stem, which is also the wikilink alias.
    stem: String,
}

impl MeetingNote {
    /// Create the note a meeting is about to fill.
    ///
    /// `started` is the local clock the filename and the opening title are
    /// built from, `source` the app the call was detected in, `day` the ISO
    /// date the note links to.
    pub fn create(
        graph: &Path,
        stem: String,
        title: &str,
        day: &str,
        audio_dir: &Path,
    ) -> io::Result<Self> {
        let dir = graph.join(MEETINGS_DIR);
        fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{stem}.md"));
        let body = [
            "---".to_string(),
            format!("id: {}", uuid::Uuid::new_v4()),
            format!("aliases: [{stem}]"),
            "---".to_string(),
            String::new(),
            format!("# {title}"),
            String::new(),
            "- Type: #meeting".to_string(),
            // The link to the day, so the day's backlinks list this meeting
            // without anyone writing into the daily note.
            format!("- [[{day}]]"),
            format!("- Audio: `{}`", audio_dir.display()),
            String::new(),
            // The gap the user types in. Left empty on purpose: the first
            // thing they should see is their own cursor.
            String::new(),
            format!("## {KEY_POINTS}"),
            String::new(),
            format!("## {DECISIONS}"),
            String::new(),
            format!("## {TASKS}"),
            String::new(),
        ]
        .join("\n");
        fs::write(&path, body)?;
        Ok(Self { path, stem })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Create the transcript note beside the meeting, cross-linked.
    pub fn create_transcript(&self, title: &str) -> io::Result<TranscriptNote> {
        let path = self.path.with_file_name(format!("{}-transcript.md", self.stem));
        let body = [
            "---".to_string(),
            format!("id: {}", uuid::Uuid::new_v4()),
            format!("aliases: [{}-transcript]", self.stem),
            "---".to_string(),
            String::new(),
            format!("# {title} · transcript"),
            String::new(),
            "- Type: #meeting".to_string(),
            format!("- [[{}|{title}]]", self.stem),
            String::new(),
        ]
        .join("\n");
        fs::write(&path, body)?;
        Ok(TranscriptNote { path })
    }

    /// Append one bullet under the running summary.
    pub fn append_point(&self, at: &str, text: &str) -> io::Result<()> {
        self.append_under(KEY_POINTS, &format!("**{at}** {text}"))
    }

    /// Append one decision. Settled things only — the discussion is above.
    pub fn append_decision(&self, at: &str, text: &str) -> io::Result<()> {
        self.append_under(DECISIONS, &format!("**{at}** {text}"))
    }

    /// Append one task as an unticked checkbox — ordinary markdown, so it is
    /// a task everywhere in Reflect and not a thing this program invented.
    pub fn append_task(&self, text: &str, due: Option<&str>) -> io::Result<()> {
        // A due date is an ordinary `[[YYYY-MM-DD]]` wikilink, which is what
        // puts the task in Reflect's Current or Overdue bucket instead of
        // leaving it undated under its own note forever.
        let line = match due {
            Some(day) => format!("[ ] {text} [[{day}]]"),
            None => format!("[ ] {text}"),
        };
        self.append_under(TASKS, &line)
    }

    /// The transcript's path, whether or not it exists.
    pub fn transcript_path(&self) -> PathBuf {
        self.path.with_file_name(format!("{}-transcript.md", self.stem))
    }

    /// Rename the meeting once there is something to name it after.
    ///
    /// The heading only. The filename is an address, and an address that
    /// moves breaks every link into it.
    pub fn retitle(&self, title: &str) -> io::Result<()> {
        let Some(source) = self.read()? else {
            return Ok(());
        };
        let renamed: Vec<String> = source
            .lines()
            .scan(false, |done, line| {
                if !*done && line.starts_with("# ") {
                    *done = true;
                    Some(format!("# {title}"))
                } else {
                    Some(line.to_string())
                }
            })
            .collect();
        fs::write(&self.path, format!("{}\n", renamed.join("\n")))?;
        // The transcript's heading and its link back both name the meeting,
        // so both go stale on a rename.
        let transcript = self.transcript_path();
        if let Ok(source) = fs::read_to_string(&transcript) {
            let fixed: Vec<String> = source
                .lines()
                .map(|line| {
                    if line.starts_with("# ") {
                        format!("# {title} · transcript")
                    } else if line.starts_with(&format!("- [[{}|", self.stem)) {
                        format!("- [[{}|{title}]]", self.stem)
                    } else {
                        line.to_string()
                    }
                })
                .collect();
            fs::write(&transcript, format!("{}\n", fixed.join("\n")))?;
        }
        Ok(())
    }

    /// Take the note back out — a meeting nobody else spoke in.
    ///
    /// Nothing else references it, because nothing was ever written into the
    /// daily note. That is the whole reason the link points the other way.
    pub fn discard(&self) -> io::Result<()> {
        for path in [self.path.clone(), self.transcript_path()] {
            match fs::remove_file(&path) {
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                other => other?,
            }
        }
        Ok(())
    }

    /// Read the note as it is right now, or `None` if the user deleted it.
    fn read(&self) -> io::Result<Option<String>> {
        match fs::read_to_string(&self.path) {
            Ok(source) => Ok(Some(source)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Insert `line` as the last bullet of `heading`'s section.
    ///
    /// Always a fresh read: the user is typing in this note while the append
    /// happens, so a cached copy would be stale by exactly the words they
    /// just wrote.
    fn append_under(&self, heading: &str, line: &str) -> io::Result<()> {
        let Some(source) = self.read()? else {
            return Ok(());
        };
        let wanted = format!("## {heading}");
        let lines: Vec<&str> = source.lines().collect();
        let Some(start) = lines.iter().position(|candidate| *candidate == wanted) else {
            // The user removed the section. Their note, their headings.
            return Ok(());
        };
        // The section runs to the next heading of any level, or the end.
        let end = lines
            .iter()
            .skip(start + 1)
            .position(|candidate| candidate.starts_with("## "))
            .map(|offset| start + 1 + offset)
            .unwrap_or(lines.len());
        // Past the section's trailing blank lines, so bullets stay together
        // and the blank line before the next heading survives.
        let mut at = end;
        while at > start + 1 && lines[at - 1].trim().is_empty() {
            at -= 1;
        }
        let mut next: Vec<String> = lines.iter().map(|line| (*line).to_string()).collect();
        next.insert(at, format!("- {line}"));
        fs::write(&self.path, format!("{}\n", next.join("\n")))
    }
}

/// `2026-10-24-1113-slack` — the filename stem and the wikilink alias.
///
/// Built from the meeting's start so it sorts chronologically and cannot
/// collide inside a minute.
pub fn stem(day: &str, hour: u32, minute: u32, source: &str) -> String {
    let slug: String = source
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        format!("{day}-{hour:02}{minute:02}")
    } else {
        format!("{day}-{hour:02}{minute:02}-{slug}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A graph in a temp directory, removed when the test ends.
    struct Graph(PathBuf);

    impl Graph {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("recorder-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn note(&self) -> MeetingNote {
            MeetingNote::create(
                &self.0,
                "2026-10-24-1113-slack".into(),
                "11:13 · Slack",
                "2026-10-24",
                Path::new("/tmp/audio"),
            )
            .unwrap()
        }
        fn read(&self, note: &MeetingNote) -> String {
            fs::read_to_string(note.path()).unwrap()
        }
    }

    impl Drop for Graph {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_the_note_the_contract_describes() {
        let graph = Graph::new("create");
        let note = graph.note();
        let body = graph.read(&note);

        assert!(note.path().ends_with("meetings/2026-10-24-1113-slack.md"));
        assert!(body.contains("aliases: [2026-10-24-1113-slack]"));
        assert!(body.contains("# 11:13 · Slack"));
        assert!(body.contains("- Type: #meeting"));
        // The link points at the day, so the daily note is never written to.
        assert!(body.contains("- [[2026-10-24]]"));
        assert!(body.contains("## Puntos clave"));
        assert!(body.contains("## Decisiones"));
        assert!(body.contains("## Tareas"));
    }

    #[test]
    fn mints_a_fresh_id_for_each_meeting() {
        let graph = Graph::new("ids");
        let first = graph.read(&graph.note());
        let second = MeetingNote::create(
            &graph.0,
            "other".into(),
            "t",
            "2026-10-24",
            Path::new("/tmp/a"),
        )
        .unwrap();
        assert_ne!(
            first.lines().find(|l| l.starts_with("id: ")),
            graph.read(&second).lines().find(|l| l.starts_with("id: ")),
        );
    }

    #[test]
    fn puts_each_kind_of_line_under_its_own_heading() {
        let graph = Graph::new("sections");
        let note = graph.note();
        note.append_point("11:20", "Vamos con tres colegios").unwrap();
        note.append_decision("11:22", "Partimos en agosto").unwrap();
        note.append_task("Martín: enviar precios", None).unwrap();

        let body = graph.read(&note);
        let points = body.split("## Decisiones").next().unwrap();
        let decisions = body.split("## Decisiones").nth(1).unwrap().split("## Tareas").next().unwrap();
        let tasks = body.split("## Tareas").nth(1).unwrap();
        assert!(points.contains("- **11:20** Vamos con tres colegios"));
        assert!(decisions.contains("- **11:22** Partimos en agosto"));
        assert!(tasks.contains("- [ ] Martín: enviar precios"));
    }

    #[test]
    fn keeps_appended_lines_in_order() {
        let graph = Graph::new("order");
        let note = graph.note();
        note.append_point("11:20", "primero").unwrap();
        note.append_point("11:25", "segundo").unwrap();

        let body = graph.read(&note);
        assert!(body.find("primero").unwrap() < body.find("segundo").unwrap());
    }

    #[test]
    fn dates_a_task_so_it_reaches_the_planning_view() {
        // Undated, a task from a meeting note lands under its own note and
        // never appears in Current or Overdue.
        let graph = Graph::new("due");
        let note = graph.note();
        note.append_task("Ana: mandar el contrato", Some("2026-10-27")).unwrap();

        assert!(graph.read(&note).contains("- [ ] Ana: mandar el contrato [[2026-10-27]]"));
    }

    #[test]
    fn never_drops_what_the_user_typed() {
        let graph = Graph::new("user-text");
        let note = graph.note();
        let typed = fs::read_to_string(note.path())
            .unwrap()
            .replace("## Puntos clave", "mis propias notas\n\n## Puntos clave");
        fs::write(note.path(), typed).unwrap();

        note.append_point("11:30", "del modelo").unwrap();

        let body = graph.read(&note);
        assert!(body.contains("mis propias notas"));
        assert!(body.contains("del modelo"));
    }

    #[test]
    fn retitles_the_heading_and_nothing_else() {
        let graph = Graph::new("retitle");
        let note = graph.note();
        let before = note.path().to_path_buf();
        note.retitle("11:13 · Slack · Precios por colegio").unwrap();

        let body = graph.read(&note);
        assert!(body.contains("# 11:13 · Slack · Precios por colegio"));
        // The filename is an address: it does not move.
        assert_eq!(note.path(), before);
        assert!(body.contains("aliases: [2026-10-24-1113-slack]"));
    }

    #[test]
    fn respects_a_note_the_user_deleted_mid_meeting() {
        let graph = Graph::new("deleted");
        let note = graph.note();
        fs::remove_file(note.path()).unwrap();

        note.append_point("11:30", "algo").unwrap();
        note.retitle("otro").unwrap();

        assert!(!note.path().exists());
    }

    #[test]
    fn discards_without_leaving_anything_behind() {
        let graph = Graph::new("discard");
        let note = graph.note();
        note.discard().unwrap();
        assert!(!note.path().exists());
        // Twice is safe: a stop can race a manual delete.
        note.discard().unwrap();
    }

    #[test]
    fn builds_a_stem_that_sorts_and_survives_a_strange_app_name() {
        assert_eq!(stem("2026-10-24", 11, 13, "Slack"), "2026-10-24-1113-slack");
        assert_eq!(stem("2026-10-24", 9, 5, "zoom.us"), "2026-10-24-0905-zoom-us");
        assert_eq!(stem("2026-10-24", 9, 5, ""), "2026-10-24-0905");
    }
}

/// The transcript note: one long thing in the order it was said.
pub struct TranscriptNote {
    path: PathBuf,
}

impl TranscriptNote {
    /// Append one segment's transcript, labelled by who spoke and by the time
    /// it was said — a reader looking for "what did they say around 17:20" is
    /// the only reader a transcript ever has.
    pub fn append(&self, at: &str, speaker: &str, text: &str) -> io::Result<()> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        // Straight onto the end: it has no sections, being one long thing in
        // the order it was said.
        let Ok(source) = fs::read_to_string(&self.path) else {
            // Deleted mid-meeting. Their note, their decision.
            return Ok(());
        };
        fs::write(
            &self.path,
            format!("{}\n\n- **{at} · {speaker}** — {text}\n", source.trim_end()),
        )
    }
}

#[cfg(test)]
mod transcript_tests {
    use super::*;

    fn graph(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("recorder-tn-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pair(dir: &Path) -> (MeetingNote, TranscriptNote) {
        let note = MeetingNote::create(
            dir,
            "2026-10-24-1113-slack".into(),
            "11:13 · Slack",
            "2026-10-24",
            Path::new("/tmp/a"),
        )
        .unwrap();
        let transcript = note.create_transcript("11:13 · Slack").unwrap();
        (note, transcript)
    }

    #[test]
    fn writes_the_transcript_beside_the_meeting_cross_linked() {
        let dir = graph("beside");
        let (note, _) = pair(&dir);
        let body = fs::read_to_string(note.transcript_path()).unwrap();

        assert!(note.transcript_path().ends_with("2026-10-24-1113-slack-transcript.md"));
        assert!(body.contains("# 11:13 · Slack · transcript"));
        assert!(body.contains("- Type: #meeting"));
        assert!(body.contains("- [[2026-10-24-1113-slack|11:13 · Slack]]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn labels_each_line_by_who_spoke_and_keeps_the_meeting_note_short() {
        let dir = graph("labels");
        let (note, transcript) = pair(&dir);
        transcript.append("11:20", "Them", "¿Cuántos colegios?").unwrap();
        transcript.append("11:20", "You", "Tres por ahora").unwrap();

        let body = fs::read_to_string(note.transcript_path()).unwrap();
        assert!(body.contains("- **11:20 · Them** — ¿Cuántos colegios?"));
        assert!(body.contains("- **11:20 · You** — Tres por ahora"));
        // The long thing stays out of the note that gets read.
        assert!(!fs::read_to_string(note.path()).unwrap().contains("Tres por ahora"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn says_nothing_about_a_side_that_said_nothing() {
        let dir = graph("silent");
        let (note, transcript) = pair(&dir);
        let before = fs::read_to_string(note.transcript_path()).unwrap();
        transcript.append("11:20", "Them", "   ").unwrap();
        assert_eq!(fs::read_to_string(note.transcript_path()).unwrap(), before);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rename_reaches_the_transcript_and_its_link_back() {
        let dir = graph("rename");
        let (note, _) = pair(&dir);
        note.retitle("11:13 · Slack · Precios por colegio").unwrap();

        let body = fs::read_to_string(note.transcript_path()).unwrap();
        assert!(body.contains("# 11:13 · Slack · Precios por colegio · transcript"));
        assert!(body.contains("- [[2026-10-24-1113-slack|11:13 · Slack · Precios por colegio]]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn discarding_takes_both_files() {
        let dir = graph("discard-both");
        let (note, _) = pair(&dir);
        note.discard().unwrap();
        assert!(!note.path().exists());
        assert!(!note.transcript_path().exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
