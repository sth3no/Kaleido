//! The libmpv core behind the video (spec 4.2, 5.1): its threads, the options Kaleido enforces
//! and the events it sends to the UI.

pub mod engine;
pub mod options;
pub mod state;

pub use engine::{ENGINE_OBSERVE_BASE, Engine, EngineConfig, EventLoop, Request};
pub use state::{EndReason, EventSink, LogLine, PlayerEvent, StateLoop, observe_all, snapshot};

#[cfg(test)]
pub(crate) mod testing {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
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
}
