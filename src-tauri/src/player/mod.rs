//! The libmpv core behind the video (spec 4.2, 5.1): its threads, the options Kaleido enforces
//! and the events it sends to the UI.

pub mod command;
pub mod engine;
pub mod load;
pub mod options;
pub mod resume;
pub mod state;

pub use command::{CommandError, PlayerCommand, to_mpv};
pub use engine::{
    ENGINE_OBSERVE_BASE, Engine, EngineConfig, EntryOptions, EventLoop, QUIT_TIMEOUT, Request,
    Restart, RestartError,
};
pub use load::{LoadIssue, LoadMode, open_sources};
pub use state::{EndReason, EventSink, LogLine, PlayerEvent, StateLoop, observe_all, snapshot};

/// The event that tells the UI the core was restarted ("Použít" for plugins, spec 6.3); its
/// payload is `{}`. The new core reports every observed property itself.
pub const ENGINE_RESTARTED_EVENT: &str = "player:engine-restarted";

#[cfg(test)]
pub(crate) mod testing {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use mpv_ffi::{Event, Mpv};

    use super::{Engine, EngineConfig, EventLoop};
    use crate::paths::AppPaths;

    /// Kaleido's folders under `root`, created as at startup.
    pub fn temp_paths(root: &Path) -> AppPaths {
        let install = root.join("Install");
        let paths = AppPaths::from_roots(
            &root.join("Roaming"),
            &root.join("Local"),
            &install,
            &root.join("Desktop"),
            &install,
        );
        paths.ensure_dirs().unwrap();
        paths
    }

    /// No window and no audio device.
    pub fn headless(paths: AppPaths) -> EngineConfig {
        EngineConfig {
            paths,
            wid: None,
            vo: "null".into(),
            ao: Some("null".into()),
        }
    }

    /// `seconds` of 64×36 uncompressed video in `dir`.
    pub fn clip(dir: &Path, seconds: usize) -> PathBuf {
        let path = dir.join("clip.y4m");
        mpv_ffi::testing::write_y4m(&path, 64, 36, seconds * 30).unwrap();
        path
    }

    /// Asks the engine until `check` holds; panics after 5 s.
    pub fn eventually(
        engine: &Engine,
        what: &str,
        check: impl Fn(&Mpv) -> bool + Send + Sync + 'static,
    ) {
        let check = Arc::new(check);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let check = Arc::clone(&check);
            if engine.call(move |mpv| check(mpv)) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting until {what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub struct NoEvents;

    impl EventLoop for NoEvents {
        fn on_event(&mut self, _mpv: &Mpv, _event: Event) {}

        fn on_idle(&mut self, _mpv: &Mpv) -> Option<Duration> {
            None
        }
    }

    /// Keeps every event the event thread delivers.
    #[derive(Clone, Default)]
    pub struct Recorded(Arc<Mutex<Vec<Event>>>);

    impl EventLoop for Recorded {
        fn on_event(&mut self, _mpv: &Mpv, event: Event) {
            self.0.lock().unwrap().push(event);
        }

        fn on_idle(&mut self, _mpv: &Mpv) -> Option<Duration> {
            None
        }
    }

    impl Recorded {
        pub fn events(&self) -> Vec<Event> {
            self.0.lock().unwrap().clone()
        }

        /// Waits until `done` accepts the events so far; panics after `timeout`.
        pub fn wait_until(&self, what: &str, timeout: Duration, done: impl Fn(&[Event]) -> bool) {
            let deadline = Instant::now() + timeout;
            loop {
                let events = self.events();
                if done(&events) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting until {what}: {events:#?}"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
