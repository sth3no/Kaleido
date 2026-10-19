//! How files and links reach the player from outside and from the UI (spec 9.2, 9.3): the
//! command line, later launches, the open dialog, the clipboard and drag and drop. They all go
//! through one [`OpenQueue`] and, like the UI's `player_load`, reach the player through
//! [`open_on_player`]. The browsers whose cookies yt-dlp can use for links are found by
//! [`browsers`].

pub mod browsers;
pub mod cli;
pub mod clipboard;
pub mod diagnostics;
pub mod dialog;
pub mod drop;
pub mod fatal;
pub mod instance;
pub mod logs;
pub mod open_queue;
pub mod shell_open;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::player::load::{Source, ValidatedOptions};
use crate::player::{self, Engine, LoadMode};
use crate::settings;
use crate::streams::Streams;
use open_queue::{Batch, OpenQueue, OpenRequest};

/// Kaleido's public roadmap (spec 11.7): the GitHub Project in the Kaleido repository, which the
/// repository's projects page shows once it exists.
pub const ROADMAP_URL: &str = "https://github.com/sth3no/Kaleido/projects";

/// Where every release of Kaleido is, with the tag of its sources (spec 11.6).
pub const KALEIDO_RELEASES_URL: &str = "https://github.com/sth3no/Kaleido/releases";

/// The sources of the libmpv build Kaleido ships (spec 11.6: the GPL asks for them). It is the
/// `url` of libmpv in `resources/licenses/extra.json`, which `libmpv_link_is_the_one_in_the_license_list`
/// holds to this constant, so the build is bumped in one place and a test says when this one is missed.
pub const LIBMPV_SOURCE_URL: &str =
    "https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20261011";

/// A page about the sources of what Kaleido ships, which "About" opens in the browser. The UI
/// names the page, never the address: no command opens a link the UI makes up.
// `Serialize` only for the IPC contract test, which writes what it read back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub enum SourcePage {
    /// The releases of Kaleido and the tag of the sources of each.
    Kaleido,
    /// The sources of the libmpv build.
    Libmpv,
}

impl SourcePage {
    /// The address of the page.
    pub const fn url(self) -> &'static str {
        match self {
            SourcePage::Kaleido => KALEIDO_RELEASES_URL,
            SourcePage::Libmpv => LIBMPV_SOURCE_URL,
        }
    }
}

/// Requests this close together make one playlist (spec 9.3).
pub const JOIN_WINDOW: Duration = Duration::from_millis(300);

/// The current value of every observed property, as `player::snapshot` reads it.
pub type Snapshot = BTreeMap<String, Value>;

/// The event that tells the UI Rust has handed the player sources; its payload is
/// [`OpenRequestEvent`].
pub const OPEN_REQUEST_EVENT: &str = "system:open-request";
/// The event that tells the UI Ctrl+V found no link on the clipboard; its payload is `{}`.
pub const PASTE_EMPTY_EVENT: &str = "system:paste-empty";
/// The event that tells the UI something inside Kaleido failed, a panic on the mpv event thread
/// (Ruling R53); its payload is `{}`. The UI shows a notice, the log says what happened.
pub const ERROR_EVENT: &str = "system:error";

/// The payload of `system:open-request`: Rust has handed the player `count` sources.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct OpenRequestEvent {
    pub(crate) count: usize,
}

type Job<C> = Box<dyn FnOnce(&C) + Send>;

/// The thread that checks the sources of requests from outside the UI (a launch, a drop) and
/// queues them: the main thread must not wait for a slow disk or network share, and one thread
/// keeps the requests in the order they came, so a playlist keeps the order of its files.
///
/// It starts before the app is built and runs no job until [`OpenThread::attach`] gives it the
/// app (`C`), so this launch's own command line can be queued first: a later launch can hand
/// over its command line while the main window is still being created, before the setup runs.
pub struct OpenThread<C: Send + 'static = AppHandle> {
    jobs: mpsc::Sender<Job<C>>,
    context: mpsc::Sender<C>,
}

impl<C: Send + 'static> OpenThread<C> {
    pub fn start() -> OpenThread<C> {
        let (jobs, queued) = mpsc::channel::<Job<C>>();
        let (context, attached) = mpsc::channel::<C>();
        thread::Builder::new()
            .name("open-requests".into())
            .spawn(move || {
                // Never attached (a later launch exits in its setup): its jobs never run.
                let Ok(context) = attached.recv() else {
                    return;
                };
                for job in queued {
                    job(&context);
                }
            })
            .expect("cannot start the open-requests thread");
        OpenThread { jobs, context }
    }

    /// Lets the queued jobs run, in order, with `context`. Only the first call counts.
    pub fn attach(&self, context: C) {
        // Fails only once the thread has ended, which it does not while jobs can come.
        let _ = self.context.send(context);
    }

    /// Queues `job` after the jobs before it. Returns whether the thread took it.
    pub fn run(&self, job: impl FnOnce(&C) + Send + 'static) -> bool {
        self.jobs.send(Box::new(job)).is_ok()
    }
}

/// Runs `job` on the app's [`OpenThread`] after the jobs before it.
fn in_order(app: &AppHandle, job: impl FnOnce(&AppHandle) + Send + 'static) {
    let queued = app
        .try_state::<OpenThread>()
        .is_some_and(|thread| thread.run(job));
    if !queued {
        tracing::warn!("open request dropped: the open-requests thread is not running");
    }
}

/// Opens what a command line asks for: this launch's own (queued before the app is built), or a
/// later launch's (`args` without the program name, relative to that process's `cwd`). It came
/// at `arrived`.
pub fn open_command_line(opens: &OpenThread, arrived: Instant, args: Vec<OsString>, cwd: PathBuf) {
    let queued = opens.run(move |app| {
        let request = cli::parse(args, &cwd);
        for (arg, error) in &request.rejected {
            tracing::warn!("cannot open {arg} from the command line: {error:?}");
        }
        open(
            app,
            arrived,
            OpenRequest {
                sources: request.sources,
                mode: request.mode,
                options: request.options,
            },
        );
    });
    if !queued {
        tracing::warn!("command line dropped: the open-requests thread is not running");
    }
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
/// through (once the UI is ready). A request without its own mode follows the open-while-playing
/// setting as it is now (spec 8.10).
pub fn open(app: &AppHandle, arrived: Instant, req: OpenRequest) {
    let _order = handover();
    let batch = app
        .try_state::<OpenQueue>()
        .and_then(|queue| queue.submit(arrived, req, settings::open_while_playing(app)));
    if let Some(batch) = batch {
        play(app, batch);
    }
}

/// The UI has subscribed to the player's events: the requests that waited for it play, and it
/// gets the player's current state. Blocks until mpv answers, so not on the main thread.
pub fn ui_ready(app: &AppHandle) -> Snapshot {
    if let Some(queue) = app.try_state::<OpenQueue>() {
        let _order = handover();
        for batch in queue.ui_ready(Instant::now(), settings::open_while_playing(app)) {
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
    open_on_player(app, &engine, &batch.sources, batch.mode, &batch.options);
    let event = OpenRequestEvent {
        count: batch.sources.len(),
    };
    if let Err(error) = app.emit(OPEN_REQUEST_EVENT, event) {
        tracing::warn!("cannot send {OPEN_REQUEST_EVENT} to the UI: {error}");
    }
}

/// The one way the app hands sources to the player: the open queue's batches (the command line,
/// later launches, a drop, the dialog, a paste and the paste field, the retry of a link) and the
/// UI's `player_load`. A link among them is opened anew, so the streams forget the quality chosen
/// for it before (Ruling R12), and then the sources are queued (`player::load::open_checked`).
/// Never waits for mpv.
pub fn open_on_player(
    app: &AppHandle,
    engine: &Engine,
    sources: &[Source],
    mode: LoadMode,
    opts: &ValidatedOptions,
) {
    if let Some(streams) = app.try_state::<Streams>() {
        streams.opened(sources);
    }
    player::load::open_checked(engine, sources, mode, opts);
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);

    #[test]
    fn the_source_pages_are_secure_links_of_their_own() {
        assert_eq!(SourcePage::Kaleido.url(), KALEIDO_RELEASES_URL);
        assert_eq!(SourcePage::Libmpv.url(), LIBMPV_SOURCE_URL);
        assert_ne!(KALEIDO_RELEASES_URL, LIBMPV_SOURCE_URL);
        for page in [SourcePage::Kaleido, SourcePage::Libmpv] {
            assert!(page.url().starts_with("https://"), "{page:?}");
        }
    }

    #[test]
    fn libmpv_link_is_the_one_in_the_license_list() {
        let listed: Vec<diagnostics::License> =
            serde_json::from_str(include_str!("../../../resources/licenses/extra.json")).unwrap();
        let libmpv = listed
            .iter()
            .find(|license| license.name == "libmpv")
            .expect("extra.json lists libmpv");
        assert_eq!(
            libmpv.url, LIBMPV_SOURCE_URL,
            "the libmpv build changed: bump LIBMPV_SOURCE_URL with extra.json"
        );
    }

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

    /// As in `run`: this launch's command line is queued before the app is built; a later
    /// launch hands over its own while the main window is being created (WebView2 pumps
    /// messages then), before the setup attaches the app. The first launch's files still come
    /// first, and the later ones join their playlist.
    #[test]
    fn the_first_launch_stays_first_when_a_later_launch_comes_during_setup() {
        let opens = OpenThread::<OpenQueue>::start();
        let start = Instant::now();
        assert!(opens.run(move |queue: &OpenQueue| {
            queue.submit(start, request("own.mkv"), LoadMode::Replace);
        }));
        // Ran before the app is there, it would have been lost or put first.
        let (ran, has_run) = mpsc::channel();
        assert!(opens.run(move |queue: &OpenQueue| {
            queue.submit(
                start + Duration::from_millis(50),
                request("later.mkv"),
                LoadMode::Replace,
            );
            ran.send(()).unwrap();
        }));
        assert!(
            has_run.recv_timeout(Duration::from_millis(200)).is_err(),
            "a job ran before the app was attached"
        );

        opens.attach(OpenQueue::new(JOIN_WINDOW));
        has_run.recv_timeout(TIMEOUT).unwrap();
        let (batches, handed_over) = mpsc::channel();
        opens.run(move |queue: &OpenQueue| {
            let ready = start + Duration::from_secs(2);
            batches
                .send(queue.ui_ready(ready, LoadMode::Replace))
                .unwrap();
        });

        assert_eq!(
            handed_over.recv_timeout(TIMEOUT).unwrap(),
            [
                batch("own.mkv", LoadMode::Replace),
                batch("later.mkv", LoadMode::Append),
            ]
        );
    }
}
