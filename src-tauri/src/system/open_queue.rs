//! The one queue of open requests (spec 9.3): the first launch's command line, later launches,
//! the dialog, a paste and a drop. Nothing reaches the player before the UI is ready, and
//! requests that come in quick succession make one playlist.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::player::LoadMode;
use crate::player::load::{Source, ValidatedOptions};

/// Something to open, as it comes in.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OpenRequest {
    pub sources: Vec<Source>,
    /// `None` follows the open-while-playing setting.
    pub mode: Option<LoadMode>,
    pub options: ValidatedOptions,
}

/// What the player is given: a request with its mode decided.
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub sources: Vec<Source>,
    pub mode: LoadMode,
    pub options: ValidatedOptions,
}

pub struct OpenQueue {
    join_window: Duration,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    ready: bool,
    /// When the player was last given a batch.
    last: Option<Instant>,
    pending: Vec<OpenRequest>,
}

impl OpenQueue {
    pub fn new(join_window: Duration) -> OpenQueue {
        OpenQueue {
            join_window,
            state: Mutex::default(),
        }
    }

    /// Takes `req`, which came at `now`, and returns its batch if the UI is ready; otherwise
    /// the request waits for [`OpenQueue::ui_ready`]. A request with nothing to open is no
    /// batch. `default_mode` is the open-while-playing setting.
    pub fn submit(&self, now: Instant, req: OpenRequest, default_mode: LoadMode) -> Option<Batch> {
        if req.sources.is_empty() {
            return None;
        }
        let mut state = self.lock();
        if !state.ready {
            state.pending.push(req);
            return None;
        }
        Some(state.hand_over(now, req, default_mode, self.join_window))
    }

    /// The UI is ready (at `now`): returns the requests that waited, as batches in order. They
    /// are all handed over now, so after the first they join its playlist: nothing has played
    /// yet, and the files of one selection in Explorer may have come in several launches that
    /// a slow start spread out.
    pub fn ui_ready(&self, now: Instant, default_mode: LoadMode) -> Vec<Batch> {
        let mut state = self.lock();
        state.ready = true;
        let pending = std::mem::take(&mut state.pending);
        pending
            .into_iter()
            .map(|req| state.hand_over(now, req, default_mode, self.join_window))
            .collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // The state stays consistent at every step, so a panic elsewhere does not spoil it.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl State {
    /// The batch for `req`, handed to the player at `now`: within `join_window` of the previous
    /// one it joins that playlist (spec 9.3), otherwise its own mode or the setting applies.
    fn hand_over(
        &mut self,
        now: Instant,
        req: OpenRequest,
        default_mode: LoadMode,
        join_window: Duration,
    ) -> Batch {
        let joins = self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) <= join_window);
        self.last = Some(now);
        Batch {
            sources: req.sources,
            mode: if joins {
                LoadMode::Append
            } else {
                req.mode.unwrap_or(default_mode)
            },
            options: req.options,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    const WINDOW: Duration = Duration::from_millis(300);

    fn request(name: &str) -> OpenRequest {
        OpenRequest {
            sources: vec![Source::File(PathBuf::from(name))],
            ..OpenRequest::default()
        }
    }

    fn batch(name: &str, mode: LoadMode) -> Batch {
        Batch {
            sources: vec![Source::File(PathBuf::from(name))],
            mode,
            options: ValidatedOptions::default(),
        }
    }

    /// Taken over from the prototype: the first launch's files and a second launch that comes
    /// before the UI is ready both wait for it. Nothing has played yet, so they are handed over
    /// together, as one playlist.
    #[test]
    fn queue_waits_for_the_ui() {
        let queue = OpenQueue::new(WINDOW);
        let start = Instant::now();
        assert_eq!(
            queue.submit(start, request("first.mkv"), LoadMode::Replace),
            None
        );
        assert_eq!(
            queue.submit(
                start + Duration::from_secs(2),
                request("second.mkv"),
                LoadMode::Replace
            ),
            None
        );

        let ready = start + Duration::from_secs(3);
        assert_eq!(
            queue.ui_ready(ready, LoadMode::Replace),
            [
                batch("first.mkv", LoadMode::Replace),
                batch("second.mkv", LoadMode::Append),
            ]
        );
        assert!(queue.ui_ready(ready, LoadMode::Replace).is_empty());
    }

    /// Also from the prototype: once the UI is ready a request is handed over at once, and one
    /// with nothing to open is no batch (a launch without arguments only brings the window up).
    #[test]
    fn a_ready_ui_gets_requests_at_once_and_no_empty_batches() {
        let queue = OpenQueue::new(WINDOW);
        let start = Instant::now();
        assert!(queue.ui_ready(start, LoadMode::Replace).is_empty());

        assert_eq!(
            queue.submit(start, request("film.mkv"), LoadMode::Replace),
            Some(batch("film.mkv", LoadMode::Replace))
        );
        assert_eq!(
            queue.submit(start, OpenRequest::default(), LoadMode::Replace),
            None
        );
    }

    #[test]
    fn requests_within_300_ms_join_one_playlist() {
        let queue = OpenQueue::new(WINDOW);
        let start = Instant::now();
        queue.ui_ready(start, LoadMode::Replace);

        assert_eq!(
            queue.submit(start, request("a.mkv"), LoadMode::Replace),
            Some(batch("a.mkv", LoadMode::Replace))
        );
        assert_eq!(
            queue.submit(
                start + Duration::from_millis(120),
                request("b.mkv"),
                LoadMode::Replace
            ),
            Some(batch("b.mkv", LoadMode::Append))
        );
        // Measured from the previous request, so a quick series stays one playlist.
        assert_eq!(
            queue.submit(
                start + Duration::from_millis(400),
                request("c.mkv"),
                LoadMode::Replace
            ),
            Some(batch("c.mkv", LoadMode::Append))
        );
        // Even a request that asks for a replace joins.
        let replace = OpenRequest {
            mode: Some(LoadMode::Replace),
            ..request("d.mkv")
        };
        assert_eq!(
            queue.submit(
                start + Duration::from_millis(500),
                replace,
                LoadMode::Replace
            ),
            Some(batch("d.mkv", LoadMode::Append))
        );
    }

    #[test]
    fn later_requests_follow_the_open_while_playing_setting() {
        let queue = OpenQueue::new(WINDOW);
        let start = Instant::now();
        queue.ui_ready(start, LoadMode::Append);

        assert_eq!(
            queue.submit(start, request("a.mkv"), LoadMode::Append),
            Some(batch("a.mkv", LoadMode::Append))
        );
        let later = start + Duration::from_millis(900);
        assert_eq!(
            queue.submit(later, request("b.mkv"), LoadMode::Append),
            Some(batch("b.mkv", LoadMode::Append))
        );

        // The request's own mode wins over the setting.
        let replace = OpenRequest {
            mode: Some(LoadMode::Replace),
            ..request("c.mkv")
        };
        assert_eq!(
            queue.submit(
                later + Duration::from_millis(900),
                replace,
                LoadMode::Append
            ),
            Some(batch("c.mkv", LoadMode::Replace))
        );
        // And the setting applies otherwise.
        assert_eq!(
            queue.submit(
                start + Duration::from_secs(5),
                request("d.mkv"),
                LoadMode::Replace
            ),
            Some(batch("d.mkv", LoadMode::Replace))
        );
    }

    /// Requests that waited for the UI were handed over at `ui_ready`, so one right after it
    /// still joins their playlist; one that comes later does not.
    #[test]
    fn the_join_window_counts_from_when_waiting_requests_were_handed_over() {
        let queue = OpenQueue::new(WINDOW);
        let start = Instant::now();
        queue.submit(start, request("first.mkv"), LoadMode::Replace);
        let ready = start + Duration::from_secs(2);
        assert_eq!(queue.ui_ready(ready, LoadMode::Replace).len(), 1);

        assert_eq!(
            queue.submit(
                ready + Duration::from_millis(100),
                request("b.mkv"),
                LoadMode::Replace
            ),
            Some(batch("b.mkv", LoadMode::Append))
        );
        assert_eq!(
            queue.submit(
                ready + Duration::from_secs(1),
                request("c.mkv"),
                LoadMode::Replace
            ),
            Some(batch("c.mkv", LoadMode::Replace))
        );
    }
}
