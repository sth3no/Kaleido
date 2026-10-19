//! The qualities of a link (spec 8.5 points 2 and 3, plan decisions 10 and 11). As soon as an
//! http(s) link starts to load (mpv's `path`, which the player's state observes), `yt-dlp -J` runs
//! beside mpv's own yt-dlp ([`crate::tools::ytdlp::probe`]) and what it says is kept for the link:
//! the UI makes the list of qualities from its formats (`stream:formats`, `stream_formats`).
//! Choosing one loads the link again in place, at the same position, with that `ytdl-format` for
//! it alone (`player_set_quality`, [`quality_commands`]); the choice is kept for the link for the
//! rest of the run, and a restart of the core loads the link with it again
//! ([`Streams::entry_options`]). What every link loads with otherwise is mpv's `ytdl-format` from
//! the settings ([`crate::settings::mpv_keys::STREAM_QUALITY_PRESETS`]).
//!
//! A failed probe says why in the classes of the error card ([`classify`] over yt-dlp's stderr)
//! and with the last line yt-dlp wrote, cleaned of paths and links as the diagnostics are
//! ([`sanitize`]): the UI shows it.

use std::collections::{HashMap, VecDeque};
use std::panic::{self, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;

use mpv_ffi::Mpv;
use serde::Serialize;

use crate::player::EntryOptions;
use crate::player::load::{LoadOptions, NO_FOLDER_PLAYLIST, per_file_option};
use crate::player::stream_error::{StreamError, classify, is_link};
use crate::system::diagnostics::sanitize;
use crate::tools::ytdlp::{ProbeError, StreamInfo};

/// The event that tells the UI what is known of a link's qualities; its payload is
/// [`StreamFormats`].
pub const FORMATS_EVENT: &str = "stream:formats";

/// mpv's property with the path or link of what plays, as it was loaded.
pub const PATH: &str = "path";

/// How many links the qualities are kept for: the one played longest ago goes first.
pub const CACHE_SIZE: usize = 32;

/// How many probes run at once. A quick run through a playlist of links (next, next, next, or
/// links that fail one after the other) would start a yt-dlp for each of them; a probe waits for
/// its turn, and one whose link no longer plays when it would start is dropped (the link is
/// probed when it plays again).
pub const PROBES_AT_ONCE: usize = 2;

/// mpv's option for yt-dlp's format selection, per file here.
const YTDL_FORMAT: &str = "ytdl-format";

/// What is known of the qualities of a link: the payload of `stream:formats` and what
/// `stream_formats` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamFormats {
    /// The link as mpv's `path` has it.
    pub url: String,
    pub state: FormatsState,
    /// The quality chosen for the link in this run (a `ytdl-format`); `None` for the default, which
    /// is mpv's `ytdl-format` from the settings.
    pub chosen: Option<String>,
}

/// Where the probe of a link is.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FormatsState {
    /// yt-dlp is asked.
    Loading,
    /// What yt-dlp says of the link.
    Ready { info: StreamInfo },
    /// yt-dlp could not say: `error` is the class of the failure, where the lines say one we know
    /// (`Missing` without a yt-dlp), and `message` the last line yt-dlp wrote (or what went wrong
    /// around it), without paths and links.
    Failed {
        error: Option<StreamError>,
        message: String,
    },
}

/// Why `player_set_quality` changed nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QualityError {
    /// What plays is no http(s) link, or nothing plays.
    NotAStream,
    /// The format is not one Kaleido passes on: the check of the command line's `--format`
    /// (`LoadOptions::validate`).
    Invalid,
}

/// Asks yt-dlp about a link ([`crate::tools::ytdlp::probe`] in the app). Blocks for as long as
/// yt-dlp takes; it runs on a thread of its own.
pub type Probe = Arc<dyn Fn(&str) -> Result<StreamInfo, ProbeError> + Send + Sync>;

/// Tells the UI ([`FORMATS_EVENT`] in the app). Called while the streams' state is locked, so that
/// the UI hears what changes of a link in the order it changed: it must not wait for anything
/// and never calls back into the [`Streams`] (Tauri's `emit` only queues the event).
pub type Emit = Arc<dyn Fn(&StreamFormats) + Send + Sync>;

/// The qualities of the links that played (managed by the app; Ruling R4: the probe and the emit
/// are given, so that the tests give fakes).
pub struct Streams {
    shared: Arc<Shared>,
}

struct Shared {
    probe: Probe,
    emit: Emit,
    state: Mutex<State>,
    /// Woken when a probe ends and when another entry plays: a probe waiting for its turn looks
    /// again.
    turn: Condvar,
}

#[derive(Default)]
struct State {
    /// What is known of the links, the one played longest ago first. At most [`CACHE_SIZE`]; one
    /// that is being probed never goes, so there may be more for as long as probes run.
    links: VecDeque<Link>,
    /// The quality chosen for a link, by its URL; none for the default. Kept for the run, also
    /// when the link's formats have gone from `links`.
    chosen: HashMap<String, String>,
    /// The link that plays now (mpv's `path`); `None` for a file on a disk, or nothing.
    current: Option<String>,
    /// How many probes run.
    probing: usize,
}

struct Link {
    url: String,
    state: FormatsState,
}

impl State {
    fn position(&self, url: &str) -> Option<usize> {
        self.links.iter().position(|link| link.url == url)
    }

    fn link(&self, url: &str) -> Option<&FormatsState> {
        self.position(url).map(|at| &self.links[at].state)
    }

    /// `url` is in `state` now, and the newest; beyond [`CACHE_SIZE`] the oldest that is not being
    /// probed goes.
    fn put(&mut self, url: &str, state: FormatsState) {
        if let Some(at) = self.position(url) {
            self.links.remove(at);
        }
        self.links.push_back(Link {
            url: url.to_owned(),
            state,
        });
        while self.links.len() > CACHE_SIZE {
            let Some(oldest) = self
                .links
                .iter()
                .position(|link| !matches!(link.state, FormatsState::Loading))
            else {
                break;
            };
            self.links.remove(oldest);
        }
    }

    /// `url` plays again: it is the newest.
    fn touch(&mut self, url: &str) {
        if let Some(link) = self.position(url).and_then(|at| self.links.remove(at)) {
            self.links.push_back(link);
        }
    }

    /// The probe of `url` was dropped before it started: nothing is known of it.
    fn forget_loading(&mut self, url: &str) {
        if let Some(at) = self.position(url)
            && matches!(self.links[at].state, FormatsState::Loading)
        {
            self.links.remove(at);
        }
    }

    fn formats(&self, url: &str) -> Option<StreamFormats> {
        Some(StreamFormats {
            url: url.to_owned(),
            state: self.link(url)?.clone(),
            chosen: self.chosen.get(url).cloned(),
        })
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // Every change is made in one step, so a panic elsewhere leaves the state whole.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Tells the UI what `state` knows of `url`, under the lock (see [`Emit`]).
    fn tell(&self, state: &State, url: &str) {
        if let Some(formats) = state.formats(url) {
            (self.emit)(&formats);
        }
    }

    /// The thread of a probe: waits for its turn while its link plays, asks yt-dlp, keeps the
    /// answer and tells it.
    fn probe_in_turn(&self, url: &str) {
        {
            let mut state = self.lock();
            loop {
                if state.current.as_deref() != Some(url) {
                    // Another entry plays by now; the link is probed when it plays again.
                    state.forget_loading(url);
                    return;
                }
                if state.probing < PROBES_AT_ONCE {
                    state.probing += 1;
                    break;
                }
                state = self
                    .turn
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        }
        let probed = match panic::catch_unwind(AssertUnwindSafe(|| (self.probe)(url))) {
            Ok(result) => formats_state(result),
            // The panic hook has logged it; the count of probes stays right.
            Err(_) => FormatsState::Failed {
                error: None,
                message: "the qualities could not be read".to_owned(),
            },
        };
        let mut state = self.lock();
        state.probing -= 1;
        self.turn.notify_all();
        state.put(url, probed);
        self.tell(&state, url);
    }
}

impl Streams {
    pub fn new(probe: Probe, emit: Emit) -> Streams {
        Streams {
            shared: Arc::new(Shared {
                probe,
                emit,
                state: Mutex::new(State::default()),
                turn: Condvar::new(),
            }),
        }
    }

    /// mpv's `path` changed to `path` (`None`: no file). Called on the mpv event thread (lib.rs,
    /// `route`), so it only looks at what is known and starts a thread: a link that is not known,
    /// or whose probe failed, is `Loading` (told) and probed; one that is known is told as it is
    /// known. A file on a disk, and any other scheme, is not probed. The same path again changes
    /// nothing.
    pub fn on_path(&self, path: Option<&str>) {
        let url = path.filter(|path| is_link(path));
        let mut state = self.shared.lock();
        if state.current.as_deref() == url {
            return;
        }
        state.current = url.map(str::to_owned);
        // A probe that waits for its turn looks whether its link still plays.
        self.shared.turn.notify_all();
        let Some(url) = url else {
            return;
        };
        // One probe of a link at a time, and what is known stays known. A link that is not known,
        // or whose probe failed (no yt-dlp yet, the network), is asked now that it plays.
        let known = matches!(
            state.link(url),
            Some(FormatsState::Loading | FormatsState::Ready { .. })
        );
        if known {
            state.touch(url);
            self.shared.tell(&state, url);
        } else {
            state.put(url, FormatsState::Loading);
            self.shared.tell(&state, url);
            self.spawn_probe(&mut state, url);
        }
    }

    fn spawn_probe(&self, state: &mut State, url: &str) {
        let shared = Arc::clone(&self.shared);
        let link = url.to_owned();
        let spawned = thread::Builder::new()
            .name("stream-probe".to_owned())
            .spawn(move || shared.probe_in_turn(&link));
        if let Err(error) = spawned {
            tracing::warn!("a link is not probed for its qualities: {error}");
            state.put(
                url,
                FormatsState::Failed {
                    error: None,
                    message: "the qualities cannot be asked for".to_owned(),
                },
            );
            self.shared.tell(state, url);
        }
    }

    /// What is known of the link that plays now; `None` when what plays is no link, or nothing
    /// plays (`stream_formats`). Reads the state only.
    pub fn current(&self) -> Option<StreamFormats> {
        let state = self.shared.lock();
        let url = state.current.as_deref()?;
        state.formats(url)
    }

    /// The quality `format` (a `ytdl-format`; `None` for the default) is chosen for the link that
    /// plays (`player_set_quality`). It must pass the check of the command line's `--format`
    /// ([`LoadOptions::validate`]), and is kept for the link before anything else happens, so that
    /// a restart of the core from now on loads the link with it; the UI is told. Returns the
    /// reload the request thread runs. Nothing changes on an error.
    pub fn choose(&self, format: Option<&str>) -> Result<Reload, QualityError> {
        if let Some(format) = format {
            let options = LoadOptions {
                start: None,
                format: Some(format.to_owned()),
            };
            options.validate().map_err(|_| QualityError::Invalid)?;
        }
        let mut state = self.shared.lock();
        let url = state.current.clone().ok_or(QualityError::NotAStream)?;
        match format {
            Some(format) => {
                state.chosen.insert(url.clone(), format.to_owned());
            }
            None => {
                state.chosen.remove(&url);
            }
        }
        let live = match state.link(&url) {
            Some(FormatsState::Ready { info }) => Some(info.live),
            _ => None,
        };
        self.shared.tell(&state, &url);
        Ok(Reload {
            url,
            format: format.map(str::to_owned),
            live,
        })
    }

    /// The `entry_options` of a restart of the core (lib.rs, `restart_engine`): a link with a
    /// chosen quality loads with its `ytdl-format` again. It reads the choice when the restart
    /// asks, on the request thread.
    pub fn entry_options(&self) -> EntryOptions {
        let shared = Arc::clone(&self.shared);
        Box::new(move |filename| match shared.lock().chosen.get(filename) {
            Some(format) => vec![(YTDL_FORMAT.to_owned(), format.clone())],
            None => Vec::new(),
        })
    }
}

/// A link loaded again with another quality ([`Streams::choose`]), for the request thread.
#[derive(Debug, Clone, PartialEq)]
pub struct Reload {
    url: String,
    format: Option<String>,
    /// Whether the link is live, from its probe; `None` while that is not known.
    live: Option<bool>,
}

impl Reload {
    /// Loads the link again in place ([`quality_commands`]), with the `mpv` of a `Request::Call`
    /// (never `Engine::call` on this thread). Reads where it is now: when another entry plays by
    /// then, nothing is loaded (the quality stays chosen for the link, for a restart of the core;
    /// the entry plays in the quality it had when it plays again). The position is kept unless
    /// the link is live, which joins the live edge again (as reload.lua does): by its probe, or,
    /// while that is not known, by whether mpv knows a duration. The old entry goes only once the
    /// new one is in the playlist.
    pub fn run(&self, mpv: &Mpv) {
        if mpv.get_string(PATH).ok().as_deref() != Some(self.url.as_str()) {
            tracing::info!("another entry plays now; the link is not loaded with its new quality");
            return;
        }
        let Some(index) = mpv.get_i64("playlist-pos").ok().filter(|index| *index >= 0) else {
            tracing::warn!("the link has no place in the playlist; its quality is not changed now");
            return;
        };
        let position = if self.keeps_position(mpv) {
            mpv.get_f64("time-pos")
                .ok()
                .filter(|position| position.is_finite() && *position >= 0.0)
        } else {
            None
        };
        for args in quality_commands(&self.url, self.format.as_deref(), position, index) {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            if let Err(error) = mpv.command(&args) {
                tracing::warn!("mpv refuses the {} of a new quality: {error}", args[0]);
                return;
            }
        }
    }

    fn keeps_position(&self, mpv: &Mpv) -> bool {
        match self.live {
            Some(live) => !live,
            None => mpv
                .get_f64("duration")
                .is_ok_and(|duration| duration.is_finite() && duration >= 0.0),
        }
    }
}

/// The commands that load the entry `path` at playlist `index` (the one that plays) again with
/// the quality `format` (`None`: the default; it has passed the check of `--format`) from
/// `position` (`None`: where mpv starts it): a new entry right after it, with its own
/// [`NO_FOLDER_PLAYLIST`] (Ruling R55), start and `ytdl-format` (each value quoted as `%N%`), and
/// the old entry removed. While something plays, `insert-next-play` only adds the entry (it plays
/// at once only when nothing is current), and removing the entry that plays makes mpv go on with
/// the one after it, the new one (mpv's `playlist_remove` makes it current, and `PT_NEXT_ENTRY`
/// plays it): the playlist keeps its order and length, the new entry where the old one was.
pub fn quality_commands(
    path: &str,
    format: Option<&str>,
    position: Option<f64>,
    index: i64,
) -> Vec<Vec<String>> {
    let mut options = vec![NO_FOLDER_PLAYLIST.to_owned()];
    if let Some(position) = position {
        options.push(per_file_option("start", &position.to_string()));
    }
    if let Some(format) = format {
        options.push(per_file_option(YTDL_FORMAT, format));
    }
    vec![
        vec![
            "loadfile".to_owned(),
            path.to_owned(),
            "insert-next-play".to_owned(),
            // The index placeholder in front of the options.
            "-1".to_owned(),
            options.join(","),
        ],
        vec!["playlist-remove".to_owned(), index.to_string()],
    ]
}

/// What a probe's answer tells the UI. A failure has the class of the error card where yt-dlp's
/// lines say one, and the last line it wrote as the message; the other failures say what went
/// wrong around yt-dlp. Every message is cleaned of paths and links.
fn formats_state(result: Result<StreamInfo, ProbeError>) -> FormatsState {
    match result {
        Ok(info) => FormatsState::Ready { info },
        Err(ProbeError::Missing) => FormatsState::Failed {
            error: Some(StreamError::Missing),
            message: ProbeError::Missing.to_string(),
        },
        Err(ProbeError::Failed { stderr }) => {
            let lines: Vec<&str> = stderr
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect();
            FormatsState::Failed {
                error: classify(&lines),
                message: sanitize(lines.last().copied().unwrap_or("yt-dlp failed")),
            }
        }
        Err(other) => FormatsState::Failed {
            error: None,
            message: sanitize(&other.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use serde_json::Value;

    use super::*;
    use crate::player::resume::{self, ResumeEntry, ResumeState};
    use crate::player::testing::{NoEvents, eventually, headless, temp_paths};
    use crate::player::{Engine, Request};
    use crate::settings::mpv_keys::STREAM_QUALITY_PRESETS;
    use crate::tools::ytdlp::StreamFormat;

    const TIMEOUT: Duration = Duration::from_secs(5);
    const LINK: &str = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

    fn info(title: &str) -> StreamInfo {
        StreamInfo {
            title: Some(title.to_owned()),
            duration: Some(634.5),
            live: false,
            formats: vec![StreamFormat {
                format_id: "137".to_owned(),
                ext: "mp4".to_owned(),
                height: Some(1080),
                width: Some(1920),
                fps: Some(24.0),
                vcodec: Some("avc1.640028".to_owned()),
                acodec: None,
                dynamic_range: Some("SDR".to_owned()),
                tbr: Some(4_500.0),
                filesize: None,
                filesize_approx: Some(356_000_000),
                protocol: Some("https".to_owned()),
            }],
        }
    }

    fn formats(url: &str, state: FormatsState, chosen: Option<&str>) -> StreamFormats {
        StreamFormats {
            url: url.to_owned(),
            state,
            chosen: chosen.map(str::to_owned),
        }
    }

    fn ready(title: &str) -> FormatsState {
        FormatsState::Ready { info: info(title) }
    }

    /// An emit that keeps what is told, in order.
    fn telling() -> (Emit, mpsc::Receiver<StreamFormats>) {
        let (send, told) = mpsc::channel();
        let emit: Emit = Arc::new(move |formats: &StreamFormats| {
            let _ = send.send(formats.clone());
        });
        (emit, told)
    }

    fn next(told: &mpsc::Receiver<StreamFormats>) -> StreamFormats {
        told.recv_timeout(TIMEOUT)
            .expect("the streams told nothing more")
    }

    /// What is told until one for `url` that `done` takes; what is told of other links meanwhile is
    /// passed over.
    fn told_until(
        told: &mpsc::Receiver<StreamFormats>,
        url: &str,
        done: impl Fn(&StreamFormats) -> bool,
    ) -> StreamFormats {
        loop {
            let formats = next(told);
            if formats.url == url && done(&formats) {
                return formats;
            }
        }
    }

    /// A probe that answers `result` at once, and the links it was asked about.
    fn answering(result: Result<StreamInfo, ProbeError>) -> (Probe, Arc<Mutex<Vec<String>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&calls);
        let probe: Probe = Arc::new(move |url: &str| {
            seen.lock().unwrap().push(url.to_owned());
            result.clone()
        });
        (probe, calls)
    }

    /// A probe that says when it is asked (`started`) and answers once the test lets it
    /// (`release`, one answer per message), as a yt-dlp that takes its time.
    struct Held {
        probe: Probe,
        calls: Arc<Mutex<Vec<String>>>,
        started: mpsc::Receiver<String>,
        release: mpsc::Sender<()>,
    }

    fn held() -> Held {
        let (started_send, started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&calls);
        let probe: Probe = Arc::new(move |url: &str| {
            seen.lock().unwrap().push(url.to_owned());
            let _ = started_send.send(url.to_owned());
            let _ = released.lock().unwrap().recv_timeout(TIMEOUT);
            Ok(info(url))
        });
        Held {
            probe,
            calls,
            started,
            release,
        }
    }

    #[test]
    fn a_stream_is_probed_once_per_url() {
        let held = held();
        let (emit, told) = telling();
        let streams = Streams::new(Arc::clone(&held.probe), emit);

        streams.on_path(Some(LINK));
        assert_eq!(next(&told), formats(LINK, FormatsState::Loading, None));
        assert_eq!(held.started.recv_timeout(TIMEOUT).unwrap(), LINK);
        // The same link again while it is probed: mpv reports it again, or something else played
        // in between.
        streams.on_path(Some(LINK));
        streams.on_path(Some(r"C:\Videa\film.mkv"));
        streams.on_path(Some(LINK));
        assert_eq!(next(&told), formats(LINK, FormatsState::Loading, None));
        held.release.send(()).unwrap();
        assert_eq!(next(&told), formats(LINK, ready(LINK), None));
        // Known now: when it plays again it is told as it is known.
        streams.on_path(None);
        streams.on_path(Some(LINK));
        assert_eq!(next(&told), formats(LINK, ready(LINK), None));
        assert_eq!(streams.current(), Some(formats(LINK, ready(LINK), None)));
        assert_eq!(*held.calls.lock().unwrap(), [LINK]);
        assert!(held.started.try_recv().is_err());

        // Another link has a probe of its own.
        let other = "https://example.com/video.mp4";
        streams.on_path(Some(other));
        assert_eq!(next(&told), formats(other, FormatsState::Loading, None));
        assert_eq!(held.started.recv_timeout(TIMEOUT).unwrap(), other);
        held.release.send(()).unwrap();
        assert_eq!(next(&told), formats(other, ready(other), None));
        assert_eq!(*held.calls.lock().unwrap(), [LINK, other]);
    }

    /// Four links one after the other while yt-dlp takes its time: two probes run, the third waits
    /// and is dropped when the fourth plays, the fourth starts as soon as one of the two is done,
    /// and the third is probed when it plays again.
    #[test]
    fn a_quick_run_through_links_probes_two_at_a_time() {
        let held = held();
        let (emit, told) = telling();
        let streams = Streams::new(Arc::clone(&held.probe), emit);
        let links = [1, 2, 3, 4].map(|n| format!("https://example.com/{n}"));

        for link in &links[..2] {
            streams.on_path(Some(link.as_str()));
            assert_eq!(held.started.recv_timeout(TIMEOUT).unwrap(), *link);
        }
        streams.on_path(Some(links[2].as_str()));
        assert!(
            held.started
                .recv_timeout(Duration::from_millis(300))
                .is_err(),
            "a third yt-dlp started"
        );
        streams.on_path(Some(links[3].as_str()));
        // The first is done: the fourth, which plays, takes its turn; the third does not.
        held.release.send(()).unwrap();
        assert_eq!(held.started.recv_timeout(TIMEOUT).unwrap(), links[3]);
        held.release.send(()).unwrap();
        held.release.send(()).unwrap();
        told_until(&told, &links[3], |formats| {
            matches!(formats.state, FormatsState::Ready { .. })
        });
        assert_eq!(
            *held.calls.lock().unwrap(),
            [links[0].as_str(), links[1].as_str(), links[3].as_str()]
        );

        streams.on_path(Some(links[2].as_str()));
        assert_eq!(held.started.recv_timeout(TIMEOUT).unwrap(), links[2]);
        held.release.send(()).unwrap();
        told_until(&told, &links[2], |formats| {
            matches!(formats.state, FormatsState::Ready { .. })
        });
    }

    #[test]
    fn local_files_are_not_probed() {
        let (probe, calls) = answering(Ok(info("never")));
        let (emit, told) = telling();
        let streams = Streams::new(probe, emit);

        for path in [
            r"C:\Videa\film.mkv",
            r"\\?\C:\Videa čeština (2026)\žluťoučký kůň.mkv",
            r"\\server\share\Videa\film.mkv",
            "D:/Videa/film.mkv",
            "file:///C:/Videa/film.mkv",
            "ytdl://aqz-KE-bpKQ",
            "edl://%5%a.mkv",
            "memory://#EXTM3U",
        ] {
            streams.on_path(Some(path));
        }
        streams.on_path(None);

        // A probe is told as `Loading` before its thread starts, on the spot: nothing was.
        assert!(told.try_recv().is_err());
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(streams.current(), None);
        assert_eq!(streams.choose(None), Err(QualityError::NotAStream));
    }

    #[test]
    fn a_failed_probe_is_classified() {
        let stderr = "WARNING: [youtube] Falling back to generic n function search\n\
                      ERROR: [youtube] aqz-KE-bpKQ: Sign in to confirm your age. This video may be \
                      inappropriate for some users.\n\n";
        let (probe, _) = answering(Err(ProbeError::Failed {
            stderr: stderr.to_owned(),
        }));
        let (emit, told) = telling();
        let streams = Streams::new(probe, emit);

        streams.on_path(Some(LINK));
        assert_eq!(next(&told).state, FormatsState::Loading);
        assert_eq!(
            next(&told).state,
            FormatsState::Failed {
                error: Some(StreamError::AgeRestricted),
                message: "ERROR: [youtube] aqz-KE-bpKQ: Sign in to confirm your age. This video \
                          may be inappropriate for some users."
                    .to_owned(),
            }
        );

        let failed = |error, message: &str| FormatsState::Failed {
            error,
            message: message.to_owned(),
        };
        let stderr = |text: &str| {
            formats_state(Err(ProbeError::Failed {
                stderr: text.to_owned(),
            }))
        };
        // No yt-dlp (yet): the card's "update and try again".
        assert_eq!(
            formats_state(Err(ProbeError::Missing)),
            failed(Some(StreamError::Missing), "yt-dlp is not there")
        );
        // No paths and no links, as in the diagnostics.
        assert_eq!(
            stderr(
                r"ERROR: could not find firefox cookies database in C:\Users\Jiří Novák\AppData\Roaming\Mozilla\Firefox\Profiles"
            ),
            failed(
                Some(StreamError::Cookies),
                "ERROR: could not find firefox cookies database in <path>"
            )
        );
        assert_eq!(
            stderr(
                "ERROR: Failed to decrypt with DPAPI. See https://github.com/yt-dlp/yt-dlp/issues/10927 for more info\n"
            ),
            failed(
                Some(StreamError::Cookies),
                "ERROR: Failed to decrypt with DPAPI. See <url> for more info"
            )
        );
        // Words nothing is known of: no class, the line as it is.
        assert_eq!(
            stderr("ERROR: [generic] Something new went wrong\r\n"),
            failed(None, "ERROR: [generic] Something new went wrong")
        );
        assert_eq!(stderr(" \n\n"), failed(None, "yt-dlp failed"));
        // What went wrong around yt-dlp.
        assert_eq!(
            formats_state(Err(ProbeError::Timeout)),
            failed(None, "yt-dlp took too long")
        );
        assert_eq!(
            formats_state(Err(ProbeError::Playlist)),
            failed(None, "the link is a playlist")
        );
        assert_eq!(formats_state(Ok(info("x"))), ready("x"));
    }

    /// A failed probe is not the last word: the link is asked again when it plays again (yt-dlp may
    /// be there by then).
    #[test]
    fn a_link_whose_probe_failed_is_probed_when_it_plays_again() {
        let (probe, calls) = answering(Err(ProbeError::Missing));
        let (emit, told) = telling();
        let streams = Streams::new(probe, emit);
        for _ in 0..2 {
            streams.on_path(Some(LINK));
            assert_eq!(next(&told).state, FormatsState::Loading);
            assert!(matches!(next(&told).state, FormatsState::Failed { .. }));
            streams.on_path(None);
        }
        assert_eq!(*calls.lock().unwrap(), [LINK, LINK]);
    }

    #[test]
    fn chosen_quality_survives_a_restart() {
        let (probe, _) = answering(Ok(info("Big Buck Bunny")));
        let (emit, told) = telling();
        let streams = Streams::new(probe, emit);
        // Made before the choice, as a restart would be: it reads the choice when it is asked.
        let options = streams.entry_options();
        assert!(options(LINK).is_empty());

        streams.on_path(Some(LINK));
        told_until(&told, LINK, |formats| {
            matches!(formats.state, FormatsState::Ready { .. })
        });
        let format = STREAM_QUALITY_PRESETS[2];
        let reload = streams.choose(Some(format)).unwrap();
        assert_eq!(
            next(&told),
            formats(LINK, ready("Big Buck Bunny"), Some(format))
        );
        assert_eq!(
            reload,
            Reload {
                url: LINK.to_owned(),
                format: Some(format.to_owned()),
                live: Some(false),
            }
        );
        assert_eq!(options(LINK), [(YTDL_FORMAT.to_owned(), format.to_owned())]);
        assert!(options("https://example.com/other").is_empty());

        // What the restart makes of it: the link loads again with its quality, quoted.
        let state = ResumeState {
            entries: vec![ResumeEntry {
                filename: LINK.to_owned(),
                options: options(LINK),
            }],
            current: Some(0),
            ..ResumeState::default()
        };
        let loadfile = resume::restore_commands(&state)
            .into_iter()
            .find(|args| args[0] == "loadfile")
            .unwrap();
        assert_eq!(loadfile[1], LINK);
        assert!(
            loadfile[4].contains(&per_file_option(YTDL_FORMAT, format)),
            "{loadfile:?}"
        );

        // Another link plays for a while: the choice stays with this one.
        streams.on_path(Some("https://example.com/other"));
        streams.on_path(Some(LINK));
        assert_eq!(options(LINK), [(YTDL_FORMAT.to_owned(), format.to_owned())]);
        // Back to the default: nothing for the next restart.
        streams.choose(None).unwrap();
        told_until(&told, LINK, |formats| formats.chosen.is_none());
        assert!(options(LINK).is_empty());
        assert_eq!(streams.current().unwrap().chosen, None);
    }

    #[test]
    fn a_quality_is_checked_before_it_is_kept() {
        let (probe, _) = answering(Ok(info("x")));
        let (emit, told) = telling();
        let streams = Streams::new(probe, emit);
        assert_eq!(
            streams.choose(Some(STREAM_QUALITY_PRESETS[0])),
            Err(QualityError::NotAStream)
        );
        streams.on_path(Some(LINK));
        told_until(&told, LINK, |formats| {
            matches!(formats.state, FormatsState::Ready { .. })
        });

        for bad in ["best,vo=gpu", "", "a b", "bestč", &"b".repeat(201)] {
            assert_eq!(
                streams.choose(Some(bad)),
                Err(QualityError::Invalid),
                "{bad:?}"
            );
        }
        assert!(told.try_recv().is_err(), "nothing was kept, nothing told");
        assert!(streams.entry_options()(LINK).is_empty());
        // A height the UI made the selection for itself passes like a preset.
        let custom = "bv*[height<=?360]+ba/b[height<=?360]";
        assert!(streams.choose(Some(custom)).is_ok());
        assert_eq!(next(&told), formats(LINK, ready("x"), Some(custom)));
    }

    #[test]
    fn quality_commands_reload_in_place() {
        let strings = |args: &[&str]| args.iter().map(|&arg| arg.to_owned()).collect::<Vec<_>>();
        // 36 bytes of format, 5 of the start.
        assert_eq!(
            quality_commands(
                LINK,
                Some("bv*[height<=?720]+ba/b[height<=?720]"),
                Some(183.5),
                2
            ),
            [
                strings(&[
                    "loadfile",
                    LINK,
                    "insert-next-play",
                    "-1",
                    "autocreate-playlist=no,start=%5%183.5,ytdl-format=%36%bv*[height<=?720]+ba/b[height<=?720]",
                ]),
                strings(&["playlist-remove", "2"]),
            ]
        );
        // The default quality of a live link: no format and no start.
        assert_eq!(
            quality_commands(LINK, None, None, 0),
            [
                strings(&[
                    "loadfile",
                    LINK,
                    "insert-next-play",
                    "-1",
                    "autocreate-playlist=no"
                ]),
                strings(&["playlist-remove", "0"]),
            ]
        );
        assert_eq!(
            quality_commands(LINK, Some("ba/b"), Some(3.0), 7)[0][4],
            "autocreate-playlist=no,start=%1%3,ytdl-format=%4%ba/b"
        );
    }

    /// What `stream_formats` and `stream:formats` carry, as the UI reads them.
    #[test]
    fn formats_reach_the_ui_as_camel_case_json() {
        let failed = formats(
            LINK,
            FormatsState::Failed {
                error: Some(StreamError::SignIn),
                message: "ERROR: [youtube] x: Sign in to confirm you're not a bot".to_owned(),
            },
            Some("ba/b"),
        );
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({
                "url": LINK,
                "state": {
                    "type": "failed",
                    "error": "signIn",
                    "message": "ERROR: [youtube] x: Sign in to confirm you're not a bot"
                },
                "chosen": "ba/b"
            })
        );
        assert_eq!(
            serde_json::to_value(FormatsState::Loading).unwrap(),
            serde_json::json!({ "type": "loading" })
        );
        assert_eq!(
            serde_json::to_value(ready("x")).unwrap()["info"]["formats"][0]["formatId"],
            "137"
        );
        assert_eq!(
            serde_json::to_value(QualityError::NotAStream).unwrap(),
            "notAStream"
        );
    }

    // The test below plays files in a real libmpv (vo=null, ao=null): local clips in place of a
    // link, which is loaded again the same way.

    fn playlist(mpv: &Mpv) -> Vec<Value> {
        let text = mpv.get_string("playlist").unwrap();
        match serde_json::from_str(&text).unwrap() {
            Value::Array(entries) => entries,
            other => panic!("mpv's playlist is no list: {other}"),
        }
    }

    /// [a, b], b plays (paused) at 3 s, and its quality is changed: the playlist still has two
    /// entries, a and then b, b is a new entry and the one that plays, at 3 s ± 0.5 with the
    /// chosen `ytdl-format` for itself, and still paused. Shows that the old entry can go in the
    /// same request as the new one is added, without waiting for the new one's `file-loaded`.
    #[test]
    fn changing_quality_keeps_the_playlist_and_the_position() {
        let tmp = tempfile::tempdir().unwrap();
        let [a, b] = ["a.y4m", "b.y4m"].map(|name| {
            let path = tmp.path().join(name);
            mpv_ffi::testing::write_y4m(&path, 64, 36, 10 * 30).unwrap();
            path.to_string_lossy().into_owned()
        });
        let engine = Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap();
        // Paused, so that the position stays where it was put.
        engine.command(&["set", "pause", "yes"]);
        engine.command(&["loadfile", &a, "append"]);
        engine.command(&["loadfile", &b, "append"]);
        engine.command(&["playlist-play-index", "1"]);
        let loaded = b.clone();
        eventually(&engine, "b has loaded", move |mpv| {
            mpv.get_string(PATH).is_ok_and(|path| path == loaded) && mpv.get_f64("duration").is_ok()
        });
        engine.command(&["seek", "3", "absolute", "exact"]);
        eventually(&engine, "b is at 3 s", |mpv| {
            mpv.get_f64("time-pos")
                .is_ok_and(|position| (position - 3.0).abs() < 0.1)
        });
        let old = engine.call(|mpv| playlist(mpv)[1]["id"].as_i64().unwrap());

        let format = STREAM_QUALITY_PRESETS[3];
        let reload = Reload {
            url: b.clone(),
            format: Some(format.to_owned()),
            live: Some(false),
        };
        engine.request(Request::Call(Box::new(move |mpv| reload.run(mpv))));

        let (first, second) = (a.clone(), b.clone());
        eventually(&engine, "the new entry of b plays at 3 s", move |mpv| {
            let entries = playlist(mpv);
            entries.len() == 2
                && entries[0]["filename"] == first.as_str()
                && entries[1]["filename"] == second.as_str()
                && entries[1]["current"] == true
                && entries[1]["id"].as_i64() != Some(old)
                && mpv.get_i64("playlist-pos").ok() == Some(1)
                && mpv
                    .get_f64("time-pos")
                    .is_ok_and(|position| (position - 3.0).abs() <= 0.5)
        });
        assert_eq!(
            engine.call(|mpv| mpv.get_string(YTDL_FORMAT).unwrap()),
            format
        );
        assert!(engine.call(|mpv| mpv.get_flag("pause").unwrap()));
    }
}
