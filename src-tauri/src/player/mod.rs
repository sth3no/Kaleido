//! The libmpv core behind the video (spec 4.2, 5.1): its threads and the options Kaleido
//! enforces.

pub mod engine;
pub mod options;

pub use engine::{Engine, EngineConfig, EventLoop, Request};

#[cfg(test)]
pub(crate) mod testing {
    use std::path::Path;
    use std::time::Duration;

    use mpv_ffi::{Event, Mpv};

    use super::{EngineConfig, EventLoop};
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

    pub struct NoEvents;

    impl EventLoop for NoEvents {
        fn on_event(&mut self, _mpv: &Mpv, _event: Event) {}

        fn on_idle(&mut self, _mpv: &Mpv) -> Option<Duration> {
            None
        }
    }
}
