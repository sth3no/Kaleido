//! How files and links reach the player from outside and from the UI (spec 9.2, 9.3): the
//! command line, later launches, the open dialog, the clipboard and drag and drop. They all go
//! through one [`OpenQueue`] and are played by the same `player::load::open_checked`.

pub mod cli;
pub mod clipboard;
pub mod dialog;
pub mod drop;
pub mod instance;
pub mod open_queue;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::player::{self, Engine, LoadMode};
use open_queue::{Batch, OpenQueue, OpenRequest};

/// Kaleido's public roadmap (spec 11.7): the GitHub Project in the Kaleido repository, which the
/// repository's projects page shows once it exists.
pub const ROADMAP_URL: &str = "https://github.com/sth3no/Kaleido/projects";

/// Requests this close together make one playlist (spec 9.3).
pub const JOIN_WINDOW: Duration = Duration::from_millis(300);

/// What a file opened while another plays does ("chování při otevření souboru za běhu",
/// spec 8.10); Task 10 reads it from the settings.
const OPEN_WHILE_PLAYING: LoadMode = LoadMode::Replace;

/// The current value of every observed property, as `player::snapshot` reads it.
pub type Snapshot = BTreeMap<String, Value>;

/// The payload of `system:open-request`: Rust has handed the player `count` sources.
#[derive(Debug, Clone, Serialize)]
struct OpenRequestEvent {
    count: usize,
}

type Job = Box<dyn FnOnce() + Send>;

/// The thread that checks the sources of requests from outside the UI (a launch, a drop) and
/// queues them: the main thread must not wait for a slow disk or network share, and one thread
/// keeps the requests in the order they came, so a playlist keeps the order of its files.
pub struct OpenThread(mpsc::Sender<Job>);

impl OpenThread {
    pub fn start() -> OpenThread {
        let (jobs, queue) = mpsc::channel::<Job>();
        thread::Builder::new()
            .name("open-requests".into())
            .spawn(move || {
                for job in queue {
                    job();
                }
            })
            .expect("cannot start the open-requests thread");
        OpenThread(jobs)
    }
}

/// Runs `job` on the [`OpenThread`] after the jobs before it.
fn in_order(app: &AppHandle, job: impl FnOnce() + Send + 'static) {
    let queued = app
        .try_state::<OpenThread>()
        .is_some_and(|thread| thread.0.send(Box::new(job)).is_ok());
    if !queued {
        tracing::warn!("open request dropped: the open-requests thread is not running");
    }
}

/// Opens what a command line asks for: the first launch's own, or a later launch's (`args`
/// without the program name, relative to that process's `cwd`). It came at `arrived`.
pub fn open_command_line(app: &AppHandle, arrived: Instant, args: Vec<OsString>, cwd: PathBuf) {
    let handle = app.clone();
    in_order(app, move || {
        let request = cli::parse(args, &cwd);
        for (arg, error) in &request.rejected {
            tracing::warn!("cannot open {arg} from the command line: {error:?}");
        }
        open(
            &handle,
            arrived,
            OpenRequest {
                sources: request.sources,
                mode: request.mode,
                options: request.options,
            },
        );
    });
}

/// Held from the queue's decision until the batch is queued on the player. Requests come from
/// several threads (the open-requests thread, the dialog's, mpv's event thread), and a batch
/// must reach mpv in the order the queue gave it its mode: an append may not overtake the
/// replace before it. Queueing on the player does not wait for mpv, so it is held briefly.
static HANDOVER: Mutex<()> = Mutex::new(());

fn handover() -> MutexGuard<'static, ()> {
    HANDOVER.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Hands `req`, which came at `arrived`, to the queue and plays it as soon as the queue lets it
/// through (once the UI is ready).
pub fn open(app: &AppHandle, arrived: Instant, req: OpenRequest) {
    let _order = handover();
    let batch = app
        .try_state::<OpenQueue>()
        .and_then(|queue| queue.submit(arrived, req, OPEN_WHILE_PLAYING));
    if let Some(batch) = batch {
        play(app, batch);
    }
}

/// The UI has subscribed to the player's events: the requests that waited for it play, and it
/// gets the player's current state. Blocks until mpv answers, so not on the main thread.
pub fn ui_ready(app: &AppHandle) -> Snapshot {
    if let Some(queue) = app.try_state::<OpenQueue>() {
        let _order = handover();
        for batch in queue.ui_ready(Instant::now(), OPEN_WHILE_PLAYING) {
            play(app, batch);
        }
    }
    // Queued after the batches, so their files are in the snapshot's playlist.
    match app.try_state::<Engine>() {
        Some(engine) => engine.call(player::snapshot),
        None => Snapshot::new(),
    }
}

/// Queues `batch` on the player and tells the UI, which shows the player for it.
fn play(app: &AppHandle, batch: Batch) {
    let Some(engine) = app.try_state::<Engine>() else {
        tracing::warn!("open request dropped: the player is not running");
        return;
    };
    player::load::open_checked(&engine, &batch.sources, batch.mode, &batch.options);
    let event = OpenRequestEvent {
        count: batch.sources.len(),
    };
    if let Err(error) = app.emit("system:open-request", event) {
        tracing::warn!("cannot send system:open-request to the UI: {error}");
    }
}
