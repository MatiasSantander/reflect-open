//! Where the graph is and who to ask about the audio.
//!
//! A file rather than flags, because this runs unattended: the thing that
//! starts at login cannot be handed a key on a command line.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::ai::Provider;

#[derive(Debug, Deserialize)]
pub struct Config {
    /// The Reflect graph to write meeting notes into.
    pub graph: PathBuf,
    /// Omitted, the recorder still records — the audio is the durable part,
    /// and a meeting with no transcript is a meeting you can still listen to.
    #[serde(default)]
    pub provider: Option<Provider>,
}

impl Config {
    /// `~/.config/reflect-recorder/config.toml`, or wherever `RECORDER_CONFIG`
    /// points.
    ///
    /// `~/.config` rather than macOS's `Application Support`, which is where
    /// `dirs` would send it: this file is edited by hand, and a path with a
    /// space in it is a path people get wrong.
    pub fn path() -> PathBuf {
        std::env::var_os("RECORDER_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(std::env::temp_dir)
                    .join(".config")
                    .join("reflect-recorder")
                    .join("config.toml")
            })
    }

    pub fn load() -> Result<Self, String> {
        let path = Self::path();
        let source = std::fs::read_to_string(&path)
            .map_err(|err| format!("{}: {err}\n\n{}", path.display(), EXAMPLE))?;
        let config: Self = toml::from_str(&source).map_err(|err| format!("{}: {err}", path.display()))?;
        config.check()?;
        Ok(config)
    }

    /// Refuse a graph that is not one, now rather than at the first meeting.
    ///
    /// Writing a note into a directory that no longer holds a graph is how a
    /// meeting ends up somewhere nobody looks.
    fn check(&self) -> Result<(), String> {
        if !self.graph.is_dir() {
            return Err(format!("graph is not a directory: {}", self.graph.display()));
        }
        if !is_graph(&self.graph) {
            return Err(format!(
                "{} does not look like a Reflect graph (no .reflect, daily or notes directory)",
                self.graph.display()
            ));
        }
        Ok(())
    }
}

/// A graph is recognised by the directories Reflect itself makes.
fn is_graph(root: &Path) -> bool {
    ["\u{2e}reflect", "daily", "notes"]
        .iter()
        .any(|name| root.join(name).is_dir())
}

const EXAMPLE: &str = "\
Write a config file that looks like this:

  graph = \"/Users/you/Library/Mobile Documents/iCloud~app~reflect/Documents/Me\"

  [provider]
  model = \"gpt-6.1-sol\"
  api_key = \"sk-…\"

The provider is optional: without it the recorder still records, and the
audio is the durable part.";

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("recorder-cfg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recognises_a_graph_by_the_directories_reflect_makes() {
        let dir = temp("graph");
        assert!(!is_graph(&dir));
        std::fs::create_dir(dir.join("daily")).unwrap();
        assert!(is_graph(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_graph_that_is_not_one_before_the_first_meeting() {
        let dir = temp("not-a-graph");
        let config = Config { graph: dir.clone(), provider: None };
        let message = config.check().unwrap_err();
        assert!(message.contains("does not look like a Reflect graph"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn records_without_a_provider() {
        // The audio is the durable part; a meeting with no transcript is one
        // you can still listen to.
        let dir = temp("no-provider");
        std::fs::create_dir(dir.join("notes")).unwrap();
        let parsed: Config = toml::from_str(&format!("graph = {:?}", dir)).unwrap();
        assert!(parsed.provider.is_none());
        assert!(parsed.check().is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_the_provider_when_there_is_one() {
        let dir = temp("provider");
        std::fs::create_dir(dir.join("notes")).unwrap();
        let parsed: Config = toml::from_str(&format!(
            "graph = {:?}\n[provider]\nmodel = \"gpt-6.1-sol\"\napi_key = \"sk-test\"",
            dir
        ))
        .unwrap();
        let provider = parsed.provider.expect("a provider");
        assert_eq!(provider.model, "gpt-6.1-sol");
        assert_eq!(provider.api_key, "sk-test");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
