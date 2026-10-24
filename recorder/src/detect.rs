//! Deciding whether an open microphone means a call.
//!
//! `capture` reports which processes hold the microphone and what their app's
//! windows are called; everything here is the judgement on top. It stays
//! separate from the capture because these lists are the part that rots:
//! Slack will change its window titles long before Core Audio changes its
//! property selectors.

use std::time::{Duration, Instant};

use crate::capture::CallCandidate;

/// Apps that only ever open the microphone for a call, so the microphone
/// alone settles it.
///
/// An allowlist rather than a set of exceptions, because a system daemon like
/// `historicalaudiod` holds the microphone permanently and is excluded
/// precisely by not being here.
pub const CALL_APPS: &[&str] = &[
    "Slack.app",
    "zoom.us.app",
    "Microsoft Teams.app",
    "Discord.app",
    "FaceTime.app",
];

/// Apps that do everything, so an open microphone proves nothing on its own.
pub const BROWSER_APPS: &[&str] = &[
    "Dia.app",
    "Google Chrome.app",
    "Safari.app",
    "Firefox.app",
    "Arc.app",
    "Microsoft Edge.app",
    "Brave Browser.app",
];

/// What a call window is called.
///
/// Matched case-insensitively against every window of a browser, because a
/// huddle opens as its own window beside the tabs — the observed title is
/// `- ADIPA - Slack`, which carries the workspace and, once someone answers,
/// the person on the other end.
pub const CALL_WINDOW_PATTERNS: &[&str] = &[
    "- slack",
    "meet.google.com",
    "meet –",
    "meet -",
    "zoom",
    "teams",
];

/// The candidate's window that looks like a call, if any.
pub fn call_window(candidate: &CallCandidate) -> Option<&str> {
    candidate.windows.iter().find_map(|title| {
        let folded = title.to_lowercase();
        CALL_WINDOW_PATTERNS
            .iter()
            .any(|pattern| folded.contains(pattern))
            .then_some(title.as_str())
    })
}

/// Is this open microphone a call?
///
/// Deliberately loose. A browser playing a voice assistant with a Slack
/// window open elsewhere passes, and that is accepted: the countdown is
/// cancelable, and a session nobody else spoke in is discarded before it
/// costs anything. Tightening this — demanding the matching window be
/// frontmost — is the refinement to reach for only if the false positives
/// actually appear.
pub fn is_call(candidate: &CallCandidate) -> bool {
    if CALL_APPS.contains(&candidate.app.as_str()) {
        return true;
    }
    BROWSER_APPS.contains(&candidate.app.as_str()) && call_window(candidate).is_some()
}

/// Which candidate to record once the situation has settled.
///
/// One Slack call rings in the desktop app *and* the browser, so the first
/// candidate to appear may be the one merely ringing — attaching to it
/// records a ringtone and then silence. Waiting lets the extra doors close,
/// and the survivor is the call someone actually answered.
///
/// Identity is the pid: an app can close one call window and open the next
/// without its process changing, and that is a new conversation, not this one
/// continuing.
pub fn settled<'a>(seen: &[CallCandidate], now: &'a [CallCandidate]) -> Option<&'a CallCandidate> {
    // Several survivors would mean two apps genuinely holding a call open at
    // once; one person holds one conversation, so the first is as good a
    // choice as any and there is nothing to weigh.
    now.iter()
        .find(|candidate| is_call(candidate) && seen.iter().any(|earlier| earlier.pid == candidate.pid))
}

/// How often the watcher looks.
pub const POLL: Duration = Duration::from_secs(2);

/// How long a candidate must persist before it is taken as a real call.
pub const SETTLE: Duration = Duration::from_secs(8);

/// How many empty polls end a recording. Four at two seconds is eight
/// seconds of nobody holding the microphone, which a brief device switch
/// mid-call does not reach.
pub const END_POLLS: u32 = 4;

/// What the watcher decided on one poll.
#[derive(Debug, PartialEq)]
pub enum Watch {
    /// Nothing is happening.
    Idle,
    /// A call appeared and is being waited out; the instant it settles.
    Settling(Instant),
    /// Start recording this process.
    Start(CallCandidate),
    /// The recorded call ended.
    Ended,
}

/// The call watcher: a small state machine polled on a timer.
///
/// Kept apart from the clock so it can be tested without waiting eight real
/// seconds for a settle.
pub struct Watcher {
    seen: Vec<CallCandidate>,
    settling_since: Option<Instant>,
    /// The process a live recording is following, and how many polls in a row
    /// have not found it.
    recording: Option<i64>,
    missing: u32,
    /// Left alone until its call ends: a call the user stopped or declined.
    excluded: Option<i64>,
}

impl Default for Watcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Watcher {
    pub fn new() -> Self {
        Self {
            seen: Vec::new(),
            settling_since: None,
            recording: None,
            missing: 0,
            excluded: None,
        }
    }

    /// Follow this process until its call ends.
    pub fn recording(&mut self, pid: i64) {
        self.recording = Some(pid);
        self.missing = 0;
        self.settling_since = None;
    }

    /// Leave this call alone until it ends — the user stopped or declined it.
    ///
    /// Not forever: the next call from the same app is a different
    /// conversation, and a Slack that stays silent for the rest of the
    /// session is a feature that broke.
    pub fn exclude(&mut self, pid: i64) {
        self.excluded = Some(pid);
        self.recording = None;
    }

    pub fn poll(&mut self, now: Instant, candidates: Vec<CallCandidate>) -> Watch {
        // A live recording only asks one question: is its call still up?
        if let Some(pid) = self.recording {
            if candidates.iter().any(|candidate| candidate.pid == pid) {
                self.missing = 0;
            } else {
                self.missing += 1;
                if self.missing >= END_POLLS {
                    self.recording = None;
                    self.missing = 0;
                    return Watch::Ended;
                }
            }
            return Watch::Idle;
        }

        // An excluded call is held until it actually ends.
        if let Some(pid) = self.excluded {
            if candidates.iter().any(|candidate| candidate.pid == pid) {
                self.seen = candidates;
                return Watch::Idle;
            }
            self.excluded = None;
        }

        let settled = settled(&self.seen, &candidates).cloned();
        self.seen = candidates;
        let Some(candidate) = settled else {
            self.settling_since = None;
            return Watch::Idle;
        };
        match self.settling_since {
            Some(since) if now.duration_since(since) >= SETTLE => {
                self.settling_since = None;
                Watch::Start(candidate)
            }
            Some(since) => Watch::Settling(since + SETTLE),
            None => {
                self.settling_since = Some(now);
                Watch::Settling(now + SETTLE)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(app: &str, pid: i64, windows: &[&str]) -> CallCandidate {
        CallCandidate {
            bundle_id: format!("com.test.{app}"),
            pid,
            app: app.to_string(),
            windows: windows.iter().map(|w| (*w).to_string()).collect(),
        }
    }

    #[test]
    fn a_call_app_needs_only_the_microphone() {
        assert!(is_call(&candidate("Slack.app", 1, &[])));
        assert!(is_call(&candidate("zoom.us.app", 1, &[])));
    }

    #[test]
    fn a_daemon_holding_the_microphone_is_not_a_call() {
        // Excluded by not being on the allowlist, which is the whole reason
        // the list is an allowlist.
        assert!(!is_call(&candidate("historicalaudiod", 1, &[])));
    }

    #[test]
    fn a_browser_needs_a_window_that_looks_like_a_call() {
        assert!(!is_call(&candidate("Google Chrome.app", 1, &["Gmail"])));
        assert!(is_call(&candidate("Google Chrome.app", 1, &["meet.google.com/abc"])));
        assert!(is_call(&candidate("Dia.app", 1, &["Matías - ADIPA - Slack"])));
    }

    #[test]
    fn matches_a_window_title_whatever_its_case() {
        assert!(is_call(&candidate("Safari.app", 1, &["ZOOM Meeting"])));
    }

    #[test]
    fn waits_for_the_extra_doors_to_close() {
        // One Slack call rings in the app and the browser; the survivor is
        // the one someone answered.
        let ringing = vec![candidate("Slack.app", 1, &[]), candidate("Dia.app", 2, &["- ADIPA - Slack"])];
        let answered = vec![candidate("Dia.app", 2, &["Matías - ADIPA - Slack"])];
        assert_eq!(settled(&ringing, &answered).map(|c| c.pid), Some(2));
    }

    #[test]
    fn takes_nothing_the_previous_poll_had_not_seen() {
        let now = vec![candidate("Slack.app", 1, &[])];
        assert!(settled(&[], &now).is_none());
    }

    #[test]
    fn starts_only_after_the_settle_has_elapsed() {
        let mut watcher = Watcher::new();
        let start = Instant::now();
        let slack = vec![candidate("Slack.app", 7, &[])];

        assert_eq!(watcher.poll(start, slack.clone()), Watch::Idle); // first sighting
        assert!(matches!(watcher.poll(start, slack.clone()), Watch::Settling(_)));
        assert!(matches!(
            watcher.poll(start + SETTLE / 2, slack.clone()),
            Watch::Settling(_)
        ));
        assert_eq!(
            watcher.poll(start + SETTLE, slack).map_start(),
            Some(7),
        );
    }

    #[test]
    fn forgets_a_candidate_that_went_away_mid_settle() {
        let mut watcher = Watcher::new();
        let start = Instant::now();
        let slack = vec![candidate("Slack.app", 7, &[])];
        watcher.poll(start, slack.clone());
        watcher.poll(start, slack.clone());
        assert_eq!(watcher.poll(start, vec![]), Watch::Idle);
        // The settle restarts rather than resuming where it left off.
        assert!(matches!(watcher.poll(start, slack.clone()), Watch::Idle));
        assert!(matches!(watcher.poll(start, slack), Watch::Settling(_)));
    }

    #[test]
    fn ends_a_recording_only_after_several_empty_polls() {
        // A brief device switch mid-call must not end the meeting.
        let mut watcher = Watcher::new();
        let now = Instant::now();
        watcher.recording(7);
        for _ in 0..END_POLLS - 1 {
            assert_eq!(watcher.poll(now, vec![]), Watch::Idle);
        }
        assert_eq!(watcher.poll(now, vec![]), Watch::Ended);
    }

    #[test]
    fn a_call_that_comes_back_resets_the_count() {
        let mut watcher = Watcher::new();
        let now = Instant::now();
        watcher.recording(7);
        watcher.poll(now, vec![]);
        watcher.poll(now, vec![candidate("Slack.app", 7, &[])]);
        for _ in 0..END_POLLS - 1 {
            assert_eq!(watcher.poll(now, vec![]), Watch::Idle);
        }
        assert_eq!(watcher.poll(now, vec![]), Watch::Ended);
    }

    #[test]
    fn an_excluded_call_is_left_alone_until_it_ends() {
        let mut watcher = Watcher::new();
        let now = Instant::now();
        let slack = vec![candidate("Slack.app", 7, &[])];
        watcher.exclude(7);

        // Offered nothing while that call is still up, however long it lasts.
        for _ in 0..10 {
            assert_eq!(watcher.poll(now, slack.clone()), Watch::Idle);
        }
        // Once it ends the exclusion lifts: the next call is a different
        // conversation.
        watcher.poll(now, vec![]);
        watcher.poll(now, slack.clone());
        assert!(matches!(watcher.poll(now, slack), Watch::Settling(_)));
    }

    impl Watch {
        fn map_start(&self) -> Option<i64> {
            match self {
                Watch::Start(candidate) => Some(candidate.pid),
                _ => None,
            }
        }
    }
}
