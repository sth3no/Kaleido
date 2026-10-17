//! One libmpv core and the two threads that talk to it. Requests (commands, property writes,
//! closures) run in the order they were sent on the request thread; events go to an
//! [`EventLoop`] on the event thread. The main (window) thread never calls mpv (M0 review).

use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use mpv_ffi::{Event, Mpv, PropertyKind, PropertyValue, load_api, locate_libmpv};

use super::options;
use crate::paths::AppPaths;

/// Observation reply ids from here up are the engine's own (the enforced options). An
/// [`EventLoop`] observes with ids below it; the engine's property changes never reach it.
pub const ENGINE_OBSERVE_BASE: u64 = 1_000_000;

/// mpv's `sub-margin-y` property.
const SUB_MARGIN_Y: &str = "sub-margin-y";

/// mpv's own `sub-margin-y`, for when it cannot be read.
const MPV_SUB_MARGIN: i64 = 22;

/// What the core is started with.
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
    /// the last one.
    fn on_event(&mut self, mpv: &Mpv, event: Event);

    /// Called when no event is pending: once at the start and after every burst of events.
    /// Returns how long to wait for the next event before calling it again; `None` waits
    /// until an event comes.
    fn on_idle(&mut self, mpv: &Mpv) -> Option<Duration>;
}

/// Work for the request thread, done in the order it was sent.
pub enum Request {
    Command(Vec<String>),
    SetProperty { name: String, value: String },
    Call(Box<dyn FnOnce(&Mpv) + Send>),
}

pub struct Engine {
    mpv: Arc<Mpv>,
    /// `None` only while dropping: closing the channel ends the request thread.
    requests: Option<mpsc::Sender<Request>>,
    status: Arc<Status>,
    request_thread: Option<JoinHandle<()>>,
    event_thread: Option<JoinHandle<()>>,
    /// The `sub-margin-y` this core had before `set_sub_margin` first set it. It belongs to the
    /// core and not to the process: every engine (every test has its own) reads its own mpv.conf.
    sub_margin_base: Arc<OnceLock<i64>>,
}

#[derive(Default)]
struct Status {
    /// Set when dropping: the event thread returns at its next wakeup.
    stop: AtomicBool,
    /// The event loop has received `Event::Shutdown`.
    shut_down: Mutex<bool>,
    changed: Condvar,
}

impl Engine {
    /// Creates the core with Kaleido's options (`options::enforced`), initializes it (that
    /// loads the user's mpv.conf) and starts the threads. The first request puts back the
    /// options mpv.conf overrode (`options::reassert`); from then on the event thread watches
    /// them and queues the same whenever one changes.
    pub fn start(cfg: EngineConfig, events: impl EventLoop) -> mpv_ffi::Result<Engine> {
        let mpv = Mpv::create(load_api(&locate_libmpv())?)?;
        for (name, value) in options::enforced(&cfg) {
            mpv.set_option(name, &value)?;
        }
        mpv.initialize()?;

        let (requests, queue) = mpsc::channel();
        let enforcer = Enforcer {
            watched: options::reasserted(&cfg),
            cfg: Arc::new(cfg),
            requests: requests.clone(),
        };
        enforcer.observe(&mpv)?;
        // Not on the caller's (main) thread: setting `vo` back recreates mpv's window, a child
        // of the main window, and that must not wait for a main thread blocked in mpv.
        enforcer.queue_reassert();

        let mpv = Arc::new(mpv);
        let status = Arc::new(Status::default());
        let request_thread = spawn("mpv-requests", {
            let mpv = Arc::clone(&mpv);
            move || run_requests(&mpv, queue)
        });
        let event_thread = spawn("mpv-events", {
            let mpv = Arc::clone(&mpv);
            let status = Arc::clone(&status);
            move || run_events(&mpv, events, &enforcer, &status)
        });
        Ok(Engine {
            mpv,
            requests: Some(requests),
            status,
            request_thread: Some(request_thread),
            event_thread: Some(event_thread),
            sub_margin_base: Arc::new(OnceLock::new()),
        })
    }

    /// Queues `request` and returns at once.
    pub fn request(&self, request: Request) {
        let queued = self
            .requests
            .as_ref()
            .is_some_and(|requests| requests.send(request).is_ok());
        if !queued {
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
    /// result. Blocks the caller, so never call it on the main thread.
    pub fn call<T: Send + 'static>(&self, f: impl FnOnce(&Mpv) -> T + Send + 'static) -> T {
        let (reply, result) = mpsc::sync_channel(1);
        self.request(Request::Call(Box::new(move |mpv| {
            // Cannot fail: the caller waits on `result`.
            let _ = reply.send(f(mpv));
        })));
        result.recv().expect("the mpv call panicked")
    }

    /// Sets `sub-margin-y` to `margin`, but never below the margin this core had before the first
    /// call (mpv's own 22, or the one in the user's mpv.conf): the UI asks for 0 while its controls
    /// are hidden, which means "nothing of mine is in the way", not "subtitles on the bottom edge"
    /// (Ruling R38). The first call reads the margin and writes in the same request, so nothing
    /// queued by anyone else comes between; the margin is remembered for the life of the engine.
    /// Queues and returns at once.
    pub fn set_sub_margin(&self, margin: i64) {
        let remembered = Arc::clone(&self.sub_margin_base);
        self.request(Request::Call(Box::new(move |mpv| {
            let own = remembered.get().copied().or_else(|| {
                // Not remembered when it cannot be read: the next call tries again.
                mpv.get_i64(SUB_MARGIN_Y)
                    .ok()
                    .map(|own| *remembered.get_or_init(|| own))
            });
            let value = margin.max(own.unwrap_or(MPV_SUB_MARGIN));
            if let Err(error) = mpv.set_property(SUB_MARGIN_Y, &value.to_string()) {
                tracing::warn!("mpv request failed: {error}");
            }
        })));
    }

    /// Queues `quit` (mpv saves the position with `save-position-on-quit`) and waits up to
    /// `timeout` until the event loop has received `Event::Shutdown`.
    pub fn quit(&self, timeout: Duration) -> bool {
        self.command(&["quit"]);
        let shut_down = self
            .status
            .shut_down
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
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
        // The event thread first: it holds a sender, so the queue closes only after it ends.
        // It has returned after `Shutdown` already, or returns at this wakeup.
        self.status.stop.store(true, Ordering::SeqCst);
        self.mpv.wakeup();
        join(self.event_thread.take());
        // The request thread finishes what is queued, then sees the closed channel.
        self.requests = None;
        join(self.request_thread.take());
        // The last `Arc<Mpv>` goes with `self`: mpv_terminate_destroy.
    }
}

/// Keeps the `options::REASSERTED` options enforced while the core runs. Besides mpv.conf at
/// `initialize`, conditional profiles (applied by auto_profiles.lua at startup and whenever a
/// condition changes, e.g. on every file load) and scripts can set them at any time.
struct Enforcer {
    cfg: Arc<EngineConfig>,
    /// Enforced values, observed under `ENGINE_OBSERVE_BASE + index`.
    watched: Vec<(&'static str, String)>,
    requests: mpsc::Sender<Request>,
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

    /// Nobody waits for the result, so a failure is logged.
    fn queue_reassert(&self) {
        let cfg = Arc::clone(&self.cfg);
        // Sending fails only once the request thread is gone, i.e. while dropping the engine.
        let _ = self.requests.send(Request::Call(Box::new(move |mpv| {
            if let Err(error) = options::reassert(mpv, &cfg) {
                tracing::error!("cannot restore Kaleido's mpv options: {error}");
            }
        })));
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

fn run_requests(mpv: &Mpv, queue: mpsc::Receiver<Request>) {
    for request in queue {
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
}

fn run_events(mpv: &Mpv, mut events: impl EventLoop, enforcer: &Enforcer, status: &Status) {
    loop {
        let timeout = events
            .on_idle(mpv)
            .map_or(-1.0, |timeout| timeout.as_secs_f64());
        let mut event = mpv.wait_event(timeout);
        let mut drifted = false;
        while !matches!(event, Event::None) {
            match event {
                Event::PropertyChange { id, ref value, .. } if id >= ENGINE_OBSERVE_BASE => {
                    drifted |= enforcer.drifted(id, value);
                }
                Event::Shutdown => {
                    events.on_event(mpv, Event::Shutdown);
                    *status
                        .shut_down
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = true;
                    status.changed.notify_all();
                    return;
                }
                event => events.on_event(mpv, event),
            }
            event = mpv.wait_event(0.0);
        }
        // Once per burst: `reassert` puts back everything that differs.
        if drifted {
            enforcer.queue_reassert();
        }
        if status.stop.load(Ordering::SeqCst) {
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

    use mpv_ffi::{Event, Mpv};

    use super::{ENGINE_OBSERVE_BASE, Engine, EventLoop, Request};
    use crate::player::testing::{NoEvents, clip, eventually, headless, temp_paths};

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
}
