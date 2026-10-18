//! One libmpv core at a time and the threads that talk to it. Requests (commands, property
//! writes, closures) run in the order they were sent on the request thread, which owns the core;
//! events go to an [`EventLoop`] on the core's event thread. The main (window) thread never calls
//! mpv (M0 review).
//!
//! A restart (plugin changes, spec 6.3) is a request like the others: between two requests the
//! request thread replaces the core with a new one and plays on where the old one was
//! ([`resume`]). What was sent meanwhile waits in the queue and reaches the new core in order.

use std::fmt;
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use mpv_ffi::sys::Api;
use mpv_ffi::{Event, Mpv, PropertyKind, PropertyValue, load_api, locate_libmpv};

use super::options;
use super::resume::{self, Restored};
use crate::paths::AppPaths;

/// Observation reply ids from here up are the engine's own (the enforced options). An
/// [`EventLoop`] observes with ids below it; the engine's property changes never reach it.
pub const ENGINE_OBSERVE_BASE: u64 = 1_000_000;

/// How long a restart waits for the old core to quit (mpv saves the position with
/// `save-position-on-quit`) before it destroys the core anyway.
pub const QUIT_TIMEOUT: Duration = Duration::from_secs(2);

/// How long a restart waits for the old core to be destroyed (its scripts end, its window goes)
/// before it starts the new one without waiting further.
const DESTROY_TIMEOUT: Duration = Duration::from_secs(2);

const REQUEST_THREAD: &str = "mpv-requests";
const EVENT_THREAD: &str = "mpv-events";
/// The name Rust gives the main thread, where Tauri runs the window's message loop.
const MAIN_THREAD: &str = "main";

/// mpv's `sub-margin-y` property.
const SUB_MARGIN_Y: &str = "sub-margin-y";

/// Where this mpv keeps the default of `sub-margin-y` (it changed between mpv versions: 22
/// before, 34 in the pinned build).
const SUB_MARGIN_Y_DEFAULT: &str = "option-info/sub-margin-y/default-value";

/// mpv's own `sub-margin-y` in the pinned build, only for when neither the property nor its
/// default can be read.
const MPV_SUB_MARGIN: i64 = 34;

/// What the core is started with; every core of an engine has the same.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub paths: AppPaths,
    /// HWND mpv creates its window in (the main window).
    pub wid: Option<isize>,
    /// `gpu-next` in the app, `null` in tests.
    pub vo: String,
    /// `None` = mpv's default audio output.
    pub ao: Option<String>,
}

/// Receives mpv's events on the event thread. Implementations observe properties with reply
/// ids below [`ENGINE_OBSERVE_BASE`].
pub trait EventLoop: Send + 'static {
    /// Every event in order, except the engine's own property changes; `Event::Shutdown` is
    /// the last one. The loop of a core that a restart replaces gets nothing more from the moment
    /// the restart begins, and never its `Shutdown`.
    fn on_event(&mut self, mpv: &Mpv, event: Event);

    /// Called when no event is pending: once at the start and after every burst of events.
    /// Returns how long to wait for the next event before calling it again; `None` waits
    /// until an event comes.
    fn on_idle(&mut self, mpv: &Mpv) -> Option<Duration>;

    /// `on_event` or `on_idle` panicked. The panic hook has logged it, and the event thread goes
    /// on with the next event (see [`PANICS_LET_PASS`]).
    fn on_panic(&mut self, _mpv: &Mpv) {}
}

/// The loop a [`Restart`] brings for the new core.
impl EventLoop for Box<dyn EventLoop> {
    fn on_event(&mut self, mpv: &Mpv, event: Event) {
        (**self).on_event(mpv, event);
    }

    fn on_idle(&mut self, mpv: &Mpv) -> Option<Duration> {
        (**self).on_idle(mpv)
    }

    fn on_panic(&mut self, mpv: &Mpv) {
        (**self).on_panic(mpv);
    }
}

/// How many panics of the [`EventLoop`] the event thread lets pass. Each one has been logged by the
/// panic hook and told to the loop (`on_panic`), and the thread goes on with the next event: one
/// bad event must not cut the UI off from the player (Ruling R53). A loop that panics at every
/// event would only fill the log, so after these the thread gives up.
pub const PANICS_LET_PASS: u32 = 10;

/// Work for the request thread, done in the order it was sent.
pub enum Request {
    Command(Vec<String>),
    SetProperty { name: String, value: String },
    Call(Box<dyn FnOnce(&Mpv) + Send>),
}

/// The per-file options of a playlist entry (`name`, `value`), by the entry's `filename`.
pub type EntryOptions = Box<dyn Fn(&str) -> Vec<(String, String)> + Send>;

/// A new core in place of the running one ([`Engine::restart`]).
pub struct Restart {
    /// Gets the new core's events, from its first one on.
    pub events: Box<dyn EventLoop>,
    /// Runs on the request thread once the new core and its event thread run, before the
    /// playback is restored and before anything sent during the restart: the observations of
    /// `events`, the commands Kaleido sends every core.
    pub prepare: Box<dyn FnOnce(&Mpv) + Send>,
    /// The per-file options a playlist entry is loaded with again, by its `filename` (the
    /// `ytdl-format` of a chosen quality).
    pub entry_options: EntryOptions,
    /// Runs on the request thread when the old core is gone and before the new one is made:
    /// what must not happen while the old core runs (its mpv.log is open until then) or after the
    /// new one has started (its window comes soon after).
    pub before_start: Box<dyn FnOnce() + Send>,
}

impl Restart {
    /// A restart whose new core reports to `events`, with nothing else to do.
    pub fn new(events: impl EventLoop) -> Restart {
        Restart {
            events: Box::new(events),
            prepare: Box::new(|_| {}),
            entry_options: Box::new(|_| Vec::new()),
            before_start: Box::new(|| {}),
        }
    }
}

/// Why [`Engine::restart`] did not go as it should.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartError {
    /// The old core did not quit within [`QUIT_TIMEOUT`], or was not destroyed in time after:
    /// it was destroyed anyway (or is left to end on a thread of its own), and the new core runs
    /// and plays on.
    Quit,
    /// No new core runs: it could not be started (mpv's error), or the restart was refused (the
    /// player has shut down, or it was asked for on a thread it would wait for).
    Start(String),
}

impl fmt::Display for RestartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RestartError::Quit => write!(
                f,
                "the old player core did not end in time; the new one runs beside what is left of it"
            ),
            RestartError::Start(reason) => write!(f, "no new player core: {reason}"),
        }
    }
}

impl std::error::Error for RestartError {}

/// What the request thread is given, in the order it was sent.
enum Job {
    Request(Request),
    Restart(Restart, mpsc::SyncSender<Result<(), RestartError>>),
    /// The engine is dropped: the core goes, and the request thread ends.
    Stop,
}

pub struct Engine {
    /// `None` only while dropping.
    jobs: Option<mpsc::Sender<Job>>,
    status: Arc<Status>,
    request_thread: Option<JoinHandle<()>>,
    /// The `sub-margin-y` the running core had before `set_sub_margin` first set it. It belongs
    /// to the core and not to the process: every engine (every test has its own) reads its own
    /// mpv.conf, and a restart forgets it, so that the new core's is read.
    sub_margin_base: Arc<Mutex<Option<i64>>>,
}

/// What the cores of an engine tell the callers.
#[derive(Default)]
struct Status {
    /// The event loop of the running core has received `Event::Shutdown`: mpv has quit. A core a
    /// restart replaces never says so.
    shut_down: Mutex<bool>,
    changed: Condvar,
}

impl Status {
    fn has_shut_down(&self) -> bool {
        *lock(&self.shut_down)
    }

    fn set_shut_down(&self) {
        *lock(&self.shut_down) = true;
        self.changed.notify_all();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Engine {
    /// Creates the core with Kaleido's options (`options::enforced`), initializes it (that
    /// loads the user's mpv.conf) and starts the threads. The first request puts back the
    /// options mpv.conf overrode (`options::reassert`); from then on the event thread watches
    /// them and queues the same whenever one changes.
    pub fn start(cfg: EngineConfig, events: impl EventLoop) -> mpv_ffi::Result<Engine> {
        // Loaded once: every core of the engine runs on it, and a restart never unloads it.
        let api = load_api(&locate_libmpv())?;
        let cfg = Arc::new(cfg);
        let (jobs, queue) = mpsc::channel();
        let (mpv, enforcer) = create_core(&api, &cfg, &jobs)?;
        // Not on the caller's (main) thread: setting `vo` back recreates mpv's window, a child
        // of the main window, and that must not wait for a main thread blocked in mpv.
        enforcer.queue_reassert();

        let status = Arc::new(Status::default());
        let core = Core::spawn(mpv, events, enforcer, &status);
        let sub_margin_base = Arc::new(Mutex::new(None));
        let worker = Worker {
            api,
            cfg,
            status: Arc::clone(&status),
            jobs: jobs.clone(),
            sub_margin_base: Arc::clone(&sub_margin_base),
            core: Some(core),
            restored: None,
            unrestored: None,
        };
        let request_thread = spawn(REQUEST_THREAD, move || worker.run(queue));
        Ok(Engine {
            jobs: Some(jobs),
            status,
            request_thread: Some(request_thread),
            sub_margin_base,
        })
    }

    /// Queues `job`; false once the request thread has stopped.
    fn send(&self, job: Job) -> bool {
        self.jobs
            .as_ref()
            .is_some_and(|jobs| jobs.send(job).is_ok())
    }

    /// Queues `request` and returns at once.
    pub fn request(&self, request: Request) {
        if !self.send(Job::Request(request)) {
            tracing::warn!("mpv request dropped: the request thread has stopped");
        }
    }

    /// Queues an mpv command given as separate arguments (no quoting).
    pub fn command(&self, args: &[&str]) {
        self.request(Request::Command(
            args.iter().map(|&arg| arg.to_owned()).collect(),
        ));
    }

    /// Runs `f` on the request thread after everything queued before it and returns its
    /// result. Blocks the caller, so never call it on the main thread. Panics (in the caller)
    /// when `f` panicked, or when no core runs to run it on (a restart whose new core did not
    /// start).
    pub fn call<T: Send + 'static>(&self, f: impl FnOnce(&Mpv) -> T + Send + 'static) -> T {
        let (reply, result) = mpsc::sync_channel(1);
        self.request(Request::Call(Box::new(move |mpv| {
            // Cannot fail: the caller waits on `result`.
            let _ = reply.send(f(mpv));
        })));
        result
            .recv()
            .expect("the mpv call panicked, or no player core runs")
    }

    /// Replaces the core with a new one that goes on where the old one was, in the queue's
    /// order: what was sent before runs on the old core, what is sent from now on waits and runs
    /// on the new one, after `restart.prepare` and the restored playback. A second restart sent
    /// meanwhile waits for this one. On the request thread:
    ///
    /// 1. The old core's event thread stops: its loop hears nothing more, and never the
    ///    `Event::Shutdown` of the quit below (which would end the app, lib.rs).
    /// 2. [`resume::capture`] reads where it is (`restart.entry_options` gives each entry's
    ///    per-file options).
    /// 3. It quits (mpv saves the position with `save-position-on-quit`) and is destroyed; one
    ///    that has not shut down within [`QUIT_TIMEOUT`] is destroyed anyway.
    /// 4. `restart.before_start`, then a new core with the same [`EngineConfig`]: Kaleido's
    ///    options, `initialize` (the user's mpv.conf, the scripts in `scripts\`), the enforced
    ///    options put back and watched, its event thread with `restart.events`.
    /// 5. `restart.prepare`, then [`resume::restore_commands`].
    ///
    /// The `sub-margin-y` floor of [`Engine::set_sub_margin`] is read anew from the new core.
    ///
    /// Blocks the caller until the new core runs, a few hundred milliseconds or up to
    /// [`QUIT_TIMEOUT`] and more when the old core does not end. Never call it on the main thread
    /// (the old core's window goes and the new one comes through its message pump), nor on the
    /// request or the event thread (`call` closures, event loops), which it would wait for: it is
    /// refused there with `RestartError::Start`. `RestartError::Quit` comes back once the new core
    /// runs, so the player is never left without one; `Start` means none runs (a later restart
    /// tries again).
    pub fn restart(&self, restart: Restart) -> Result<(), RestartError> {
        if let Some(name) = thread::current()
            .name()
            .filter(|name| [MAIN_THREAD, REQUEST_THREAD, EVENT_THREAD].contains(name))
        {
            tracing::error!("a restart of the player was asked for on the {name} thread");
            return Err(RestartError::Start(format!(
                "a restart cannot wait on the {name} thread"
            )));
        }
        let (reply, result) = mpsc::sync_channel(1);
        if !self.send(Job::Restart(restart, reply)) {
            return Err(RestartError::Start(
                "the request thread has stopped".to_owned(),
            ));
        }
        result
            .recv()
            .unwrap_or_else(|_| Err(RestartError::Start("the restart panicked".to_owned())))
    }

    /// Sets `sub-margin-y` to `margin`, but never below the margin this core had before the first
    /// call (mpv's own default, or the one in the user's mpv.conf): the UI asks for 0 while its controls
    /// are hidden, which means "nothing of mine is in the way", not "subtitles on the bottom edge"
    /// (Ruling R38). The first call reads the margin and writes in the same request, so nothing
    /// queued by anyone else comes between; the margin is remembered for the life of the core.
    /// Queues and returns at once.
    pub fn set_sub_margin(&self, margin: i64) {
        let remembered = Arc::clone(&self.sub_margin_base);
        self.request(Request::Call(Box::new(move |mpv| {
            let own = {
                let mut base = lock(&remembered);
                if base.is_none() {
                    // Not remembered when it cannot be read: the next call tries again.
                    *base = mpv.get_i64(SUB_MARGIN_Y).ok();
                }
                *base
            };
            let own = own.unwrap_or_else(|| {
                tracing::warn!("sub-margin-y cannot be read; using mpv's default as the floor");
                mpv.get_i64(SUB_MARGIN_Y_DEFAULT).unwrap_or(MPV_SUB_MARGIN)
            });
            let value = margin.max(own);
            if let Err(error) = mpv.set_property(SUB_MARGIN_Y, &value.to_string()) {
                tracing::warn!("mpv request failed: {error}");
            }
        })));
    }

    /// Queues `quit` (mpv saves the position with `save-position-on-quit`) and waits up to
    /// `timeout` until the event loop has received `Event::Shutdown`. During a restart the quit
    /// waits in the queue and goes to the new core.
    pub fn quit(&self, timeout: Duration) -> bool {
        self.command(&["quit"]);
        let shut_down = lock(&self.status.shut_down);
        let (shut_down, _) = self
            .status
            .changed
            .wait_timeout_while(shut_down, timeout, |shut_down| !*shut_down)
            .unwrap_or_else(PoisonError::into_inner);
        *shut_down
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // After everything queued before: the request thread stops the core's event thread (it
        // has returned after `Shutdown` already, or returns at the wakeup it gets), destroys the
        // core (mpv_terminate_destroy) and ends.
        if let Some(jobs) = self.jobs.take() {
            let _ = jobs.send(Job::Stop);
        }
        join(self.request_thread.take());
    }
}

/// The request thread's own: the running core and what it takes to start another.
struct Worker {
    api: Arc<Api>,
    cfg: Arc<EngineConfig>,
    status: Arc<Status>,
    /// For the enforcers of new cores, which queue their reasserts here.
    jobs: mpsc::Sender<Job>,
    sub_margin_base: Arc<Mutex<Option<i64>>>,
    /// `None` after a restart whose new core did not start.
    core: Option<Core>,
    /// What the last restart gave its core, for a restart that comes before the core has got
    /// there (see [`resume::unsettled`]).
    restored: Option<Restored>,
    /// Where the old core was, kept while no core runs: the next restart restores it.
    unrestored: Option<resume::ResumeState>,
}

impl Worker {
    fn run(mut self, queue: mpsc::Receiver<Job>) {
        // The queue never closes while `self.jobs` lives: `Job::Stop` ends it.
        for job in &queue {
            match job {
                Job::Request(request) => self.handle(request),
                Job::Restart(restart, reply) => {
                    // A panic here (none is expected: the caller's closures are guarded) must not
                    // take all later input with it.
                    let result = panic::catch_unwind(AssertUnwindSafe(|| self.restart(restart)))
                        .unwrap_or_else(|_| {
                            Err(RestartError::Start("the restart panicked".to_owned()))
                        });
                    // The caller waits on it, unless it has gone.
                    let _ = reply.send(result);
                }
                Job::Stop => break,
            }
        }
        if let Some(mut core) = self.core.take() {
            core.stop_events();
            // The last handle goes with `core`: mpv_terminate_destroy.
        }
    }

    fn handle(&self, request: Request) {
        let Some(core) = &self.core else {
            // A `call` waiting for its closure learns of it when the closure is dropped here.
            tracing::warn!("mpv request dropped: no player core runs");
            return;
        };
        let mpv = &core.mpv;
        let result = match request {
            Request::Command(args) => {
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                mpv.command(&args)
            }
            Request::SetProperty { name, value } => mpv.set_property(&name, &value),
            Request::Call(f) => {
                // A panicking closure must not take all later input with it; `call` reports it
                // to its caller.
                let _ = panic::catch_unwind(AssertUnwindSafe(|| f(mpv)));
                Ok(())
            }
        };
        if let Err(error) = result {
            tracing::warn!("mpv request failed: {error}");
        }
    }

    /// See [`Engine::restart`].
    fn restart(&mut self, restart: Restart) -> Result<(), RestartError> {
        let Restart {
            events,
            prepare,
            entry_options,
            before_start,
        } = restart;
        let restored = self.restored.take();
        // Without a core (the last new one did not start), what the last restart took from the
        // core before it.
        let mut state = self.unrestored.take().unwrap_or_default();
        let mut retired = Ok(());
        if let Some(mut old) = self.core.take() {
            old.stop_events();
            if self.status.has_shut_down() {
                // mpv has quit (the window closes, the `q` key): the app ends, and no new core
                // comes up under it.
                self.core = Some(old);
                return Err(RestartError::Start("the player has shut down".to_owned()));
            }
            let options = |filename: &str| {
                guarded("the options of a playlist entry", || {
                    entry_options(filename)
                })
                .unwrap_or_default()
            };
            let (captured, entry) = resume::capture_with_entry(&old.mpv, &options);
            state = captured;
            if !old.flags.settled.load(Ordering::SeqCst) {
                resume::unsettled(&mut state, entry, restored.as_ref());
            }
            retired = old.retire();
        }
        // The new core's own margin is the floor.
        *lock(&self.sub_margin_base) = None;
        guarded("what comes before the new core", before_start);
        let core = match self.start_core(events) {
            Ok(core) => core,
            Err(error) => {
                tracing::error!("cannot start a new player core: {error}");
                // For the next restart, which tries again.
                self.unrestored = Some(state);
                return Err(RestartError::Start(error.to_string()));
            }
        };
        guarded("preparing the new core", || prepare(&core.mpv));
        for args in resume::restore_commands(&state) {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            if let Err(error) = core.mpv.command(&args) {
                tracing::warn!("the restarted player cannot restore its playback: {error}");
            }
        }
        if state.current.is_some() {
            self.restored = resume::current_entry(&core.mpv).map(|entry| Restored { entry, state });
        }
        self.core = Some(core);
        retired
    }

    /// A new core with its enforced options put back at once (this is the request thread, and
    /// nothing queued may come first), and its event thread.
    fn start_core(&self, events: impl EventLoop) -> mpv_ffi::Result<Core> {
        let (mpv, enforcer) = create_core(&self.api, &self.cfg, &self.jobs)?;
        if let Err(error) = options::reassert(&mpv, &self.cfg) {
            tracing::error!("cannot restore Kaleido's mpv options: {error}");
        }
        Ok(Core::spawn(mpv, events, enforcer, &self.status))
    }
}

/// Runs a closure of the caller's on the request thread; a panic in it (logged by the panic hook)
/// gives `None`, and the restart goes on without what it would have done.
fn guarded<T>(what: &str, f: impl FnOnce() -> T) -> Option<T> {
    let result = panic::catch_unwind(AssertUnwindSafe(f)).ok();
    if result.is_none() {
        tracing::error!("{what} panicked during a restart of the player");
    }
    result
}

/// A new core with Kaleido's options (`options::enforced`), initialized (that loads the user's
/// mpv.conf and the scripts), and its [`Enforcer`] already observing.
fn create_core(
    api: &Arc<Api>,
    cfg: &Arc<EngineConfig>,
    jobs: &mpsc::Sender<Job>,
) -> mpv_ffi::Result<(Mpv, Enforcer)> {
    let mpv = Mpv::create(Arc::clone(api))?;
    for (name, value) in options::enforced(cfg) {
        mpv.set_option(name, &value)?;
    }
    mpv.initialize()?;
    let enforcer = Enforcer {
        watched: options::reasserted(cfg),
        cfg: Arc::clone(cfg),
        requests: jobs.clone(),
    };
    enforcer.observe(&mpv)?;
    Ok((mpv, enforcer))
}

/// A running core: its handle, which only its event thread shares, and that thread.
struct Core {
    mpv: Arc<Mpv>,
    flags: Arc<CoreFlags>,
    events: Option<JoinHandle<()>>,
}

/// What the request thread and a core's event thread tell each other.
#[derive(Default)]
struct CoreFlags {
    /// Set by the request thread: the event thread delivers nothing more and returns.
    stop: AtomicBool,
    /// Kept by the event thread: the current entry has got to where it plays (a
    /// `playback-restart` since its `start-file`), so mpv's `time-pos` is where it is.
    settled: AtomicBool,
}

impl Core {
    fn spawn(mpv: Mpv, events: impl EventLoop, enforcer: Enforcer, status: &Arc<Status>) -> Core {
        let mpv = Arc::new(mpv);
        let flags = Arc::new(CoreFlags::default());
        let thread = spawn(EVENT_THREAD, {
            let mpv = Arc::clone(&mpv);
            let status = Arc::clone(status);
            let flags = Arc::clone(&flags);
            move || run_events(&mpv, events, &enforcer, &status, &flags)
        });
        Core {
            mpv,
            flags,
            events: Some(thread),
        }
    }

    /// Ends the event thread: it has returned already (after `Shutdown`), or returns at the
    /// wakeup this gives it, delivering nothing more. Its loop is dropped with it.
    fn stop_events(&mut self) {
        self.flags.stop.store(true, Ordering::SeqCst);
        self.mpv.wakeup();
        join(self.events.take());
    }

    /// For a restart, once the events are stopped: quits the core and waits up to
    /// [`QUIT_TIMEOUT`] for mpv to say it has shut down (the events in between are nobody's), then
    /// destroys it, waiting up to [`DESTROY_TIMEOUT`]. A core that takes longer is destroyed
    /// anyway, on a thread of its own.
    fn retire(self) -> Result<(), RestartError> {
        debug_assert!(self.events.is_none(), "the events are stopped first");
        let quit = quit_and_wait(&self.mpv, QUIT_TIMEOUT);
        if !quit {
            tracing::warn!(
                "the old player core did not quit within {QUIT_TIMEOUT:?}; it is destroyed anyway"
            );
        }
        let destroyed = destroy(self.mpv, DESTROY_TIMEOUT);
        if !destroyed {
            tracing::error!(
                "the old player core is not gone after {DESTROY_TIMEOUT:?}; the new one starts \
                 without waiting for it"
            );
        }
        if quit && destroyed {
            Ok(())
        } else {
            Err(RestartError::Quit)
        }
    }
}

/// Sends `quit` and waits for `Event::Shutdown` on this thread, up to `timeout`.
fn quit_and_wait(mpv: &Mpv, timeout: Duration) -> bool {
    if let Err(error) = mpv.command(&["quit"]) {
        // Quitting already (a script, the `q` key just now): the shutdown comes anyway.
        tracing::warn!("the old player core takes no quit: {error}");
    }
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        if mpv.wait_event(left.as_secs_f64()) == Event::Shutdown {
            return true;
        }
    }
}

/// Drops the last handle of a core (mpv_terminate_destroy: its scripts end, its window and audio
/// go) on a thread of its own and waits up to `timeout`. A core that takes longer is left to that
/// thread. Returns whether it was destroyed in time.
fn destroy(mpv: Arc<Mpv>, timeout: Duration) -> bool {
    let (destroyed, done) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("mpv-retired".into())
        .spawn(move || {
            drop(mpv);
            let _ = destroyed.send(());
        });
    match spawned {
        Ok(_) => done.recv_timeout(timeout).is_ok(),
        // The closure, and the handle with it, was dropped on this thread.
        Err(error) => {
            tracing::warn!("the old player core was destroyed on the request thread: {error}");
            true
        }
    }
}

/// Keeps the `options::REASSERTED` options enforced while the core runs. Besides mpv.conf at
/// `initialize`, conditional profiles (applied by auto_profiles.lua at startup and whenever a
/// condition changes, e.g. on every file load) and scripts can set them at any time.
struct Enforcer {
    cfg: Arc<EngineConfig>,
    /// Enforced values, observed under `ENGINE_OBSERVE_BASE + index`.
    watched: Vec<(&'static str, String)>,
    requests: mpsc::Sender<Job>,
}

impl Enforcer {
    fn observe(&self, mpv: &Mpv) -> mpv_ffi::Result<()> {
        for (id, (name, _)) in (ENGINE_OBSERVE_BASE..).zip(&self.watched) {
            mpv.observe(id, name, PropertyKind::String)?;
        }
        Ok(())
    }

    /// Whether the observed value under `id` differs from the enforced one. Only then is a
    /// reassert queued: setting an unchanged `vo` would recreate the video output for nothing.
    fn drifted(&self, id: u64, value: &PropertyValue) -> bool {
        let watched = usize::try_from(id - ENGINE_OBSERVE_BASE)
            .ok()
            .and_then(|index| self.watched.get(index));
        watched.is_some_and(
            |(_, wanted)| !matches!(value, PropertyValue::String(value) if value == wanted),
        )
    }

    /// Nobody waits for the result, so a failure is logged. Queued behind a restart, it runs on
    /// the new core, where it finds nothing to put back or what is the same there.
    fn queue_reassert(&self) {
        let cfg = Arc::clone(&self.cfg);
        // Sending fails only once the request thread is gone, i.e. while dropping the engine.
        let _ = self
            .requests
            .send(Job::Request(Request::Call(Box::new(move |mpv| {
                if let Err(error) = options::reassert(mpv, &cfg) {
                    tracing::error!("cannot restore Kaleido's mpv options: {error}");
                }
            }))));
    }
}

fn spawn(name: &str, body: impl FnOnce() + Send + 'static) -> JoinHandle<()> {
    thread::Builder::new()
        .name(name.into())
        .spawn(body)
        .expect("cannot start an mpv thread")
}

fn join(thread: Option<JoinHandle<()>>) {
    // A panic on that thread has been reported by the panic hook already.
    if let Some(thread) = thread {
        let _ = thread.join();
    }
}

/// The event loop panicked once more than [`PANICS_LET_PASS`]: the event thread stops.
struct GaveUp;

/// Runs `step` of the event loop. A panic in it has been logged by the panic hook: the loop is told
/// (`on_panic`) and `None` comes back, so that the thread goes on; [`GaveUp`] once
/// [`PANICS_LET_PASS`] have passed, or when telling the loop panics too.
fn survive<E: EventLoop, T>(
    events: &mut E,
    mpv: &Mpv,
    panics: &mut u32,
    step: impl FnOnce(&mut E) -> T,
) -> Result<Option<T>, GaveUp> {
    if let Ok(value) = panic::catch_unwind(AssertUnwindSafe(|| step(&mut *events))) {
        return Ok(Some(value));
    }
    *panics += 1;
    if *panics > PANICS_LET_PASS {
        tracing::error!(
            "the mpv event thread stops after {PANICS_LET_PASS} panics: the UI hears no more of \
             the player"
        );
        return Err(GaveUp);
    }
    match panic::catch_unwind(AssertUnwindSafe(|| events.on_panic(mpv))) {
        Ok(()) => Ok(None),
        Err(_) => Err(GaveUp),
    }
}

fn run_events(
    mpv: &Mpv,
    mut events: impl EventLoop,
    enforcer: &Enforcer,
    status: &Status,
    flags: &CoreFlags,
) {
    let stop = &flags.stop;
    let mut panics = 0;
    loop {
        let Ok(timeout) = survive(&mut events, mpv, &mut panics, |events| events.on_idle(mpv))
        else {
            return;
        };
        let timeout = timeout
            .flatten()
            .map_or(-1.0, |timeout| timeout.as_secs_f64());
        let mut event = mpv.wait_event(timeout);
        let mut drifted = false;
        while !matches!(event, Event::None) {
            match event {
                Event::StartFile => flags.settled.store(false, Ordering::SeqCst),
                Event::PlaybackRestart => flags.settled.store(true, Ordering::SeqCst),
                _ => {}
            }
            match event {
                // mpv quit on its own (the `q` key, a script) or for `Engine::quit`. A restart
                // stops this thread before it quits the core, so the shutdown it causes never
                // comes here. The engine hears of the shutdown even if the loop fails on it.
                Event::Shutdown => {
                    let _ = survive(&mut events, mpv, &mut panics, |events| {
                        events.on_event(mpv, Event::Shutdown);
                    });
                    status.set_shut_down();
                    return;
                }
                // Stopped (a restart replaces the core, or the engine is dropped): nothing more is
                // delivered.
                _ if stop.load(Ordering::SeqCst) => return,
                Event::PropertyChange { id, ref value, .. } if id >= ENGINE_OBSERVE_BASE => {
                    drifted |= enforcer.drifted(id, value);
                }
                event => {
                    let handled = survive(&mut events, mpv, &mut panics, |events| {
                        events.on_event(mpv, event);
                    });
                    if handled.is_err() {
                        return;
                    }
                }
            }
            event = mpv.wait_event(0.0);
        }
        // Once per burst: `reassert` puts back everything that differs.
        if drifted {
            enforcer.queue_reassert();
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use mpv_ffi::{EndFileReason, Event, Mpv};

    use super::{ENGINE_OBSERVE_BASE, Engine, EventLoop, Request, Restart, RestartError};
    use crate::player::testing::{NoEvents, Recorded, clip, eventually, headless, temp_paths};

    /// A held key or a spun wheel: requests in a row, each building on the one before.
    #[test]
    fn commands_and_properties_keep_their_order() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap();
        engine.request(Request::SetProperty {
            name: "speed".into(),
            value: "1.5".into(),
        });
        engine.request(Request::Command(vec![
            "add".into(),
            "speed".into(),
            "0.5".into(),
        ]));
        engine.request(Request::Command(vec![
            "multiply".into(),
            "speed".into(),
            "2".into(),
        ]));
        assert_eq!(engine.call(|mpv| mpv.get_f64("speed").unwrap()), 4.0);
    }

    /// Keeps every event the event thread delivers.
    struct Recorder(Arc<Mutex<Vec<Event>>>);

    impl EventLoop for Recorder {
        fn on_event(&mut self, _mpv: &Mpv, event: Event) {
            self.0.lock().unwrap().push(event);
        }

        fn on_idle(&mut self, _mpv: &Mpv) -> Option<Duration> {
            None
        }
    }

    #[test]
    fn quit_shuts_the_engine_down_within_2_s() {
        let tmp = tempfile::tempdir().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let engine = Engine::start(
            headless(temp_paths(tmp.path())),
            Recorder(Arc::clone(&seen)),
        )
        .unwrap();

        assert!(engine.quit(Duration::from_secs(2)));
        assert!(seen.lock().unwrap().contains(&Event::Shutdown));

        let (dropped, done) = mpsc::channel();
        thread::spawn(move || {
            drop(engine);
            dropped.send(()).unwrap();
        });
        done.recv_timeout(Duration::from_secs(2))
            .expect("dropping the engine hung");
    }

    #[test]
    fn quit_during_playback_shuts_down_within_2_s() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        // As in Kaleido's default mpv.conf: quitting writes the position.
        std::fs::write(
            paths.config_dir.join("mpv.conf"),
            "save-position-on-quit=yes\n",
        )
        .unwrap();
        let clip = clip(tmp.path(), 10);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let engine = Engine::start(headless(paths.clone()), Recorder(Arc::clone(&seen))).unwrap();

        engine.command(&["loadfile", &clip.to_string_lossy()]);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !seen.lock().unwrap().contains(&Event::PlaybackRestart) {
            assert!(Instant::now() < deadline, "playback never started");
            thread::sleep(Duration::from_millis(10));
        }

        assert!(engine.quit(Duration::from_secs(2)));
        assert!(seen.lock().unwrap().contains(&Event::Shutdown));
        // One entry with the position; the others redirect the clip's parent folders to it.
        let saved = std::fs::read_dir(&paths.watch_later_dir)
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .any(|entry| entry.lines().any(|line| line.starts_with("start=")));
        assert!(saved, "no position in the watch-later folder");
    }

    /// A script or plugin that sets an enforced option gets it put back, and the engine's own
    /// observations never reach the event loop.
    #[test]
    fn enforced_options_changed_at_runtime_are_put_back() {
        let tmp = tempfile::tempdir().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let engine = Engine::start(
            headless(temp_paths(tmp.path())),
            Recorder(Arc::clone(&seen)),
        )
        .unwrap();

        engine.command(&["set", "osc", "yes"]);
        eventually(&engine, "osc is off again", |mpv| {
            !mpv.get_flag("osc").unwrap()
        });
        assert!(engine.quit(Duration::from_secs(2)));
        let seen = seen.lock().unwrap();
        assert!(
            !seen.iter().any(|event| matches!(
                event,
                Event::PropertyChange { id, .. } if *id >= ENGINE_OBSERVE_BASE
            )),
            "{seen:#?}"
        );
    }

    /// Panics at a `script-message panic`, keeps every other message, counts its panics.
    struct Fragile {
        messages: Arc<Mutex<Vec<String>>>,
        panics: Arc<AtomicUsize>,
    }

    impl EventLoop for Fragile {
        fn on_event(&mut self, _mpv: &Mpv, event: Event) {
            if let Event::ClientMessage { args } = event {
                assert_ne!(args, ["panic"], "a deliberate panic in the event loop");
                self.messages.lock().unwrap().push(args.join(" "));
            }
        }

        fn on_idle(&mut self, _mpv: &Mpv) -> Option<Duration> {
            None
        }

        fn on_panic(&mut self, _mpv: &Mpv) {
            self.panics.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Ruling R53: a panic in the event loop (on the mpv event thread) is told to the loop, which
    /// tells the UI, and the events after it still arrive; the engine still shuts down.
    #[test]
    fn a_panic_in_the_event_loop_is_told_and_the_events_go_on() {
        let tmp = tempfile::tempdir().unwrap();
        let messages = Arc::new(Mutex::new(Vec::new()));
        let panics = Arc::new(AtomicUsize::new(0));
        let engine = Engine::start(
            headless(temp_paths(tmp.path())),
            Fragile {
                messages: Arc::clone(&messages),
                panics: Arc::clone(&panics),
            },
        )
        .unwrap();

        engine.command(&["script-message", "before"]);
        engine.command(&["script-message", "panic"]);
        engine.command(&["script-message", "after"]);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !messages.lock().unwrap().contains(&"after".to_owned()) {
            assert!(
                Instant::now() < deadline,
                "the events stopped after the panic"
            );
            thread::sleep(Duration::from_millis(10));
        }

        assert_eq!(*messages.lock().unwrap(), ["before", "after"]);
        assert_eq!(panics.load(Ordering::SeqCst), 1);
        assert!(
            engine.quit(Duration::from_secs(2)),
            "no shutdown after the panic"
        );
    }

    /// Asks to be woken every 20 ms and counts the wakeups.
    struct Ticker(Arc<AtomicUsize>);

    impl EventLoop for Ticker {
        fn on_event(&mut self, _mpv: &Mpv, _event: Event) {}

        fn on_idle(&mut self, _mpv: &Mpv) -> Option<Duration> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Some(Duration::from_millis(20))
        }
    }

    /// A held `time-pos` (Task 3) is sent when its interval ends even if mpv stays quiet.
    #[test]
    fn the_event_thread_wakes_when_on_idle_asks() {
        let tmp = tempfile::tempdir().unwrap();
        let ticks = Arc::new(AtomicUsize::new(0));
        let _engine =
            Engine::start(headless(temp_paths(tmp.path())), Ticker(Arc::clone(&ticks))).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while ticks.load(Ordering::SeqCst) < 5 {
            assert!(Instant::now() < deadline, "on_idle's timeout was not used");
            thread::sleep(Duration::from_millis(10));
        }
    }

    // --- restarts ---------------------------------------------------------------------------

    const LOAD_TIMEOUT: Duration = Duration::from_secs(10);

    fn has_loaded(events: &[Event]) -> bool {
        events.contains(&Event::FileLoaded)
    }

    /// A restart waits in its thread A; the requests sent meanwhile wait in the queue and run on
    /// the new core, in order: 1.5 then + 0.5 is 2 (the other way round it would be 1.5, on the
    /// old core it would be lost).
    #[test]
    fn requests_sent_during_a_restart_reach_the_new_core_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap());
        let (started, running) = mpsc::channel();
        let (go, wait) = mpsc::channel::<()>();
        let mut restart = Restart::new(NoEvents);
        // The restart holds the request thread here until the test has sent its requests.
        restart.prepare = Box::new(move |_| {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5))
                .expect("the test never let the restart go on");
        });
        let restarting = thread::spawn({
            let engine = Arc::clone(&engine);
            move || engine.restart(restart)
        });
        running
            .recv_timeout(LOAD_TIMEOUT)
            .expect("the restart never ran");

        engine.request(Request::SetProperty {
            name: "speed".into(),
            value: "1.5".into(),
        });
        engine.command(&["add", "speed", "0.5"]);
        go.send(()).unwrap();

        assert_eq!(restarting.join().unwrap(), Ok(()));
        assert_eq!(engine.call(|mpv| mpv.get_f64("speed").unwrap()), 2.0);
    }

    /// The old core's loop hears nothing of its end (its `Shutdown` would end the app, and its
    /// file ending for the quit would reach the UI); the new core's loop gets the restored file
    /// and, at a quit, its own shutdown.
    #[test]
    fn the_old_core_never_tells_its_loop_shutdown() {
        let tmp = tempfile::tempdir().unwrap();
        let clip = clip(tmp.path(), 10);
        let old = Recorded::default();
        let engine = Engine::start(headless(temp_paths(tmp.path())), old.clone()).unwrap();
        engine.command(&["loadfile", &clip.to_string_lossy()]);
        old.wait_until("the clip loaded", LOAD_TIMEOUT, has_loaded);

        let new = Recorded::default();
        assert_eq!(engine.restart(Restart::new(new.clone())), Ok(()));
        new.wait_until("the clip loaded in the new core", LOAD_TIMEOUT, has_loaded);

        let heard = old.events();
        assert!(
            !heard.iter().any(|event| matches!(
                event,
                Event::Shutdown
                    | Event::EndFile {
                        reason: EndFileReason::Quit,
                        ..
                    }
            )),
            "{heard:#?}"
        );
        assert!(engine.quit(Duration::from_secs(2)));
        assert!(new.events().contains(&Event::Shutdown));
    }

    /// Two restarts at once from two threads: the second waits for the first, both succeed, one
    /// core runs (only the loop of the restart that ran last hears it), and playback is where it
    /// was, though the second restart came before the first core had loaded the clip again.
    #[test]
    fn a_second_restart_waits_for_the_first() {
        let tmp = tempfile::tempdir().unwrap();
        let clip = clip(tmp.path(), 10);
        let engine = Arc::new(Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap());
        engine.command(&["set", "pause", "yes"]);
        engine.command(&["loadfile", &clip.to_string_lossy()]);
        eventually(&engine, "the clip has loaded", |mpv| {
            mpv.get_f64("duration").is_ok()
        });
        engine.command(&["seek", "4", "absolute"]);
        eventually(&engine, "the clip is at 4 s", |mpv| {
            mpv.get_f64("time-pos")
                .is_ok_and(|position| (position - 4.0).abs() < 0.1)
        });

        let loops = [Recorded::default(), Recorded::default()];
        let restarts: Vec<_> = loops
            .iter()
            .map(|events| {
                let engine = Arc::clone(&engine);
                let restart = Restart::new(events.clone());
                thread::spawn(move || engine.restart(restart))
            })
            .collect();
        for restart in restarts {
            assert_eq!(restart.join().unwrap(), Ok(()));
        }

        engine.command(&["script-message", "which-core"]);
        let heard = |events: &Recorded| {
            events.events().iter().any(
                |event| matches!(event, Event::ClientMessage { args } if args == &["which-core"]),
            )
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !loops.iter().any(heard) {
            assert!(Instant::now() < deadline, "no core answered");
            thread::sleep(Duration::from_millis(10));
        }
        // Time for a second core to answer, if there were one.
        thread::sleep(Duration::from_millis(300));
        assert_eq!(loops.iter().filter(|events| heard(events)).count(), 1);

        eventually(
            &engine,
            "the clip is at 4 s, paused, in the last core",
            |mpv| {
                mpv.get_f64("time-pos")
                    .is_ok_and(|position| (position - 4.0).abs() <= 0.5)
                    && mpv.get_flag("pause").unwrap()
            },
        );
    }

    #[test]
    fn quit_after_a_restart_shuts_down_within_2_s() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap();
        let new = Recorded::default();
        assert_eq!(engine.restart(Restart::new(new.clone())), Ok(()));

        assert!(engine.quit(Duration::from_secs(2)));
        assert!(new.events().contains(&Event::Shutdown));

        let (dropped, done) = mpsc::channel();
        thread::spawn(move || {
            drop(engine);
            dropped.send(()).unwrap();
        });
        done.recv_timeout(Duration::from_secs(2))
            .expect("dropping the engine hung");
    }

    /// The window closed (the engine quit): no new core comes up under the app that ends.
    #[test]
    fn a_player_that_has_quit_is_not_restarted() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap();
        assert!(engine.quit(Duration::from_secs(2)));

        let new = Recorded::default();
        let refused = engine.restart(Restart::new(new.clone()));
        assert!(
            matches!(refused, Err(RestartError::Start(_))),
            "{refused:?}"
        );
        thread::sleep(Duration::from_millis(300));
        assert!(new.events().is_empty(), "{:#?}", new.events());
    }

    /// The new core has Kaleido's options as the first had, mpv.conf notwithstanding, and they
    /// are watched there too: a script that turns the OSC on gets it turned off again. The new
    /// core's loop never sees the engine's own observations.
    #[test]
    fn a_new_core_has_kaleidos_options_enforced_too() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        std::fs::write(paths.config_dir.join("mpv.conf"), "osc=yes\n").unwrap();
        let engine = Engine::start(headless(paths), NoEvents).unwrap();
        let new = Recorded::default();
        assert_eq!(engine.restart(Restart::new(new.clone())), Ok(()));

        eventually(&engine, "osc is off in the new core", |mpv| {
            !mpv.get_flag("osc").unwrap()
        });
        engine.command(&["set", "osc", "yes"]);
        eventually(&engine, "osc is off again", |mpv| {
            !mpv.get_flag("osc").unwrap()
        });
        assert_eq!(
            engine.call(|mpv| mpv.get_string("vo").unwrap()),
            "null",
            "the same config as the first core"
        );
        assert!(engine.quit(Duration::from_secs(2)));
        let heard = new.events();
        assert!(
            !heard.iter().any(|event| matches!(
                event,
                Event::PropertyChange { id, .. } if *id >= ENGINE_OBSERVE_BASE
            )),
            "{heard:#?}"
        );
    }

    /// On a thread the restart would wait for (the request thread, in a `call`; the main thread,
    /// whose message pump the old window needs to go), it is refused at once instead of hanging,
    /// and the player goes on.
    #[test]
    fn a_restart_is_refused_on_the_threads_it_would_wait_for() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap());

        let inside = engine.call({
            let engine = Arc::clone(&engine);
            move |_| engine.restart(Restart::new(NoEvents))
        });
        assert!(matches!(inside, Err(RestartError::Start(_))), "{inside:?}");

        let on_main = thread::Builder::new()
            .name("main".into())
            .spawn({
                let engine = Arc::clone(&engine);
                move || engine.restart(Restart::new(NoEvents))
            })
            .unwrap()
            .join()
            .unwrap();
        assert!(
            matches!(on_main, Err(RestartError::Start(_))),
            "{on_main:?}"
        );

        assert!(engine.call(|mpv| mpv.get_flag("idle-active").unwrap()));
    }
}
