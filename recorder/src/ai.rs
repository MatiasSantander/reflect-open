//! The two provider calls: turn a segment into words, and turn words into
//! the few lines worth keeping.
//!
//! Both are best-effort by design. The audio on disk is the durable thing; a
//! failed transcription costs a paragraph of a note, and a thrown error would
//! cost the rest of the meeting.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

/// Long enough for five minutes of audio over a slow link, short enough that
/// a hung provider cannot outlive the meeting.
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(180);

/// A summary pass must never delay the next segment, so it is given less time
/// than a segment takes to record.
const SUMMARY_TIMEOUT: Duration = Duration::from_secs(60);

const TRANSCRIPTION_MODEL: &str = "gpt-4o-transcribe";
const TRANSCRIPTION_FALLBACK: &str = "whisper-1";

/// Who to ask, and with what key.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Provider {
    /// The chat model that writes the summary and names the meeting.
    pub model: String,
    pub api_key: String,
}

/// What a segment's worth of conversation produced.
#[derive(Debug, Default, Clone)]
pub struct Summary {
    pub points: Vec<String>,
    pub decisions: Vec<String>,
    pub tasks: Vec<String>,
}

/// The two provider calls, behind a trait.
///
/// Not for taste — for testability. What can fail silently here is the
/// *orchestration*: whether a summary reaches the note, whether a silent far
/// end is discarded, whether the rename lands. None of that needs a real
/// provider to be wrong, and all of it needs one to be tested against the
/// network.
pub trait Assistant {
    fn transcribe(&self, wav: &Path) -> String;
    fn summarise(&self, segment: &str, so_far: AlreadyNoted<'_>) -> Summary;
    fn name_meeting(&self, transcript: &str) -> String;
}

impl Assistant for Provider {
    fn transcribe(&self, wav: &Path) -> String {
        transcribe(self, wav)
    }
    fn summarise(&self, segment: &str, so_far: AlreadyNoted<'_>) -> Summary {
        summarise(self, segment, so_far)
    }
    fn name_meeting(&self, transcript: &str) -> String {
        name_meeting(self, transcript)
    }
}

/// Transcribe one WAV file.
///
/// Empty on failure, which is the honest answer: the file is still on disk,
/// and a meeting that loses one paragraph is better than one that stops.
pub fn transcribe(provider: &Provider, wav: &Path) -> String {
    match attempt_transcribe(provider, wav, TRANSCRIPTION_MODEL) {
        Ok(text) => text,
        // A model the account cannot reach is the one failure worth a second
        // try, because the fallback is universally available.
        Err(first) => match attempt_transcribe(provider, wav, TRANSCRIPTION_FALLBACK) {
            Ok(text) => text,
            Err(second) => {
                crate::capture::trace(&format!(
                    "ai: transcription failed for {} — {first}; fallback — {second}",
                    wav.display()
                ));
                String::new()
            }
        },
    }
}

fn attempt_transcribe(provider: &Provider, wav: &Path, model: &str) -> Result<String, String> {
    let audio = std::fs::read(wav).map_err(|err| err.to_string())?;
    let name = wav
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("segment.wav");
    let (content_type, body) = multipart(&[("model", model.as_bytes())], name, &audio);

    let response = ureq::post("https://api.openai.com/v1/audio/transcriptions")
        .set("Authorization", &format!("Bearer {}", provider.api_key))
        .set("Content-Type", &content_type)
        .timeout(TRANSCRIBE_TIMEOUT)
        .send_bytes(&body)
        .map_err(|err| err.to_string())?;

    #[derive(Deserialize)]
    struct Transcription {
        text: String,
    }
    let parsed: Transcription = response.into_json().map_err(|err| err.to_string())?;
    Ok(parsed.text.trim().to_string())
}

/// Build a `multipart/form-data` body by hand.
///
/// A dependency for this would be a dependency to keep current; the format is
/// a boundary, a header per part and a trailer, and the audio is the only
/// part that is not a short string.
fn multipart(fields: &[(&str, &[u8])], filename: &str, audio: &[u8]) -> (String, Vec<u8>) {
    let boundary = format!("----reflect-recorder-{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(audio.len() + 512);
    for (name, value) in fields {
        let _ = write!(
            body,
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
        );
        body.extend_from_slice(value);
        body.extend_from_slice(b"\r\n");
    }
    let _ = write!(
        body,
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
         Content-Type: audio/wav\r\n\r\n"
    );
    body.extend_from_slice(audio);
    let _ = write!(body, "\r\n--{boundary}--\r\n");
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// What is already in the note, so the model does not write it twice.
pub struct AlreadyNoted<'a> {
    pub points: &'a [String],
    pub decisions: &'a [String],
    pub tasks: &'a [String],
}

/// Summarise one segment of conversation.
///
/// Empty on failure or on a stretch with nothing in it — a meeting note that
/// stays quiet about a quiet five minutes is correct, not broken.
pub fn summarise(provider: &Provider, segment: &str, so_far: AlreadyNoted<'_>) -> Summary {
    if segment.trim().is_empty() {
        return Summary::default();
    }
    let prompt = summary_prompt(segment, &so_far);
    match ask_json(provider, &prompt, SUMMARY_TIMEOUT) {
        Ok(value) => Summary {
            points: strings(&value, "points"),
            decisions: strings(&value, "decisions"),
            tasks: strings(&value, "tasks")
                .into_iter()
                .filter(|task| has_an_owner(task))
                .collect(),
        },
        Err(err) => {
            // The transcript is already in the note; a missing summary line
            // is a smaller loss than an error that takes the segment with it.
            crate::capture::trace(&format!("ai: summary failed — {err}"));
            Summary::default()
        }
    }
}

fn listed(label: &str, lines: &[String]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let body: Vec<String> = lines.iter().map(|line| format!("- {line}")).collect();
    format!("{label} already noted:\n{}\n\n", body.join("\n"))
}

fn summary_prompt(segment: &str, so_far: &AlreadyNoted<'_>) -> String {
    format!(
        "You are keeping notes during a live meeting. Below is the last few\n\
         minutes of transcript. Write in the language the meeting is in.\n\n\
         Return three lists, and prefer returning nothing to returning filler:\n\n\
         points — what someone who missed these minutes needs to know. Facts,\n\
         \x20 numbers, positions taken, problems raised. Not a retelling: if a line\n\
         \x20 could be dropped without losing information, drop it.\n\n\
         decisions — only what was settled. \"We will go with three colegios\" is a\n\
         \x20 decision; \"we talked about how many colegios\" is not.\n\n\
         tasks — only commitments with a clear owner, phrased as an imperative\n\
         \x20 starting with the name: \"Martín: enviar el detalle de precios\".\n\
         \x20 **If you cannot tell who committed, leave the task out entirely.**\n\
         \x20 Never write that the owner is unclear, unidentified, or uncertain —\n\
         \x20 a task nobody owns is not a task. One line each, no explanation.\n\n\
         Nothing here repeats what is already noted below. If this stretch only\n\
         added detail to something already written, return empty lists.\n\n\
         {}{}{}Transcript:\n{segment}",
        listed("Points", so_far.points),
        listed("Decisions", so_far.decisions),
        listed("Tasks", so_far.tasks),
    )
}

/// Drop a task the model hedged anyway.
///
/// The prompt asks it not to, and it mostly obeys, but "responsable no
/// identificado" surviving into a checkbox is the failure that makes a whole
/// list ignorable — so it is checked twice.
fn has_an_owner(task: &str) -> bool {
    const HEDGES: &[&str] = &[
        "no identificad",
        "sin identificar",
        "no queda confirmado",
        "unclear",
        "unidentified",
        "not confirmed",
        "alguien",
        "someone",
    ];
    let folded = task.to_lowercase();
    !HEDGES.iter().any(|hedge| folded.contains(hedge))
}

/// Name a meeting from what was said in it.
///
/// Short on purpose: the note's name already carries the clock and the app,
/// and this is the third part — the topic. "Ajustes de la landing", not
/// "Reunión sobre los ajustes pendientes de la landing page".
pub fn name_meeting(provider: &Provider, transcript: &str) -> String {
    if transcript.trim().is_empty() {
        return String::new();
    }
    let head: String = transcript.chars().take(20_000).collect();
    let prompt = format!(
        "Below is a meeting transcript. Name what it was about in at most six\n\
         words, in the language of the meeting. No date, no \"reunión\", no\n\
         punctuation at the end — just the subject, as a colleague would say\n\
         it when asked what the call was about.\n\n\
         Reply as JSON: {{\"topic\": \"...\"}}\n\n{head}"
    );
    match ask_json(provider, &prompt, SUMMARY_TIMEOUT) {
        Ok(value) => value
            .get("topic")
            .and_then(|topic| topic.as_str())
            .map(clean_topic)
            .unwrap_or_default(),
        Err(err) => {
            // The note keeps the name it opened with, which is still a real
            // name.
            crate::capture::trace(&format!("ai: naming failed — {err}"));
            String::new()
        }
    }
}

fn clean_topic(topic: &str) -> String {
    topic
        .trim()
        .chars()
        .filter(|c| !matches!(c, '.' | '·' | '|' | '[' | ']' | '/'))
        .collect::<String>()
        .trim()
        .to_string()
}

fn strings(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|list| list.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// One chat completion, asked for JSON and parsed as such.
fn ask_json(
    provider: &Provider,
    prompt: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let response = ureq::post("https://api.openai.com/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", provider.api_key))
        .timeout(timeout)
        .send_json(serde_json::json!({
            "model": provider.model,
            "response_format": { "type": "json_object" },
            "messages": [{ "role": "user", "content": prompt }],
        }))
        .map_err(|err| err.to_string())?;

    #[derive(Deserialize)]
    struct Choice {
        message: Message,
    }
    #[derive(Deserialize)]
    struct Message {
        content: String,
    }
    #[derive(Deserialize)]
    struct Completion {
        choices: Vec<Choice>,
    }
    let completion: Completion = response.into_json().map_err(|err| err.to_string())?;
    let content = completion
        .choices
        .first()
        .map(|choice| choice.message.content.as_str())
        .ok_or("the provider returned no choices")?;
    serde_json::from_str(content).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_a_task_the_model_hedged_anyway() {
        assert!(has_an_owner("Martín: enviar el detalle de precios"));
        assert!(!has_an_owner("Enviar precios (responsable no identificado)"));
        assert!(!has_an_owner("Someone should follow up"));
        assert!(!has_an_owner("Alguien tiene que confirmar la fecha"));
    }

    #[test]
    fn hands_back_what_is_already_noted_so_it_is_not_repeated() {
        let points = vec!["ya dicho".to_string()];
        let prompt = summary_prompt(
            "hola",
            &AlreadyNoted { points: &points, decisions: &[], tasks: &[] },
        );
        assert!(prompt.contains("Points already noted:\n- ya dicho"));
        // Empty lists say nothing at all rather than an empty heading.
        assert!(!prompt.contains("Decisions already noted"));
        assert!(prompt.ends_with("Transcript:\nhola"));
    }

    #[test]
    fn says_nothing_about_a_stretch_with_nothing_in_it() {
        let provider = Provider { model: "x".into(), api_key: String::new() };
        let summary = summarise(
            &provider,
            "   ",
            AlreadyNoted { points: &[], decisions: &[], tasks: &[] },
        );
        assert!(summary.points.is_empty() && summary.decisions.is_empty() && summary.tasks.is_empty());
    }

    #[test]
    fn strips_the_punctuation_a_title_must_not_carry() {
        // `·` separates the note's own name parts; a topic carrying one would
        // read as an extra section.
        assert_eq!(clean_topic("  Precios · por colegio.  "), "Precios  por colegio");
    }

    #[test]
    fn builds_a_multipart_body_the_endpoint_can_parse() {
        let (content_type, body) = multipart(&[("model", b"whisper-1")], "part.wav", b"RIFF");
        let text = String::from_utf8_lossy(&body);
        let boundary = content_type.split("boundary=").nth(1).unwrap();
        assert!(text.contains(&format!("--{boundary}\r\n")));
        assert!(text.contains("name=\"model\"\r\n\r\nwhisper-1"));
        assert!(text.contains("filename=\"part.wav\""));
        assert!(text.contains("Content-Type: audio/wav"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
    }

    #[test]
    fn reads_the_three_lists_out_of_a_reply() {
        let value = serde_json::json!({
            "points": ["uno", "  ", "dos"],
            "decisions": [],
            "tasks": ["Ana: mandar", "Someone will do it"],
        });
        assert_eq!(strings(&value, "points"), vec!["uno", "dos"]);
        assert!(strings(&value, "decisions").is_empty());
        // The hedge filter runs over tasks, not here.
        assert_eq!(strings(&value, "tasks").len(), 2);
    }
}
