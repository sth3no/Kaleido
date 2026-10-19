//! The tools Kaleido manages (spec 6.6, plan decision 7): yt-dlp, which mpv's `ytdl_hook` runs for
//! links, and Deno, which yt-dlp needs for YouTube. They live in `%LOCALAPPDATA%\Kaleido\tools\`
//! with their `tools.json` ([`store`]), are Kaleido's own (never shared with another program,
//! spec 9.4), and come straight from GitHub Releases,
//! `https://github.com/<repo>/releases/latest/download/<asset>`, without GitHub's API and its
//! limits ([`source`]).
//!
//! [`Tools`] is the service. A check of a tool ([`Tools::check`]):
//! 1. takes over the installation's bundled copy when the tool is missing and the copy is the one
//!    its `tools.json` names (plan decision 7);
//! 2. reads the release's checksum of the asset from its checksum list ([`checksum`]);
//! 3. if that is the checksum of the installed tool, notes the time of the check and is done;
//! 4. otherwise downloads the asset, verifies it against that checksum, puts the tool in place
//!    beside the one that may run ([`replace`]), reads its version ([`Inspect`]) and records it;
//! 5. on any error leaves the tool on the disk as it was and backs off ([`schedule`], spec 10.7).
//!    A tool whose file is gone, or whose version cannot be read, is such an error too
//!    ([`ToolError::Gone`], [`ToolError::Silent`]; controller Ruling R10): a virus scanner that
//!    takes `yt-dlp.exe` away is not answered with a download at every round. A check that is not
//!    forced and starts with an installed record, no failure in a row (`failures` 0) and the file
//!    missing counts that as one failure and puts nothing in place (no bundled copy, no
//!    download); the next one, which has that failure (after the backoff) or is forced, does.
//!
//! Nothing is ever put in place unverified: a download must have the checksum the release lists
//! for it, and a bundled copy the one the installer's `tools.json` beside it names (the installer
//! takes it from the release). One check of a tool runs at a time: another one that comes
//! meanwhile waits for it and gets its result; the two tools are checked independently.
//!
//! [`Tools`] starts no process and knows nothing of Tauri: the version of a tool comes through
//! [`Inspect`] (the real one is [`run::Processes`]). [`Service`] runs the checks on a scheduler
//! thread of its own and tells the app ([`Host`]) what they change: every state of a tool for the
//! UI (`tools:status`), and the options of mpv's `ytdl_hook` for the running core ([`mpv`]).
//! [`ytdlp`] asks yt-dlp about a link. Tauri is lib.rs's and commands.rs's.

pub mod checksum;
pub mod http;
pub mod mpv;
pub mod replace;
pub mod run;
pub mod schedule;
pub mod store;
pub mod ytdlp;

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::paths::AppPaths;
use http::{Fetch, FetchError};
use store::{ToolRecord, ToolsFile, stamp};

/// How often yt-dlp is checked (spec 6.6): every day.
pub const YT_DLP_INTERVAL: Duration = Duration::hours(24);
/// How often Deno is checked (spec 6.6): every week.
pub const DENO_INTERVAL: Duration = Duration::days(7);

/// The most a checksum list may be.
pub const SUMS_LIMIT: u64 = 64 * 1024;
/// The most `yt-dlp.exe` may be (2026.08.19 is 17 MB).
pub const YT_DLP_LIMIT: u64 = 64 * 1024 * 1024;
/// The most Deno's zip may be (v2.9.7's is 43 MB).
pub const DENO_ZIP_LIMIT: u64 = 256 * 1024 * 1024;
/// The event that tells the UI a tool's state changed; its payload is [`ToolStatus`].
pub const STATUS_EVENT: &str = "tools:status";

/// The most `deno.exe` may unpack to, so that a broken zip cannot fill the disk.
const DENO_EXE_LIMIT: u64 = 1024 * 1024 * 1024;
/// The name of Deno in its zip: at the root.
const DENO_IN_ZIP: &str = "deno.exe";
/// The folder of the installation's bundled copies in `resource_dir`.
const BUNDLED_DIR: &str = "tools";

/// A managed tool; `ytDlp` and `deno` in `tools.json` and to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolId {
    YtDlp,
    Deno,
}

impl ToolId {
    /// Every tool, in the order the UI lists them.
    pub const ALL: [ToolId; 2] = [ToolId::YtDlp, ToolId::Deno];

    /// Its file in the tools folder.
    pub fn exe_name(self) -> &'static str {
        match self {
            ToolId::YtDlp => "yt-dlp.exe",
            ToolId::Deno => "deno.exe",
        }
    }

    /// How often it is checked ([`YT_DLP_INTERVAL`], [`DENO_INTERVAL`]).
    pub fn interval(self) -> Duration {
        match self {
            ToolId::YtDlp => YT_DLP_INTERVAL,
            ToolId::Deno => DENO_INTERVAL,
        }
    }

    /// The most its release asset may be.
    pub fn limit(self) -> u64 {
        match self {
            ToolId::YtDlp => YT_DLP_LIMIT,
            ToolId::Deno => DENO_ZIP_LIMIT,
        }
    }
}

impl fmt::Display for ToolId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ToolId::YtDlp => "yt-dlp",
            ToolId::Deno => "Deno",
        })
    }
}

/// yt-dlp's release channel (Nastavení → Aktualizace); Deno has only its stable releases.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    /// yt-dlp's nightly builds, from their own repository.
    Nightly,
}

/// Where a tool comes from: `<base><asset>` and `<base><sums>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Source {
    /// The release asset: the tool itself, or the zip it is in.
    pub asset: &'static str,
    /// The release's checksum list of its assets, or of the one asset.
    pub sums: &'static str,
    /// The release's download address, with the `/` at its end.
    pub base: &'static str,
}

impl Source {
    pub fn asset_url(&self) -> String {
        format!("{}{}", self.base, self.asset)
    }

    pub fn sums_url(&self) -> String {
        format!("{}{}", self.base, self.sums)
    }
}

/// Where `tool` comes from in `channel` (which Deno does not have).
pub fn source(tool: ToolId, channel: Channel) -> Source {
    match (tool, channel) {
        (ToolId::YtDlp, Channel::Stable) => Source {
            asset: "yt-dlp.exe",
            sums: "SHA2-256SUMS",
            base: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/",
        },
        (ToolId::YtDlp, Channel::Nightly) => Source {
            asset: "yt-dlp.exe",
            sums: "SHA2-256SUMS",
            base: "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/",
        },
        (ToolId::Deno, _) => Source {
            asset: "deno-x86_64-pc-windows-msvc.zip",
            sums: "deno-x86_64-pc-windows-msvc.zip.sha256sum",
            base: "https://github.com/denoland/deno/releases/latest/download/",
        },
    }
}

/// Reads a tool's version from the tool. The real one runs `--version` (Task 9).
pub trait Inspect: Send + Sync {
    /// The version `exe` says it is, or `None` when it says nothing that can be read.
    fn version(&self, tool: ToolId, exe: &Path) -> Option<String>;
}

/// What a tool is doing, for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolState {
    /// Not installed, and not tried yet or not since the start.
    Missing,
    /// A check runs: the release's checksum is being read.
    Checking,
    /// A check runs and found a new version: it is being downloaded and put in place.
    Downloading,
    /// Installed, and the last check (if any) went through.
    Ready,
    /// The last check failed; an installed tool is still there and used.
    Failed,
}

/// A tool's state, as the UI shows it (Nastavení → Aktualizace).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub tool: ToolId,
    pub state: ToolState,
    /// The installed tool's version; `None` while none is installed.
    pub version: Option<String>,
    /// The last check that reached the release (RFC 3339, UTC).
    pub checked_at: Option<String>,
    /// Why the last check failed, while it is [`ToolState::Failed`] and this run of Kaleido knows.
    pub error: Option<String>,
}

/// Why a check failed. In every case the tool on the disk is as it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolError {
    /// A download did not happen.
    Fetch(FetchError),
    /// The release's checksum list names no checksum for the asset.
    NoChecksum,
    /// The download is not the file the release's checksum names.
    Checksum { expected: String, actual: String },
    /// Deno's zip cannot be read or has no `deno.exe`.
    Archive(String),
    /// The tool could not be put in place, or the check stopped unexpectedly.
    Io(String),
    /// The tool's file is gone (Ruling R10): a virus scanner that quarantines it, as some do with
    /// PyInstaller programs like `yt-dlp.exe`. Either a check that is not forced started with an
    /// installed record, no failure in a row (`failures` 0) and the file missing, and put nothing
    /// in place (no bundled copy, no download; once per vanishing: the next check, which has that
    /// failure, after the backoff, or is forced, puts it in place again); or the file was gone
    /// right after a check put it in place. Its backoff climbs with the vanishings in a row
    /// ([`ToolRecord::vanished`]), also across the installs in between.
    Gone(ToolId),
    /// The tool is in place after a check, but its version could not be read ([`Inspect`]
    /// returned none): `--version` could not be started, ended with an error, took longer than
    /// [`run::VERSION_TIMEOUT`], or wrote nothing that reads as a version. It does not run as it
    /// should (a virus scanner that blocks it, a broken file). It is asked again at every round
    /// ([`Tools::inspect_again`]).
    Silent(ToolId),
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ToolError::Fetch(error) => write!(f, "{error}"),
            ToolError::NoChecksum => f.write_str("the release lists no checksum for the file"),
            ToolError::Checksum { expected, actual } => write!(
                f,
                "the download's SHA-256 is {actual}, not the release's {expected}"
            ),
            ToolError::Archive(message) => write!(f, "Deno's zip: {message}"),
            ToolError::Io(message) => f.write_str(message),
            ToolError::Gone(tool) => write!(
                f,
                "{} disappeared after it was put in place (an antivirus may have quarantined it)",
                tool.exe_name()
            ),
            ToolError::Silent(tool) => write!(
                f,
                "{} is in place but does not run: it did not say its version (an antivirus may \
                 block it)",
                tool.exe_name()
            ),
        }
    }
}

impl std::error::Error for ToolError {}

impl From<FetchError> for ToolError {
    fn from(error: FetchError) -> ToolError {
        ToolError::Fetch(error)
    }
}

/// `deno.exe` out of Deno's release zip.
pub fn deno_from_zip(zip: &[u8]) -> Result<Vec<u8>, ToolError> {
    let mut archive = zip::ZipArchive::new(io::Cursor::new(zip))
        .map_err(|error| ToolError::Archive(error.to_string()))?;
    let mut file = archive
        .by_name(DENO_IN_ZIP)
        .map_err(|error| ToolError::Archive(format!("{DENO_IN_ZIP}: {error}")))?;
    // Room for all of it at once (about 120 MB): a growing buffer would copy it over and over.
    let mut exe = Vec::with_capacity(usize::try_from(file.size().min(DENO_EXE_LIMIT)).unwrap_or(0));
    // The zip checks the CRC of what it unpacks as it reaches the end.
    file.by_ref()
        .take(DENO_EXE_LIMIT + 1)
        .read_to_end(&mut exe)
        .map_err(|error| ToolError::Archive(format!("{DENO_IN_ZIP}: {error}")))?;
    if u64::try_from(exe.len()).unwrap_or(u64::MAX) > DENO_EXE_LIMIT {
        return Err(ToolError::Archive(format!("{DENO_IN_ZIP} is too large")));
    }
    Ok(exe)
}

/// The managed tools (see the module).
pub struct Tools {
    /// `tools_dir`: the tools and `tools.json`.
    dir: PathBuf,
    /// `resource_dir\tools`: the installation's bundled copies and their `tools.json`.
    bundled: PathBuf,
    fetch: Arc<dyn Fetch>,
    inspect: Arc<dyn Inspect>,
    state: Mutex<State>,
    /// Told when a check ends.
    finished: Condvar,
    /// Told every state a check moves a tool to ([`Tools::observe`]).
    observer: Mutex<Option<Observer>>,
}

/// What hears the states of the tools.
type Observer = Arc<dyn Fn(&ToolStatus) + Send + Sync>;

#[derive(Default)]
struct State {
    file: ToolsFile,
    /// The checks that run, by tool.
    running: BTreeMap<ToolId, Running>,
    /// The result of each tool's last check, with the number of its run.
    results: BTreeMap<ToolId, (u64, Result<ToolStatus, ToolError>)>,
    /// Why each tool's last check failed, while it did.
    errors: BTreeMap<ToolId, String>,
    /// The runs so far: the last one's number.
    runs: u64,
    /// How often each tool was put in place in this run ([`Tools::installs`]).
    installs: BTreeMap<ToolId, u64>,
    /// The checks that wait for another one to end.
    #[cfg(test)]
    waiting: usize,
}

struct Running {
    run: u64,
    /// [`ToolState::Checking`] or [`ToolState::Downloading`].
    phase: ToolState,
}

impl Tools {
    /// The service over `paths.tools_dir`, with what `tools.json` there says. Old files of
    /// replaces that ran in an earlier run go now ([`replace::sweep`]). Downloads nothing.
    pub fn new(paths: &AppPaths, fetch: Arc<dyn Fetch>, inspect: Arc<dyn Inspect>) -> Tools {
        let dir = paths.tools_dir.clone();
        replace::sweep(&dir);
        let file = ToolsFile::load(dir.join(store::FILE));
        Tools {
            bundled: paths.resource_dir.join(BUNDLED_DIR),
            dir,
            fetch,
            inspect,
            state: Mutex::new(State {
                file,
                ..State::default()
            }),
            finished: Condvar::new(),
            observer: Mutex::new(None),
        }
    }

    /// From now on `observer` hears every state a check moves a tool to: checking, downloading,
    /// and how it ended. Outside the state's lock, on the thread of the check.
    pub fn observe(&self, observer: impl Fn(&ToolStatus) + Send + Sync + 'static) {
        *lock(&self.observer) = Some(Arc::new(observer));
    }

    /// Tells the observer `status`. One that panics is logged and does not stop the check.
    fn tell(&self, status: &ToolStatus) {
        let observer = lock(&self.observer).clone();
        if let Some(observer) = observer
            && panic::catch_unwind(AssertUnwindSafe(|| observer(status))).is_err()
        {
            tracing::error!("telling the state of {} panicked", status.tool);
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // Every change of the state is made in one step, so a panic elsewhere leaves it whole.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Where the tool is: only one that a check put in place (verified) and that is still there,
    /// and for Deno only one yt-dlp can use, 2.3.0 or newer ([`run::deno_supported`], plan
    /// decision 20). An older Deno, or one whose version cannot be read, is as good as missing,
    /// and its state says why ([`ToolState::Failed`]).
    pub fn path(&self, tool: ToolId) -> Option<PathBuf> {
        let state = self.lock();
        let record = state.file.tools.get(&tool);
        (self.installed(tool, record) && unusable(tool, record).is_none()).then(|| self.exe(tool))
    }

    /// How often `tool` was put in place in this run of Kaleido: the service tells mpv's
    /// `ytdl_hook` to look for a yt-dlp put in place anew ([`mpv::hook_commands_for_core`]).
    pub fn installs(&self, tool: ToolId) -> u64 {
        self.lock().installs.get(&tool).copied().unwrap_or(0)
    }

    /// Asks a tool that is in place but whose version is not known (its `--version` did not
    /// answer, [`ToolError::Silent`]) again, without the network: the scheduler does at every
    /// round. Once it answers, its failure is over. Whether the version is known now. Runs the
    /// tool: not for the main thread.
    pub fn inspect_again(&self, tool: ToolId) -> bool {
        let sha256 = {
            let state = self.lock();
            let record = state.file.tools.get(&tool);
            if state.running.contains_key(&tool)
                || !self.installed(tool, record)
                || record.is_some_and(|record| record.version.is_some())
            {
                return false;
            }
            record.map(|record| record.sha256.clone())
        };
        let Some(version) = self.inspect.version(tool, &self.exe(tool)) else {
            return false;
        };
        let status = {
            let mut state = self.lock();
            // A check that ran meanwhile read the version itself, of what it put in place.
            if state.running.contains_key(&tool) {
                return false;
            }
            let Some(record) = state.file.tools.get_mut(&tool).filter(|record| {
                Some(&record.sha256) == sha256.as_ref() && record.version.is_none()
            }) else {
                return false;
            };
            record.version = Some(version);
            record.failures = 0;
            record.next_try = None;
            state.errors.remove(&tool);
            if let Err(error) = state.file.save(self.dir.join(store::FILE)) {
                tracing::error!("cannot save the tools' tools.json: {error}");
            }
            self.status_in(&state, tool)
        };
        tracing::info!("{tool} says its version now");
        self.tell(&status);
        true
    }

    /// The tool's state now.
    pub fn status(&self, tool: ToolId) -> ToolStatus {
        self.status_in(&self.lock(), tool)
    }

    /// Checks `tool` (see the module) from `channel` (yt-dlp's; Deno ignores it) and returns its
    /// state after. Without `force`, only when it is due ([`next_due`](Tools::next_due) is now: by
    /// the schedule, at once for a missing tool or a yt-dlp from the other channel, but never
    /// while a failed check backs off); otherwise it returns the state as it is. With `force` (the
    /// user asked, or a link needs a newer yt-dlp) also when not due. A check of a tool that
    /// already runs waits for that one and returns its result (or that of a later one that ended
    /// first), whatever `force` says. Blocks for as long as the downloads take: not for the main
    /// thread.
    pub fn check(
        &self,
        tool: ToolId,
        channel: Channel,
        force: bool,
    ) -> Result<ToolStatus, ToolError> {
        let (run, record, started) = {
            let mut state = self.lock();
            if let Some(running) = state.running.get(&tool) {
                let run = running.run;
                count_waiting(&mut state, true);
                let mut state = self
                    .finished
                    // Run numbers only grow: a later check that started and ended before this
                    // one got the lock again ends the wait too, and its result is the newest.
                    .wait_while(state, |state| {
                        !state
                            .results
                            .get(&tool)
                            .is_some_and(|(done, _)| *done >= run)
                    })
                    .unwrap_or_else(PoisonError::into_inner);
                count_waiting(&mut state, false);
                return state.results[&tool].1.clone();
            }
            let record = state.file.tools.get(&tool).cloned();
            if !force
                && self
                    .next_due_of(tool, channel, record.as_ref(), OffsetDateTime::now_utc())
                    .is_some()
            {
                return Ok(self.status_in(&state, tool));
            }
            state.runs += 1;
            let run = state.runs;
            state.running.insert(
                tool,
                Running {
                    run,
                    phase: ToolState::Checking,
                },
            );
            (run, record, self.status_in(&state, tool))
        };
        self.tell(&started);

        let (record, result) = panic::catch_unwind(AssertUnwindSafe(|| {
            self.run(tool, channel, record.clone(), force)
        }))
        .unwrap_or_else(|_| {
            tracing::error!("the check of {tool} panicked");
            (
                failed(record, OffsetDateTime::now_utc()),
                Err(ToolError::Io("the check stopped unexpectedly".to_owned())),
            )
        });

        let mut state = self.lock();
        state.file.tools.insert(tool, record);
        if let Err(error) = state.file.save(self.dir.join(store::FILE)) {
            // The tool is in place and verified; the next start checks it again.
            tracing::error!("cannot save the tools' tools.json: {error}");
        }
        match &result {
            Ok(()) => {
                state.errors.remove(&tool);
            }
            Err(error) => {
                tracing::warn!("the check of {tool} failed: {error}");
                state.errors.insert(tool, error.to_string());
            }
        }
        state.running.remove(&tool);
        let status = self.status_in(&state, tool);
        let result = result.map(|()| status.clone());
        state.results.insert(tool, (run, result.clone()));
        drop(state);
        self.finished.notify_all();
        self.tell(&status);
        result
    }

    /// Steps 1 to 5 of a check: the record the tool has after it, and how it went.
    fn run(
        &self,
        tool: ToolId,
        channel: Channel,
        record: Option<ToolRecord>,
        force: bool,
    ) -> (ToolRecord, Result<(), ToolError>) {
        let now = OffsetDateTime::now_utc();
        // The file of a tool that was in place is gone since (a virus scanner took it away after
        // the last check): one failure, and nothing downloaded this time, so that a scanner that
        // takes every copy away is not answered with a download at every round (Ruling R10). Once
        // per vanishing: the next check, after the backoff (it has a failure then) or forced,
        // downloads it again.
        if !force
            && let Some(found) = &record
            && found.is_installed()
            && found.failures == 0
            && !self.exe(tool).is_file()
        {
            tracing::warn!("{} is gone since it was put in place", tool.exe_name());
            return (
                gone(found.clone(), Some(found), now),
                Err(ToolError::Gone(tool)),
            );
        }
        // Found in place at the start: a streak of vanishings is over.
        let in_place = self.installed(tool, record.as_ref());
        let source = source(tool, channel);
        let mut record = record;
        if !in_place && let Some(mut taken) = self.take_bundled(tool, &source) {
            // The copy is in place now. What the earlier attempts left stays with it: the failures
            // in a row and the vanishings, the basis of the backoff of whatever fails next (a
            // scanner that takes every copy away keeps waiting longer), and the last check that
            // went through.
            if let Some(previous) = &record {
                taken.failures = previous.failures;
                taken.vanished = previous.vanished;
                taken.checked_at = previous.checked_at.clone();
            }
            record = Some(taken);
        }
        match self.update(tool, channel, &source, record.as_ref()) {
            Ok(mut updated) => {
                updated.vanished = if in_place {
                    0
                } else {
                    record.as_ref().map_or(0, |record| record.vanished)
                };
                match self.unusable_after(tool, &updated) {
                    None => (updated, Ok(())),
                    // In place, but gone or silent: a failure like any other, which backs off (1
                    // min, 5 min, 30 min, 2 h). The record keeps what was put in place, and the
                    // last check that went through.
                    Some(error) => {
                        let mut after = if matches!(error, ToolError::Gone(_)) {
                            gone(updated, record.as_ref(), now)
                        } else {
                            let (failures, next) = schedule::after_failure(record.as_ref(), now);
                            ToolRecord {
                                failures,
                                next_try: Some(stamp(next)),
                                ..updated
                            }
                        };
                        after.checked_at = record.and_then(|record| record.checked_at);
                        (after, Err(error))
                    }
                }
            }
            Err(error) => (failed(record, now), Err(error)),
        }
    }

    /// Why the tool of `record`, which a check has just put in place or found there, cannot be
    /// used: its file is gone, or it did not say its version.
    fn unusable_after(&self, tool: ToolId, record: &ToolRecord) -> Option<ToolError> {
        if !self.exe(tool).is_file() {
            Some(ToolError::Gone(tool))
        } else if record.version.is_none() {
            Some(ToolError::Silent(tool))
        } else {
            None
        }
    }

    /// Steps 2 to 4: the release's checksum, and the download when it is a new one.
    fn update(
        &self,
        tool: ToolId,
        channel: Channel,
        source: &Source,
        record: Option<&ToolRecord>,
    ) -> Result<ToolRecord, ToolError> {
        let sums = self.fetch.get(&source.sums_url(), SUMS_LIMIT)?;
        let sums = String::from_utf8_lossy(&sums);
        let expected = match tool {
            ToolId::YtDlp => checksum::from_sums(&sums, source.asset),
            ToolId::Deno => checksum::first_hex(&sums),
        }
        .ok_or(ToolError::NoChecksum)?;
        let exe = self.exe(tool);
        let channel = channel_of(tool, channel);

        if let Some(record) = record
            && self.installed(tool, Some(record))
            && record.sha256.eq_ignore_ascii_case(&expected)
        {
            let mut checked = record.clone();
            checked.checked_at = Some(stamp(OffsetDateTime::now_utc()));
            checked.failures = 0;
            checked.next_try = None;
            checked.channel = channel;
            if checked.version.is_none() {
                checked.version = self.inspect.version(tool, &exe);
            }
            return Ok(checked);
        }

        self.set_phase(tool, ToolState::Downloading);
        let bytes = self.fetch.get(&source.asset_url(), tool.limit())?;
        let actual = checksum::sha256_hex(&bytes);
        if actual != expected {
            return Err(ToolError::Checksum { expected, actual });
        }
        self.install(tool, &bytes)?;
        let now = stamp(OffsetDateTime::now_utc());
        Ok(ToolRecord {
            version: self.inspect.version(tool, &exe),
            sha256: expected,
            channel,
            installed_at: now.clone(),
            checked_at: Some(now),
            failures: 0,
            next_try: None,
            // `run` carries the vanishings over.
            vanished: 0,
        })
    }

    /// Step 1: the installation's copy of a missing tool (plan decision 7), the release asset under
    /// its own name in `resource_dir\tools\`, with its record in the `tools.json` there. Taken only
    /// when its SHA-256 is the one that record names; the record it gets is that one's, installed
    /// now and not yet checked. `None` when there is no such copy or it cannot be put in place,
    /// and the check goes on to the release.
    fn take_bundled(&self, tool: ToolId, source: &Source) -> Option<ToolRecord> {
        let file = ToolsFile::read(self.bundled.join(store::FILE))?;
        let bundled = file.tools.get(&tool)?;
        let path = self.bundled.join(source.asset);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!("cannot read the bundled {}: {error}", path.display());
                return None;
            }
        };
        let actual = checksum::sha256_hex(&bytes);
        if !bundled.sha256.eq_ignore_ascii_case(&actual) {
            tracing::warn!(
                "the bundled {} is not the one its tools.json names; it is not used",
                path.display()
            );
            return None;
        }
        if let Err(error) = self.install(tool, &bytes) {
            tracing::warn!("cannot put the bundled {tool} in place: {error}");
            return None;
        }
        Some(ToolRecord {
            version: self
                .inspect
                .version(tool, &self.exe(tool))
                .or_else(|| bundled.version.clone()),
            sha256: actual,
            channel: match tool {
                ToolId::YtDlp => Some(bundled.channel.unwrap_or_default()),
                ToolId::Deno => None,
            },
            installed_at: stamp(OffsetDateTime::now_utc()),
            checked_at: None,
            failures: 0,
            next_try: None,
            vanished: 0,
        })
    }

    /// Puts the verified release asset of `tool` in place: `yt-dlp.exe` as it is, `deno.exe` out
    /// of its zip.
    fn install(&self, tool: ToolId, asset: &[u8]) -> Result<(), ToolError> {
        let unpacked;
        let exe = match tool {
            ToolId::YtDlp => asset,
            ToolId::Deno => {
                unpacked = deno_from_zip(asset)?;
                &unpacked
            }
        };
        // What earlier replaces of this tool left, now that it may be done with. Only this
        // tool's: a replace of the other one may need its old file back.
        replace::sweep_of(&self.dir, tool.exe_name());
        fs::create_dir_all(&self.dir)
            .and_then(|()| replace::replace_binary(&self.dir, tool.exe_name(), exe))
            .map_err(|error| {
                ToolError::Io(format!("cannot put {} in place: {error}", tool.exe_name()))
            })?;
        *self.lock().installs.entry(tool).or_default() += 1;
        Ok(())
    }

    fn set_phase(&self, tool: ToolId, phase: ToolState) {
        let status = {
            let mut state = self.lock();
            let Some(running) = state.running.get_mut(&tool) else {
                return;
            };
            running.phase = phase;
            self.status_in(&state, tool)
        };
        self.tell(&status);
    }

    fn exe(&self, tool: ToolId) -> PathBuf {
        self.dir.join(tool.exe_name())
    }

    /// Whether a check put the tool in place and it is still there.
    fn installed(&self, tool: ToolId, record: Option<&ToolRecord>) -> bool {
        record.is_some_and(ToolRecord::is_installed) && self.exe(tool).is_file()
    }

    /// When a check of `tool` from `channel` that is not forced is due, seen at `now`; `None` when
    /// it is due now (see [`Tools::check`]). What a scheduler waits for: the backoff after a
    /// failure (1 min, 5 min, 30 min, 2 h) as much as the tool's interval.
    pub fn next_due(
        &self,
        tool: ToolId,
        channel: Channel,
        now: OffsetDateTime,
    ) -> Option<OffsetDateTime> {
        let state = self.lock();
        self.next_due_of(tool, channel, state.file.tools.get(&tool), now)
    }

    /// [`next_due`](Tools::next_due) for `record`:
    /// - a tool that is there and says its version: by the schedule ([`schedule::next_due`]); a
    ///   yt-dlp from another channel than `channel` (the user switched) is due at once, unless a
    ///   failed check still backs off, so that a failing switch is not tried again and again;
    /// - a tool that is not there, or does not say its version: at once, unless its last attempt
    ///   still backs off. A check that is not forced and finds an installed record, no failure in
    ///   a row and the file missing then fails once ([`ToolError::Gone`]) without putting anything
    ///   in place, and backs off.
    fn next_due_of(
        &self,
        tool: ToolId,
        channel: Channel,
        record: Option<&ToolRecord>,
        now: OffsetDateTime,
    ) -> Option<OffsetDateTime> {
        let switched =
            tool == ToolId::YtDlp && record.is_some_and(|record| record.channel != Some(channel));
        let speaks = record.is_some_and(|record| record.version.is_some());
        if self.installed(tool, record) && speaks && !switched {
            schedule::next_due(record, now, tool.interval())
        } else {
            schedule::retry_at(record, now)
        }
    }

    fn status_in(&self, state: &State, tool: ToolId) -> ToolStatus {
        let record = state.file.tools.get(&tool);
        let installed = self.installed(tool, record);
        let mut phase = if let Some(running) = state.running.get(&tool) {
            running.phase
        } else if record.is_some_and(|record| record.failures > 0) {
            ToolState::Failed
        } else if installed {
            ToolState::Ready
        } else {
            ToolState::Missing
        };
        let mut error = if phase == ToolState::Failed {
            state.errors.get(&tool).cloned()
        } else {
            None
        };
        // A Deno that yt-dlp cannot use is there, but not ready (plan decision 20).
        if phase == ToolState::Ready
            && let Some(reason) = unusable(tool, record)
        {
            phase = ToolState::Failed;
            error = Some(reason);
        }
        ToolStatus {
            tool,
            state: phase,
            version: record
                .filter(|_| installed)
                .and_then(|record| record.version.clone()),
            checked_at: record.and_then(|record| record.checked_at.clone()),
            error,
        }
    }

    /// The checks that wait for another one to end.
    #[cfg(test)]
    fn waiting(&self) -> usize {
        self.lock().waiting
    }
}

/// Counts a check that starts or stops waiting for another one, for the tests to see.
#[cfg(test)]
fn count_waiting(state: &mut State, starts: bool) {
    if starts {
        state.waiting += 1;
    } else {
        state.waiting -= 1;
    }
}

#[cfg(not(test))]
fn count_waiting(_: &mut State, _: bool) {}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // What these hold is replaced in one step, so a panic elsewhere leaves it whole.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Why the installed tool of `record` cannot be used, if it cannot: a Deno older than 2.3.0, or
/// one whose version cannot be read (plan decision 20). yt-dlp has no such limit.
fn unusable(tool: ToolId, record: Option<&ToolRecord>) -> Option<String> {
    if tool != ToolId::Deno {
        return None;
    }
    match record.and_then(|record| record.version.as_deref()) {
        Some(version) if run::deno_supported(version) => None,
        Some(version) => Some(format!(
            "Deno {version} is too old ({} or newer is needed)",
            run::DENO_MINIMUM_TEXT
        )),
        None => Some(format!(
            "the version of Deno cannot be read ({} or newer is needed)",
            run::DENO_MINIMUM_TEXT
        )),
    }
}

/// The channel a tool's record keeps: yt-dlp's, and none for Deno.
fn channel_of(tool: ToolId, channel: Channel) -> Option<Channel> {
    (tool == ToolId::YtDlp).then_some(channel)
}

/// `record` once its file was found gone at `now` (Ruling R10), `previous` the record before the
/// check: one more failure, and one more vanishing. Its backoff counts the vanishings in a row
/// too, so that it climbs although the downloads that put the file back in between went through
/// and ended the failures: a scanner that takes every copy away gets one download per 1 min,
/// 5 min, 30 min, then 2 h.
fn gone(mut record: ToolRecord, previous: Option<&ToolRecord>, now: OffsetDateTime) -> ToolRecord {
    let basis = ToolRecord {
        failures: previous.map_or(0, |previous| previous.failures.max(previous.vanished)),
        ..ToolRecord::not_installed()
    };
    let (failures, next) = schedule::after_failure(Some(&basis), now);
    record.failures = failures;
    record.next_try = Some(stamp(next));
    record.vanished = previous
        .map_or(0, |previous| previous.vanished)
        .saturating_add(1);
    record
}

/// `record` (a never-installed one when there is none) after one more failed check at `now`.
fn failed(record: Option<ToolRecord>, now: OffsetDateTime) -> ToolRecord {
    let mut record = record.unwrap_or_else(ToolRecord::not_installed);
    let (failures, next) = schedule::after_failure(Some(&record), now);
    record.failures = failures;
    record.next_try = Some(stamp(next));
    record
}

// ---------------------------------------------------------------------------------------------
// The service: the scheduler, and what the app hears

/// The shortest sleep of the scheduler between two rounds, unless something wakes it: a tool
/// that stays due after its check (a file that vanishes as soon as it is in place) is not checked
/// over and over.
pub const SCHEDULER_MIN_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
/// The longest: a clock that jumps (a laptop that slept) is noticed within it.
pub const SCHEDULER_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(60 * 60);
/// Added to the sleep, so that the scheduler wakes when a check is due and not just before.
const SCHEDULER_SLACK: std::time::Duration = std::time::Duration::from_secs(1);

/// What the app does for the tools' [`Service`] (lib.rs: the settings, the UI and the player).
pub trait Host: Send + Sync + 'static {
    /// yt-dlp's release channel, as the settings say now.
    fn channel(&self) -> Channel;
    /// The browser whose cookies yt-dlp takes, as the settings say now: `BROWSER[:PROFILE]`
    /// (`playback.cookiesFromBrowser`), `None` for none. Reads the settings only.
    fn cookies(&self) -> Option<String>;
    /// A tool's state changed (`tools:status`). On the thread of the check.
    fn status(&self, status: &ToolStatus);
    /// Commands for the running core, as the tools' options changed ([`mpv`]). Must not wait for
    /// the core.
    fn send(&self, commands: Vec<Vec<String>>);
}

/// The managed tools with their scheduler (spec 6.6): one thread that checks what is due, at once
/// when it starts (a missing tool is downloaded at the first start, plan decision 7), then
/// whenever the next check is due ([`Tools::next_due`]: the daily and weekly intervals, the
/// backoff after a failure, a switch of yt-dlp's channel at once), sleeping in between
/// ([`scheduler_wait`]). A switch of the channel and a forced check wake it, so that it looks at
/// once.
///
/// After every check the running core gets what changed of the tools' options
/// ([`Host::send`]): the managed yt-dlp once it is there, Deno once it came, was replaced by one
/// at another place, or went, and the cookies of a browser when the user chooses another one
/// ([`Service::cookies_changed`]). A new core gets them all ([`Service::options_for_new_core`]).
pub struct Service {
    shared: Arc<Shared>,
    scheduler: Mutex<Option<thread::JoinHandle<()>>>,
}

struct Shared {
    tools: Tools,
    host: Arc<dyn Host>,
    paths: AppPaths,
    sent: Mutex<Sent>,
    wake: Mutex<Wake>,
    woken: Condvar,
}

/// What the running core has of the tools.
#[derive(Default)]
struct Sent {
    /// The tools' options: those of its start, and every change since.
    commands: Vec<Vec<String>>,
    /// yt-dlp's [`Tools::installs`] when the core last heard of it.
    installs: u64,
}

#[derive(Default)]
struct Wake {
    /// Something asks the scheduler to look now.
    woken: bool,
    /// The service is dropped.
    stop: bool,
}

impl Service {
    /// The service over `tools`: from now on `host` hears every state they move to. The scheduler
    /// waits for [`start`](Service::start).
    pub fn new(tools: Tools, paths: &AppPaths, host: Arc<dyn Host>) -> Service {
        let told = Arc::clone(&host);
        tools.observe(move |status| told.status(status));
        Service {
            shared: Arc::new(Shared {
                tools,
                host,
                paths: paths.clone(),
                sent: Mutex::new(Sent::default()),
                wake: Mutex::new(Wake::default()),
                woken: Condvar::new(),
            }),
            scheduler: Mutex::new(None),
        }
    }

    /// Starts the scheduler, which checks what is due at once. Once the player runs, so that what
    /// a check changes reaches it; a second call does nothing.
    pub fn start(&self) {
        let mut scheduler = lock(&self.scheduler);
        if scheduler.is_some() {
            return;
        }
        let shared = Arc::clone(&self.shared);
        match thread::Builder::new()
            .name("tools-scheduler".to_owned())
            .spawn(move || shared.schedule())
        {
            Ok(handle) => *scheduler = Some(handle),
            Err(error) => tracing::error!("the tools are not checked on their own: {error}"),
        }
    }

    pub fn tools(&self) -> &Tools {
        &self.shared.tools
    }

    /// Every tool's state, in the order the UI lists them ([`ToolId::ALL`]).
    pub fn statuses(&self) -> Vec<ToolStatus> {
        ToolId::ALL
            .map(|tool| self.shared.tools.status(tool))
            .to_vec()
    }

    /// Checks `tool` now, due or not ("Zkontrolovat", or a link that needs a newer yt-dlp), from
    /// the channel of the settings, and returns its state after; a check that runs already is
    /// waited for. Blocks for as long as the downloads take: not for the main thread.
    pub fn check_now(&self, tool: ToolId) -> ToolStatus {
        self.check_from_settings(tool, true)
    }

    /// Checks `tool` if it is due, as the scheduler would now, from the channel of the settings,
    /// and returns its state after; a check that runs already is waited for. For a link that
    /// failed because yt-dlp is missing or out of date, when a forced check is not wanted
    /// (spec 6.6): a missing yt-dlp is due at once unless a failed attempt still backs off, and an
    /// installed one only by its schedule, so that a link that keeps failing does not ask the
    /// release over and over. Blocks for as long as the downloads take: not for the event thread.
    pub fn check_if_due(&self, tool: ToolId) -> ToolStatus {
        self.check_from_settings(tool, false)
    }

    /// [`Shared::check`] from the channel of the settings, then the scheduler looks again.
    fn check_from_settings(&self, tool: ToolId, force: bool) -> ToolStatus {
        let status = self.shared.check(tool, self.shared.host.channel(), force);
        // When the next check is due may be another time now (a failure backs off).
        self.shared.wake();
        status
    }

    /// The user chose the other channel for yt-dlp: the scheduler looks at once (a switch is due
    /// at once). Returns at once.
    pub fn channel_changed(&self) {
        self.shared.wake();
    }

    /// The user chose another browser for yt-dlp's cookies, or none (plan decision 13): the
    /// running core gets the new `ytdl-raw-options` right away, on the way every change of the
    /// tools' options goes ([`Host::send`]), so that what it was last sent stays right and the
    /// next core ([`Service::options_for_new_core`]) has the same. Returns at once: it looks at
    /// two files and queues the commands, and waits for no check and no core.
    pub fn cookies_changed(&self) {
        self.shared.refresh_core();
    }

    /// The tools' options for a core that has just started ([`mpv::hook_commands`],
    /// [`mpv::raw_options`]): right after the start of the player, before anything the UI sends,
    /// and in the `prepare` of a restart. From then on that core gets what changes.
    pub fn options_for_new_core(&self) -> Vec<Vec<String>> {
        let mut sent = lock(&self.shared.sent);
        let mut commands = mpv::hook_commands(&self.shared.paths);
        commands.extend(self.shared.raw_options());
        *sent = Sent {
            commands: commands.clone(),
            installs: self.shared.tools.installs(ToolId::YtDlp),
        };
        commands
    }
}

impl Drop for Service {
    /// Stops the scheduler once the check it runs is done (the tests; the app keeps its service
    /// until the process ends).
    fn drop(&mut self) {
        lock(&self.shared.wake).stop = true;
        self.shared.woken.notify_all();
        let scheduler = self
            .scheduler
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(scheduler) = scheduler
            && scheduler.join().is_err()
        {
            tracing::error!("the tools' scheduler panicked");
        }
    }
}

impl Shared {
    /// The scheduler's thread (see [`Service`]): round after round. A round that panics (the
    /// panic hook has logged it) is one round; the scheduler goes on after the shortest wait.
    fn schedule(&self) {
        loop {
            let wait =
                panic::catch_unwind(AssertUnwindSafe(|| self.round())).unwrap_or_else(|_| {
                    tracing::error!("a round of the tools' scheduler panicked; the next one comes");
                    Some(SCHEDULER_MIN_WAIT)
                });
            let Some(wait) = wait else {
                return;
            };
            if !self.sleep(wait) {
                return;
            }
        }
    }

    /// One round: a tool whose version is not known is asked again (without the network), what
    /// is due is checked, and the sleep until the next round comes back; `None` when the service
    /// is dropped.
    fn round(&self) -> Option<std::time::Duration> {
        for tool in ToolId::ALL {
            if self.tools.inspect_again(tool) {
                // A Deno that says its version now is one yt-dlp may get.
                self.refresh_core();
            }
        }
        let channel = self.host.channel();
        for tool in ToolId::ALL {
            if lock(&self.wake).stop {
                return None;
            }
            if self
                .tools
                .next_due(tool, channel, OffsetDateTime::now_utc())
                .is_none()
            {
                self.check(tool, channel, false);
            }
        }
        let now = OffsetDateTime::now_utc();
        let channel = self.host.channel();
        let next = ToolId::ALL.map(|tool| self.tools.next_due(tool, channel, now));
        Some(scheduler_wait(&next, now))
    }

    /// [`Tools::check`], then the running core hears what changed of the tools' options. The
    /// state after, a failed one too.
    fn check(&self, tool: ToolId, channel: Channel, force: bool) -> ToolStatus {
        let result = self.tools.check(tool, channel, force);
        self.refresh_core();
        result.unwrap_or_else(|_| self.tools.status(tool))
    }

    /// Kaleido's `ytdl-raw-options` as they are now: Deno when yt-dlp can use it, and the browser
    /// whose cookies the settings name.
    fn raw_options(&self) -> Vec<Vec<String>> {
        mpv::raw_options(
            self.tools.path(ToolId::Deno).as_deref(),
            self.host.cookies().as_deref(),
        )
    }

    /// Sends the running core the options that changed since it got them last, and makes its
    /// `ytdl_hook` look again for a yt-dlp put in place since ([`mpv::hook_commands_for_core`]).
    fn refresh_core(&self) {
        // Held while sending, so that two checks that end at once reach the core in the order
        // they were recorded in, and an install makes the hook look again once.
        let mut sent = lock(&self.sent);
        let installs = self.tools.installs(ToolId::YtDlp);
        let mut options =
            mpv::hook_commands_for_core(&self.paths, &sent.commands, installs != sent.installs);
        options.extend(self.raw_options());
        let changed: Vec<Vec<String>> = options
            .iter()
            .filter(|command| !sent.commands.contains(command))
            .cloned()
            .collect();
        *sent = Sent {
            commands: options,
            installs,
        };
        if !changed.is_empty() {
            self.host.send(changed);
        }
    }

    fn wake(&self) {
        lock(&self.wake).woken = true;
        self.woken.notify_all();
    }

    /// Sleeps for `wait`, or until something wakes the scheduler; false when it is to stop.
    fn sleep(&self, wait: std::time::Duration) -> bool {
        let wake = lock(&self.wake);
        let (mut wake, _) = self
            .woken
            .wait_timeout_while(wake, wait, |wake| !wake.woken && !wake.stop)
            .unwrap_or_else(PoisonError::into_inner);
        wake.woken = false;
        !wake.stop
    }
}

/// How long the scheduler sleeps at `now` when the tools' next checks are due at `next` (`None`:
/// now, i.e. still due after the round that checked it): until the soonest, a second more, but
/// at least [`SCHEDULER_MIN_WAIT`] and at most [`SCHEDULER_MAX_WAIT`].
pub fn scheduler_wait(next: &[Option<OffsetDateTime>], now: OffsetDateTime) -> std::time::Duration {
    let soonest = next
        .iter()
        .map(|due| due.map_or(Duration::ZERO, |at| at - now))
        .min()
        .unwrap_or(Duration::MAX);
    // A time already past is no time at all.
    std::time::Duration::try_from(soonest)
        .unwrap_or_default()
        .saturating_add(SCHEDULER_SLACK)
        .clamp(SCHEDULER_MIN_WAIT, SCHEDULER_MAX_WAIT)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io::Write;
    use std::thread;
    use std::time::Instant;

    use super::*;
    use crate::player::testing::temp_paths;
    use crate::tools::checksum::sha256_hex;
    use crate::tools::store::parse_time;

    /// Answers by address: bytes or an error, 404 for what it does not know. A GET of the
    /// address it holds waits until it is released.
    #[derive(Default)]
    struct FakeWeb {
        answers: Mutex<HashMap<String, Result<Vec<u8>, FetchError>>>,
        calls: Mutex<Vec<String>>,
        held: Mutex<Option<String>>,
        released: Condvar,
    }

    impl FakeWeb {
        fn answer(&self, url: &str, answer: Result<Vec<u8>, FetchError>) {
            self.answers.lock().unwrap().insert(url.to_owned(), answer);
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn count(&self, url: &str) -> usize {
            self.calls().iter().filter(|call| *call == url).count()
        }

        fn hold(&self, url: &str) {
            *self.held.lock().unwrap() = Some(url.to_owned());
        }

        fn release(&self) {
            *self.held.lock().unwrap() = None;
            self.released.notify_all();
        }
    }

    impl Fetch for FakeWeb {
        fn get(&self, url: &str, limit: u64) -> Result<Vec<u8>, FetchError> {
            self.calls.lock().unwrap().push(url.to_owned());
            let mut held = self.held.lock().unwrap();
            while held.as_deref() == Some(url) {
                held = self.released.wait(held).unwrap();
            }
            drop(held);
            let answer = self.answers.lock().unwrap().get(url).cloned();
            match answer.unwrap_or(Err(FetchError::Status(404))) {
                Ok(bytes) if bytes.len() as u64 > limit => Err(FetchError::TooLarge),
                answer => answer,
            }
        }
    }

    /// Says the version it is told for each tool, and remembers which files it was asked about.
    /// For the tools it is told to, it then deletes the file, as a virus scanner that quarantines
    /// what it saw run.
    #[derive(Default)]
    struct FakeInspect {
        versions: Mutex<BTreeMap<ToolId, String>>,
        asked: Mutex<Vec<(ToolId, PathBuf, Vec<u8>)>>,
        quarantines: Mutex<Vec<ToolId>>,
    }

    impl FakeInspect {
        fn says(&self, tool: ToolId, version: &str) {
            self.versions
                .lock()
                .unwrap()
                .insert(tool, version.to_owned());
        }

        fn quarantines(&self, tool: ToolId, on: bool) {
            let mut quarantines = self.quarantines.lock().unwrap();
            quarantines.retain(|&other| other != tool);
            if on {
                quarantines.push(tool);
            }
        }

        fn asked(&self) -> Vec<(ToolId, PathBuf, Vec<u8>)> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl Inspect for FakeInspect {
        fn version(&self, tool: ToolId, exe: &Path) -> Option<String> {
            // What it runs is what is in place by then.
            let bytes = fs::read(exe).unwrap_or_default();
            self.asked
                .lock()
                .unwrap()
                .push((tool, exe.to_path_buf(), bytes));
            if self.quarantines.lock().unwrap().contains(&tool) {
                fs::remove_file(exe).unwrap();
            }
            self.versions.lock().unwrap().get(&tool).cloned()
        }
    }

    struct Setup {
        _tmp: tempfile::TempDir,
        paths: AppPaths,
        web: Arc<FakeWeb>,
        inspect: Arc<FakeInspect>,
    }

    impl Setup {
        fn new() -> Setup {
            let tmp = tempfile::tempdir().unwrap();
            let paths = temp_paths(tmp.path());
            Setup {
                _tmp: tmp,
                paths,
                web: Arc::default(),
                inspect: Arc::default(),
            }
        }

        /// The service as a start of Kaleido makes it, from what is on the disk now.
        fn tools(&self) -> Tools {
            Tools::new(&self.paths, self.web.clone(), self.inspect.clone())
        }

        fn exe(&self, tool: ToolId) -> PathBuf {
            self.paths.tools_dir.join(tool.exe_name())
        }

        fn record(&self, tool: ToolId) -> Option<ToolRecord> {
            ToolsFile::load(self.paths.tools_dir.join(store::FILE))
                .tools
                .get(&tool)
                .cloned()
        }

        /// The names in the tools folder, sorted.
        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.paths.tools_dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            names
        }

        /// A tool a check installed earlier: its file and its record.
        fn installed(&self, tool: ToolId, bytes: &[u8], record: ToolRecord) {
            fs::write(self.exe(tool), bytes).unwrap();
            let path = self.paths.tools_dir.join(store::FILE);
            let mut file = ToolsFile::load(&path);
            file.tools.insert(tool, record);
            file.save(&path).unwrap();
        }

        /// The release of yt-dlp in `channel` lists `listed` as `yt-dlp.exe`'s checksum and
        /// serves `exe`.
        fn release(&self, channel: Channel, listed: &str, exe: &[u8]) {
            let source = source(ToolId::YtDlp, channel);
            self.web.answer(&source.sums_url(), Ok(sums(listed)));
            self.web.answer(&source.asset_url(), Ok(exe.to_vec()));
        }
    }

    /// A `SHA2-256SUMS` as yt-dlp's releases have it, with `exe` as `yt-dlp.exe`'s checksum.
    fn sums(exe: &str) -> Vec<u8> {
        format!(
            "{}  yt-dlp\n{exe}  yt-dlp.exe\n{}  yt-dlp_x86.exe\n",
            sha256_hex(b"the zipapp"),
            sha256_hex(b"the 32-bit one"),
        )
        .into_bytes()
    }

    /// A record of a tool installed (and last checked) at `at`.
    fn record(bytes: &[u8], version: &str, at: &str) -> ToolRecord {
        ToolRecord {
            version: Some(version.to_owned()),
            sha256: sha256_hex(bytes),
            channel: Some(Channel::Stable),
            installed_at: at.to_owned(),
            checked_at: Some(at.to_owned()),
            failures: 0,
            next_try: None,
            vanished: 0,
        }
    }

    /// The time now, to the second, as the records have it.
    fn now() -> OffsetDateTime {
        let now = OffsetDateTime::now_utc();
        now.replace_nanosecond(0).unwrap_or(now)
    }

    fn time_of(stamp: &Option<String>) -> OffsetDateTime {
        parse_time(stamp.as_deref().expect("a time")).expect("RFC 3339")
    }

    /// A zip with `deno.exe` (when given) and a readme, deflated as Deno's release is.
    fn zip_of(deno: Option<&[u8]>) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        let options = || {
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
        };
        if let Some(deno) = deno {
            zip.start_file("deno.exe", options()).unwrap();
            zip.write_all(deno).unwrap();
        }
        zip.start_file("README.md", options()).unwrap();
        zip.write_all(b"# Deno\n").unwrap();
        zip.finish().unwrap().into_inner()
    }

    /// Deno's `.zip.sha256sum` for `zip`: PowerShell's Get-FileHash, as v2.9.7 has it.
    fn deno_sums(zip: &[u8]) -> Vec<u8> {
        format!(
            "\r\nAlgorithm : SHA256\r\nHash      : {}\r\nPath      : C:\\a\\deno\\deno\\target\\release\\deno-x86_64-pc-windows-msvc.zip\r\n\r\n",
            sha256_hex(zip).to_uppercase()
        )
        .into_bytes()
    }

    /// Waits up to five seconds for `done`.
    fn eventually(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn a_missing_tool_is_downloaded_verified_and_recorded() {
        let setup = Setup::new();
        let exe = b"yt-dlp 2026.08.19";
        setup.release(Channel::Stable, &sha256_hex(exe), exe);
        setup.inspect.says(ToolId::YtDlp, "2026.08.19");
        let tools = setup.tools();
        let missing = tools.status(ToolId::YtDlp);
        assert_eq!(missing.state, ToolState::Missing);
        assert_eq!(missing.version, None);
        assert_eq!(tools.path(ToolId::YtDlp), None);

        let before = now();
        let status = tools.check(ToolId::YtDlp, Channel::Stable, false).unwrap();

        assert_eq!(status.tool, ToolId::YtDlp);
        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(status.version.as_deref(), Some("2026.08.19"));
        assert_eq!(status.error, None);
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);
        assert_eq!(tools.path(ToolId::YtDlp), Some(setup.exe(ToolId::YtDlp)));
        let source = source(ToolId::YtDlp, Channel::Stable);
        assert_eq!(setup.web.calls(), [source.sums_url(), source.asset_url()]);
        // The version is read from the file in place, once it is there.
        assert_eq!(
            setup.inspect.asked(),
            [(ToolId::YtDlp, setup.exe(ToolId::YtDlp), exe.to_vec())]
        );
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.sha256, sha256_hex(exe));
        assert_eq!(recorded.version.as_deref(), Some("2026.08.19"));
        assert_eq!(recorded.channel, Some(Channel::Stable));
        assert_eq!(
            recorded.checked_at.as_deref(),
            Some(&*recorded.installed_at)
        );
        assert!(time_of(&recorded.checked_at) >= before);
        assert_eq!(status.checked_at, recorded.checked_at);
        assert_eq!((recorded.failures, recorded.next_try), (0, None));
        assert_eq!(setup.names(), ["tools.json", "yt-dlp.exe"]);
        // Deno is a tool of its own: still missing.
        assert_eq!(tools.status(ToolId::Deno).state, ToolState::Missing);

        // The next start knows it.
        let again = setup.tools();
        assert_eq!(again.status(ToolId::YtDlp), status);
        assert_eq!(again.path(ToolId::YtDlp), Some(setup.exe(ToolId::YtDlp)));
        // A file that is gone is not a tool, whatever the record says.
        fs::remove_file(setup.exe(ToolId::YtDlp)).unwrap();
        assert_eq!(again.path(ToolId::YtDlp), None);
        assert_eq!(again.status(ToolId::YtDlp).state, ToolState::Missing);
        assert_eq!(again.status(ToolId::YtDlp).version, None);
    }

    #[test]
    fn the_same_checksum_downloads_nothing() {
        let setup = Setup::new();
        let exe = b"yt-dlp 2026.08.19";
        let old = record(exe, "2026.08.19", "2026-10-01T00:00:00Z");
        setup.installed(ToolId::YtDlp, exe, old.clone());
        setup.release(Channel::Stable, &sha256_hex(exe), b"never fetched");
        let tools = setup.tools();
        assert_eq!(tools.status(ToolId::YtDlp).state, ToolState::Ready);

        let before = now();
        // Not forced: due, as the last check is weeks old.
        let status = tools.check(ToolId::YtDlp, Channel::Stable, false).unwrap();

        assert_eq!(status.state, ToolState::Ready);
        let source = source(ToolId::YtDlp, Channel::Stable);
        assert_eq!(setup.web.calls(), [source.sums_url()]);
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);
        // Only the time of the check changed; the version was known, so nothing ran.
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert!(time_of(&recorded.checked_at) >= before);
        assert_eq!(
            recorded,
            ToolRecord {
                checked_at: recorded.checked_at.clone(),
                ..old
            }
        );
        assert!(setup.inspect.asked().is_empty());
        assert_eq!(setup.names(), ["tools.json", "yt-dlp.exe"]);

        // Checked just now: the next check that is not forced does nothing at all.
        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Stable, false),
            Ok(status.clone())
        );
        assert_eq!(setup.web.calls().len(), 1);
        // A forced one reads the checksums again, and still downloads nothing.
        tools.check(ToolId::YtDlp, Channel::Stable, true).unwrap();
        assert_eq!(setup.web.calls(), [source.sums_url(), source.sums_url()]);
    }

    #[test]
    fn a_new_checksum_replaces_the_tool() {
        let setup = Setup::new();
        let v1 = b"yt-dlp 2026.08.19";
        let v2 = b"yt-dlp 2026.10.10";
        setup.installed(
            ToolId::YtDlp,
            v1,
            record(v1, "2026.08.19", "2026-10-19T00:00:00Z"),
        );
        setup.release(Channel::Stable, &sha256_hex(v2), v2);
        setup.inspect.says(ToolId::YtDlp, "2026.10.10");
        let tools = setup.tools();

        let before = now();
        let status = tools.check(ToolId::YtDlp, Channel::Stable, true).unwrap();

        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(status.version.as_deref(), Some("2026.10.10"));
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), v2);
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.sha256, sha256_hex(v2));
        assert_eq!(recorded.version.as_deref(), Some("2026.10.10"));
        assert!(parse_time(&recorded.installed_at).unwrap() >= before);
        assert_eq!(
            setup.inspect.asked(),
            [(ToolId::YtDlp, setup.exe(ToolId::YtDlp), v2.to_vec())]
        );
        // Nothing runs the old one, so no old file and no new one are left.
        assert_eq!(setup.names(), ["tools.json", "yt-dlp.exe"]);
    }

    /// Review focus 3: a download that is not the file the release names is never put in place.
    #[test]
    fn a_checksum_mismatch_changes_nothing() {
        let setup = Setup::new();
        let v1 = b"yt-dlp 2026.08.19";
        let old = record(v1, "2026.08.19", "2026-10-01T00:00:00Z");
        setup.installed(ToolId::YtDlp, v1, old.clone());
        let listed = sha256_hex(b"yt-dlp 2026.10.10");
        setup.release(Channel::Stable, &listed, b"something else");
        let tools = setup.tools();

        let result = tools.check(ToolId::YtDlp, Channel::Stable, true);

        assert_eq!(
            result,
            Err(ToolError::Checksum {
                expected: listed,
                actual: sha256_hex(b"something else"),
            })
        );
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), v1);
        assert_eq!(setup.names(), ["tools.json", "yt-dlp.exe"]);
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.failures, 1);
        assert!(recorded.next_try.is_some());
        assert_eq!(
            recorded,
            ToolRecord {
                failures: 1,
                next_try: recorded.next_try.clone(),
                ..old
            }
        );
        assert!(setup.inspect.asked().is_empty(), "nothing new ran");
        // The old one is still the verified one, and is used.
        assert_eq!(tools.path(ToolId::YtDlp), Some(setup.exe(ToolId::YtDlp)));
        let status = tools.status(ToolId::YtDlp);
        assert_eq!(status.state, ToolState::Failed);
        assert_eq!(status.version.as_deref(), Some("2026.08.19"));
        assert!(status.error.unwrap().contains("SHA-256"));

        // A list without the asset is no checksum either.
        let source = source(ToolId::YtDlp, Channel::Stable);
        setup.web.answer(
            &source.sums_url(),
            Ok(format!("{}  yt-dlp_x86.exe\n", sha256_hex(b"x")).into_bytes()),
        );
        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Stable, true),
            Err(ToolError::NoChecksum)
        );
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), v1);
        assert_eq!(setup.record(ToolId::YtDlp).unwrap().failures, 2);
    }

    /// Review focus 3 and spec 10.7: offline, the tool stays as it is, and the next tries wait 60 s,
    /// then 300 s.
    #[test]
    fn offline_keeps_the_installed_tool_and_backs_off() {
        let setup = Setup::new();
        let v1 = b"yt-dlp 2026.08.19";
        setup.installed(
            ToolId::YtDlp,
            v1,
            record(v1, "2026.08.19", "2026-10-01T00:00:00Z"),
        );
        let source = source(ToolId::YtDlp, Channel::Stable);
        setup
            .web
            .answer(&source.sums_url(), Err(FetchError::Offline));
        let tools = setup.tools();

        let before = now();
        let result = tools.check(ToolId::YtDlp, Channel::Stable, false);
        let after = now();

        assert_eq!(result, Err(ToolError::Fetch(FetchError::Offline)));
        let status = tools.status(ToolId::YtDlp);
        assert_eq!(status.state, ToolState::Failed);
        assert_eq!(status.version.as_deref(), Some("2026.08.19"));
        assert_eq!(
            status.checked_at.as_deref(),
            Some("2026-10-01T00:00:00Z"),
            "a check that failed is not a check"
        );
        assert!(status.error.is_some());
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), v1);
        assert_eq!(tools.path(ToolId::YtDlp), Some(setup.exe(ToolId::YtDlp)));
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.failures, 1);
        let next = time_of(&recorded.next_try);
        assert!(
            before + Duration::seconds(60) <= next && next <= after + Duration::seconds(60),
            "{next}"
        );

        // While it backs off, a check that is not forced asks nothing.
        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Stable, false),
            Ok(status)
        );
        assert_eq!(setup.web.calls(), [source.sums_url()]);

        // A forced one tries, fails again, and the wait grows.
        let before = now();
        let result = tools.check(ToolId::YtDlp, Channel::Stable, true);
        let after = now();
        assert_eq!(result, Err(ToolError::Fetch(FetchError::Offline)));
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.failures, 2);
        let next = time_of(&recorded.next_try);
        assert!(
            before + Duration::seconds(300) <= next && next <= after + Duration::seconds(300),
            "{next}"
        );
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), v1);

        // Back online: the failures are over.
        setup.release(Channel::Stable, &sha256_hex(v1), b"never fetched");
        let status = tools.check(ToolId::YtDlp, Channel::Stable, true).unwrap();
        assert_eq!((status.state, status.error), (ToolState::Ready, None));
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!((recorded.failures, recorded.next_try), (0, None));

        // A tool that was never there backs off the same way, and stays missing.
        let deno = super::source(ToolId::Deno, Channel::Stable);
        setup.web.answer(&deno.sums_url(), Err(FetchError::Offline));
        assert_eq!(
            tools.check(ToolId::Deno, Channel::Stable, false),
            Err(ToolError::Fetch(FetchError::Offline))
        );
        assert_eq!(tools.path(ToolId::Deno), None);
        let status = tools.status(ToolId::Deno);
        assert_eq!((status.state, status.version), (ToolState::Failed, None));
        let recorded = setup.record(ToolId::Deno).unwrap();
        assert!(!recorded.is_installed());
        assert_eq!(recorded.failures, 1);
        let calls = setup.web.calls().len();
        tools.check(ToolId::Deno, Channel::Stable, false).unwrap();
        assert_eq!(setup.web.calls().len(), calls, "backing off");
        assert_eq!(setup.names(), ["tools.json", "yt-dlp.exe"]);
    }

    #[test]
    fn nightly_uses_the_nightly_repository() {
        let stable = source(ToolId::YtDlp, Channel::Stable);
        let nightly = source(ToolId::YtDlp, Channel::Nightly);
        assert_eq!(
            stable.sums_url(),
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS"
        );
        assert_eq!(
            stable.asset_url(),
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
        );
        assert_eq!(
            nightly.sums_url(),
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/SHA2-256SUMS"
        );
        assert_eq!(
            nightly.asset_url(),
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe"
        );
        // Deno has one channel.
        for channel in [Channel::Stable, Channel::Nightly] {
            let deno = source(ToolId::Deno, channel);
            assert_eq!(
                deno.asset_url(),
                "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip"
            );
            assert_eq!(
                deno.sums_url(),
                "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip.sha256sum"
            );
        }

        // A stable yt-dlp is replaced by the nightly one once the channel is nightly.
        let setup = Setup::new();
        let v1 = b"yt-dlp 2026.08.19";
        setup.installed(
            ToolId::YtDlp,
            v1,
            record(v1, "2026.08.19", "2026-10-19T00:00:00Z"),
        );
        let exe = b"yt-dlp 2026.10.10.233141";
        setup.release(Channel::Nightly, &sha256_hex(exe), exe);
        setup.release(Channel::Stable, &sha256_hex(v1), b"never fetched");
        setup.inspect.says(ToolId::YtDlp, "2026.10.10.233141");
        let tools = setup.tools();

        let status = tools.check(ToolId::YtDlp, Channel::Nightly, true).unwrap();

        assert_eq!(status.version.as_deref(), Some("2026.10.10.233141"));
        assert_eq!(setup.web.calls(), [nightly.sums_url(), nightly.asset_url()]);
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);
        assert_eq!(
            setup.record(ToolId::YtDlp).unwrap().channel,
            Some(Channel::Nightly)
        );
    }

    /// What Task 9's scheduler waits for, and a switch of yt-dlp's channel, which is due at once
    /// rather than a day later.
    #[test]
    fn next_due_follows_the_schedule_the_backoff_and_a_channel_switch() {
        let setup = Setup::new();
        let v1 = b"yt-dlp 2026.08.19";
        let checked = now() - Duration::hours(1);
        setup.installed(ToolId::YtDlp, v1, record(v1, "2026.08.19", &stamp(checked)));
        // Deno has no channel, so no switch; its interval is a week.
        setup.installed(
            ToolId::Deno,
            b"deno",
            ToolRecord {
                channel: None,
                ..record(b"deno", "2.9.7", &stamp(checked))
            },
        );
        let tools = setup.tools();
        let at = now();
        assert_eq!(
            tools.next_due(ToolId::YtDlp, Channel::Stable, at),
            Some(checked + Duration::hours(24))
        );
        for channel in [Channel::Stable, Channel::Nightly] {
            assert_eq!(
                tools.next_due(ToolId::Deno, channel, at),
                Some(checked + Duration::days(7))
            );
        }
        assert_eq!(
            tools
                .check(ToolId::YtDlp, Channel::Stable, false)
                .unwrap()
                .state,
            ToolState::Ready
        );
        tools.check(ToolId::Deno, Channel::Nightly, false).unwrap();
        assert!(setup.web.calls().is_empty(), "nothing is due");

        // Nightly chosen: due now.
        assert_eq!(tools.next_due(ToolId::YtDlp, Channel::Nightly, at), None);
        // Offline, the switch fails, and waits for the backoff instead of being tried at once.
        let nightly = source(ToolId::YtDlp, Channel::Nightly);
        setup
            .web
            .answer(&nightly.sums_url(), Err(FetchError::Offline));
        let before = now();
        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Nightly, false),
            Err(ToolError::Fetch(FetchError::Offline))
        );
        let next_try = time_of(&setup.record(ToolId::YtDlp).unwrap().next_try);
        assert!(next_try >= before + Duration::seconds(60), "{next_try}");
        assert_eq!(
            tools.next_due(ToolId::YtDlp, Channel::Nightly, now()),
            Some(next_try)
        );
        let calls = setup.web.calls();
        assert_eq!(calls, [nightly.sums_url()]);
        tools.check(ToolId::YtDlp, Channel::Nightly, false).unwrap();
        assert_eq!(setup.web.calls(), calls, "backing off");
        // Staying on stable: the later of the backoff and a day after the last good check.
        assert_eq!(
            tools.next_due(ToolId::YtDlp, Channel::Stable, now()),
            Some(checked + Duration::hours(24))
        );
        // Once the backoff is over, the switch is due again; it goes through when online.
        assert_eq!(
            tools.next_due(ToolId::YtDlp, Channel::Nightly, next_try),
            None
        );
        let exe = b"yt-dlp 2026.10.10.233141";
        setup.release(Channel::Nightly, &sha256_hex(exe), exe);
        setup.inspect.says(ToolId::YtDlp, "2026.10.10.233141");
        // Forced, so that the test does not wait the minute out.
        tools.check(ToolId::YtDlp, Channel::Nightly, true).unwrap();
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.channel, Some(Channel::Nightly));
        assert_eq!((recorded.failures, recorded.next_try), (0, None));
        let switched = time_of(&recorded.checked_at);
        assert_eq!(
            tools.next_due(ToolId::YtDlp, Channel::Nightly, now()),
            Some(switched + Duration::hours(24))
        );
        // Back to stable is a switch as well.
        assert_eq!(tools.next_due(ToolId::YtDlp, Channel::Stable, now()), None);
        // A missing tool is due now.
        fs::remove_file(setup.exe(ToolId::Deno)).unwrap();
        assert_eq!(tools.next_due(ToolId::Deno, Channel::Stable, now()), None);
    }

    #[test]
    fn deno_comes_out_of_its_zip() {
        let setup = Setup::new();
        let deno = b"deno 2.9.7 (stable, release, x86_64-pc-windows-msvc)";
        let zip = zip_of(Some(deno));
        let source = source(ToolId::Deno, Channel::Stable);
        setup.web.answer(&source.sums_url(), Ok(deno_sums(&zip)));
        setup.web.answer(&source.asset_url(), Ok(zip.clone()));
        setup.inspect.says(ToolId::Deno, "2.9.7");
        let tools = setup.tools();

        let status = tools.check(ToolId::Deno, Channel::Nightly, false).unwrap();

        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(status.version.as_deref(), Some("2.9.7"));
        assert_eq!(fs::read(setup.exe(ToolId::Deno)).unwrap(), deno);
        assert_eq!(tools.path(ToolId::Deno), Some(setup.exe(ToolId::Deno)));
        // The record keeps the zip's checksum, as the release lists it, and no channel.
        let recorded = setup.record(ToolId::Deno).unwrap();
        assert_eq!(recorded.sha256, sha256_hex(&zip));
        assert_eq!(recorded.channel, None);
        assert_eq!(
            setup.inspect.asked(),
            [(ToolId::Deno, setup.exe(ToolId::Deno), deno.to_vec())]
        );
        // The zip is not kept.
        assert_eq!(setup.names(), ["deno.exe", "tools.json"]);
        // yt-dlp is a tool of its own.
        assert_eq!(tools.status(ToolId::YtDlp).state, ToolState::Missing);

        // The same zip again: nothing downloaded.
        tools.check(ToolId::Deno, Channel::Stable, true).unwrap();
        assert_eq!(setup.web.count(&source.asset_url()), 1);

        // A zip without deno.exe, or not a zip: nothing changes.
        assert!(matches!(
            deno_from_zip(&zip_of(None)),
            Err(ToolError::Archive(_))
        ));
        assert!(matches!(
            deno_from_zip(b"not a zip"),
            Err(ToolError::Archive(_))
        ));
        assert_eq!(deno_from_zip(&zip).unwrap(), deno);
        let empty = zip_of(None);
        setup.web.answer(&source.sums_url(), Ok(deno_sums(&empty)));
        setup.web.answer(&source.asset_url(), Ok(empty));
        assert!(matches!(
            tools.check(ToolId::Deno, Channel::Stable, true),
            Err(ToolError::Archive(_))
        ));
        assert_eq!(fs::read(setup.exe(ToolId::Deno)).unwrap(), deno);
        assert_eq!(setup.names(), ["deno.exe", "tools.json"]);
    }

    /// Plan decision 7: the installer's copy (M4) is used when it is the one its tools.json names.
    #[test]
    fn a_bundled_copy_is_taken_over_when_the_tool_is_missing() {
        /// The installation's `resources\tools\` with `exe` as yt-dlp.exe and a tools.json that
        /// names `listed`.
        fn bundle(setup: &Setup, exe: &[u8], listed: &[u8]) {
            let dir = setup.paths.resource_dir.join(BUNDLED_DIR);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("yt-dlp.exe"), exe).unwrap();
            let mut file = ToolsFile::default();
            let mut bundled = record(listed, "2026.08.19", "2026-10-15T00:00:00Z");
            bundled.checked_at = None;
            file.tools.insert(ToolId::YtDlp, bundled);
            file.save(dir.join(store::FILE)).unwrap();
        }

        // The copy is the one named, and the release still has it: no download at all.
        let setup = Setup::new();
        let exe = b"bundled yt-dlp 2026.08.19";
        bundle(&setup, exe, exe);
        let source = source(ToolId::YtDlp, Channel::Stable);
        setup.release(Channel::Stable, &sha256_hex(exe), b"never fetched");
        // `--version` said nothing: the bundled record's version stands.
        let tools = setup.tools();
        assert_eq!(tools.status(ToolId::YtDlp).state, ToolState::Missing);

        let status = tools.check(ToolId::YtDlp, Channel::Stable, false).unwrap();

        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(status.version.as_deref(), Some("2026.08.19"));
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);
        assert_eq!(setup.web.calls(), [source.sums_url()]);
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.sha256, sha256_hex(exe));
        assert!(recorded.checked_at.is_some());
        // The bundled copy stays where it is: it is the installation's.
        assert!(setup.paths.resource_dir.join("tools/yt-dlp.exe").is_file());

        // Offline, the bundled copy is there all the same.
        let setup = Setup::new();
        bundle(&setup, exe, exe);
        setup
            .web
            .answer(&source.sums_url(), Err(FetchError::Offline));
        let tools = setup.tools();
        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Stable, false),
            Err(ToolError::Fetch(FetchError::Offline))
        );
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);
        assert_eq!(tools.path(ToolId::YtDlp), Some(setup.exe(ToolId::YtDlp)));
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!((recorded.sha256, recorded.failures), (sha256_hex(exe), 1));

        // A copy that is not the one named is never used: the release's is downloaded.
        let setup = Setup::new();
        bundle(&setup, b"tampered", exe);
        let released = b"yt-dlp 2026.10.10";
        setup.release(Channel::Stable, &sha256_hex(released), released);
        setup.inspect.says(ToolId::YtDlp, "2026.10.10");
        let tools = setup.tools();
        tools.check(ToolId::YtDlp, Channel::Stable, false).unwrap();
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), released);
        assert_eq!(setup.web.calls(), [source.sums_url(), source.asset_url()]);

        // A tool that is there is not replaced by the bundled one.
        bundle(&setup, exe, exe);
        tools.check(ToolId::YtDlp, Channel::Stable, true).unwrap();
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), released);
    }

    #[test]
    fn two_checks_at_once_download_once() {
        let setup = Setup::new();
        let exe = b"yt-dlp 2026.08.19";
        setup.release(Channel::Stable, &sha256_hex(exe), exe);
        setup.inspect.says(ToolId::YtDlp, "2026.08.19");
        let deno = source(ToolId::Deno, Channel::Stable);
        setup.web.answer(&deno.sums_url(), Err(FetchError::Offline));
        let source = source(ToolId::YtDlp, Channel::Stable);
        setup.web.hold(&source.asset_url());
        let tools = setup.tools();

        /// Lets the held download go when the test fails half-way, so that the scope can end.
        struct Release<'a>(&'a FakeWeb);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                self.0.release();
            }
        }

        let (first, second) = thread::scope(|scope| {
            let _release = Release(&setup.web);
            let first = scope.spawn(|| tools.check(ToolId::YtDlp, Channel::Stable, false));
            eventually("the first download", || {
                setup.web.count(&source.asset_url()) == 1
            });
            assert_eq!(tools.status(ToolId::YtDlp).state, ToolState::Downloading);
            let second = scope.spawn(|| tools.check(ToolId::YtDlp, Channel::Stable, true));
            eventually("the second check to wait", || tools.waiting() == 1);
            // The other tool is not held up by it.
            assert_eq!(
                tools.check(ToolId::Deno, Channel::Stable, true),
                Err(ToolError::Fetch(FetchError::Offline))
            );
            setup.web.release();
            (first.join().unwrap(), second.join().unwrap())
        });

        let status = first.unwrap();
        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(second, Ok(status));
        assert_eq!(setup.web.count(&source.sums_url()), 1);
        assert_eq!(setup.web.count(&source.asset_url()), 1);
        assert_eq!(setup.inspect.asked().len(), 1);
        assert_eq!(tools.waiting(), 0);
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);
    }

    /// What Task 9 hands the UI (`tools:status`, `tools_status`): camelCase keys and values.
    #[test]
    fn statuses_are_camel_case() {
        let status = ToolStatus {
            tool: ToolId::YtDlp,
            state: ToolState::Downloading,
            version: Some("2026.08.19".to_owned()),
            checked_at: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "tool": "ytDlp",
                "state": "downloading",
                "version": "2026.08.19",
                "checkedAt": null,
                "error": null
            })
        );
        assert_eq!(serde_json::to_value(ToolId::Deno).unwrap(), "deno");
        assert_eq!(serde_json::to_value(Channel::Nightly).unwrap(), "nightly");
        assert_eq!(
            serde_json::from_value::<Channel>(serde_json::json!("stable")).unwrap(),
            Channel::Stable
        );
        assert!(serde_json::from_value::<Channel>(serde_json::json!("beta")).is_err());
    }

    /// Plan decision 20: a Deno yt-dlp cannot use is there, verified, and as good as missing.
    #[test]
    fn deno_older_than_2_3_counts_as_missing() {
        assert!(!run::deno_supported("2.2.9"));
        assert!(run::deno_supported("2.3.0"));
        assert!(run::deno_supported("2.9.7"));
        assert!(!run::deno_supported("x"));

        for (version, usable) in [
            (Some("2.2.9"), false),
            (Some("2.3.0"), true),
            (Some("2.9.7"), true),
            (Some("x"), false),
            (None, false),
        ] {
            let setup = Setup::new();
            setup.installed(
                ToolId::Deno,
                b"deno",
                ToolRecord {
                    version: version.map(str::to_owned),
                    channel: None,
                    ..record(b"deno", "2.9.7", "2026-10-19T00:00:00Z")
                },
            );
            let tools = setup.tools();
            let exe = setup.exe(ToolId::Deno);

            // In place and verified, but only one yt-dlp can use is Deno's path (Ruling R9).
            assert!(exe.is_file());
            let status = tools.status(ToolId::Deno);
            assert_eq!(status.version.as_deref(), version, "{version:?}");
            if usable {
                assert_eq!(status.state, ToolState::Ready, "{version:?}");
                assert_eq!(status.error, None);
                assert_eq!(tools.path(ToolId::Deno), Some(exe));
            } else {
                assert_eq!(status.state, ToolState::Failed, "{version:?}");
                let error = status.error.unwrap();
                assert!(error.contains("2.3.0 or newer"), "{error}");
                if let Some(version) = version {
                    assert!(error.contains(version), "{error}");
                }
                assert_eq!(tools.path(ToolId::Deno), None, "{version:?}");
            }
            // yt-dlp hears of it only when it can use it.
            let service = Service::new(tools, &setup.paths, Arc::new(FakeHost::default()));
            let options = service.options_for_new_core();
            let js_runtimes = options
                .iter()
                .find(|command| command[3].starts_with("js-runtimes"))
                .unwrap();
            assert_eq!(
                js_runtimes[2],
                if usable { "append" } else { "remove" },
                "{version:?}"
            );
            // yt-dlp has no such limit.
            assert_eq!(unusable(ToolId::YtDlp, None), None);
        }
    }

    /// Hears what a [`Service`] tells the app.
    #[derive(Default)]
    struct FakeHost {
        channel: Mutex<Channel>,
        /// The browser for the cookies, as the settings would say.
        cookies: Mutex<Option<String>>,
        statuses: Mutex<Vec<ToolStatus>>,
        sent: Mutex<Vec<Vec<String>>>,
    }

    impl FakeHost {
        fn states_of(&self, tool: ToolId) -> Vec<ToolState> {
            self.statuses
                .lock()
                .unwrap()
                .iter()
                .filter(|status| status.tool == tool)
                .map(|status| status.state)
                .collect()
        }

        fn sent(&self) -> Vec<Vec<String>> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl Host for FakeHost {
        fn channel(&self) -> Channel {
            *self.channel.lock().unwrap()
        }

        fn cookies(&self) -> Option<String> {
            self.cookies.lock().unwrap().clone()
        }

        fn status(&self, status: &ToolStatus) {
            self.statuses.lock().unwrap().push(status.clone());
        }

        fn send(&self, commands: Vec<Vec<String>>) {
            self.sent.lock().unwrap().extend(commands);
        }
    }

    fn command(args: &[&str]) -> Vec<String> {
        args.iter().map(|&arg| arg.to_owned()).collect()
    }

    /// The scheduler checks at once, the UI hears every step, the running core gets what changed,
    /// and a switch of the channel is checked without waiting for the next round.
    #[test]
    fn the_scheduler_checks_at_start_and_after_a_channel_switch() {
        let setup = Setup::new();
        let exe = b"yt-dlp 2026.08.19";
        setup.release(Channel::Stable, &sha256_hex(exe), exe);
        setup.inspect.says(ToolId::YtDlp, "2026.08.19");
        let zip = zip_of(Some(b"deno 2.9.7"));
        let deno = source(ToolId::Deno, Channel::Stable);
        setup.web.answer(&deno.sums_url(), Ok(deno_sums(&zip)));
        setup.web.answer(&deno.asset_url(), Ok(zip));
        setup.inspect.says(ToolId::Deno, "2.9.7");
        let host = Arc::new(FakeHost::default());
        let service = Service::new(setup.tools(), &setup.paths, host.clone());
        let yt_dlp = setup.exe(ToolId::YtDlp).to_string_lossy().into_owned();
        let deno_exe = setup.exe(ToolId::Deno).to_string_lossy().into_owned();

        // What the core gets at its start, before anything is there: the managed yt-dlp to come
        // (spelled as a list, see `mpv::hook_commands`), no Deno, no cookies.
        assert_eq!(
            service.options_for_new_core(),
            [
                command(&[
                    "change-list",
                    "script-opts",
                    "append",
                    &format!("ytdl_hook-ytdl_path={yt_dlp};")
                ]),
                command(&["change-list", "ytdl-raw-options", "remove", "js-runtimes"]),
                command(&[
                    "change-list",
                    "ytdl-raw-options",
                    "remove",
                    "cookies-from-browser"
                ]),
            ]
        );
        assert!(host.statuses.lock().unwrap().is_empty());

        service.start();

        eventually("both tools to be in place", || {
            service
                .statuses()
                .iter()
                .all(|status| status.state == ToolState::Ready)
        });
        eventually("the core to hear of both", || host.sent().len() == 2);
        for tool in ToolId::ALL {
            assert_eq!(
                host.states_of(tool),
                [
                    ToolState::Checking,
                    ToolState::Downloading,
                    ToolState::Ready
                ],
                "{tool}"
            );
        }
        // Only what changed, yt-dlp's check first.
        assert_eq!(
            host.sent(),
            [
                command(&[
                    "change-list",
                    "script-opts",
                    "append",
                    &format!("ytdl_hook-ytdl_path={yt_dlp}")
                ]),
                command(&[
                    "change-list",
                    "ytdl-raw-options",
                    "append",
                    &format!("js-runtimes=deno:{deno_exe}")
                ]),
            ]
        );
        assert_eq!(
            service
                .statuses()
                .iter()
                .map(|s| s.tool)
                .collect::<Vec<_>>(),
            ToolId::ALL
        );

        // The user switches to nightly: checked now, not in a day (nor after the 30 s floor).
        let nightly = b"yt-dlp 2026.10.10.233141";
        setup.release(Channel::Nightly, &sha256_hex(nightly), nightly);
        setup.inspect.says(ToolId::YtDlp, "2026.10.10.233141");
        *host.channel.lock().unwrap() = Channel::Nightly;
        service.channel_changed();
        eventually("the nightly yt-dlp to be in place", || {
            service.statuses()[0].version.as_deref() == Some("2026.10.10.233141")
        });
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), nightly);
        assert_eq!(
            setup.record(ToolId::YtDlp).unwrap().channel,
            Some(Channel::Nightly)
        );
        // Put in place anew at the same place: the hook is told in another spelling, so that it
        // looks again. Deno was not due.
        eventually("the hook to hear of it", || host.sent().len() == 3);
        assert_eq!(
            host.sent()[2],
            command(&[
                "change-list",
                "script-opts",
                "append",
                &format!("ytdl_hook-ytdl_path={yt_dlp};;")
            ])
        );
        assert_eq!(setup.web.count(&deno.asset_url()), 1);

        // "Zkontrolovat": at once, from the channel of the settings.
        let sums = source(ToolId::YtDlp, Channel::Nightly).sums_url();
        let before = setup.web.count(&sums);
        let status = service.check_now(ToolId::YtDlp);
        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(setup.web.count(&sums), before + 1);
        // Nothing was put in place: nothing for the core.
        assert_eq!(host.sent().len(), 3);

        // Gone, the scheduler ends.
        drop(service);
    }

    /// A link failed because yt-dlp is missing or out of date (Task 10): the check that follows is
    /// the scheduler's, made now. A yt-dlp that is not there is downloaded and the running core
    /// hears of it; one that was checked just now is left alone, so that a link that keeps
    /// failing does not ask the release again and again.
    #[test]
    fn a_failed_link_checks_yt_dlp_only_when_it_is_due() {
        let setup = Setup::new();
        let exe = b"yt-dlp 2026.08.19";
        setup.release(Channel::Stable, &sha256_hex(exe), exe);
        setup.inspect.says(ToolId::YtDlp, "2026.08.19");
        let host = Arc::new(FakeHost::default());
        let service = Service::new(setup.tools(), &setup.paths, host.clone());
        let yt_dlp = setup.exe(ToolId::YtDlp).to_string_lossy().into_owned();
        let source = source(ToolId::YtDlp, Channel::Stable);
        // The core started without it.
        service.options_for_new_core();

        let status = service.check_if_due(ToolId::YtDlp);
        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(setup.web.calls(), [source.sums_url(), source.asset_url()]);
        assert_eq!(
            host.sent(),
            [command(&[
                "change-list",
                "script-opts",
                "append",
                &format!("ytdl_hook-ytdl_path={yt_dlp}")
            ])]
        );

        // Checked just now: not due, the release is not asked, the core hears nothing.
        let status = service.check_if_due(ToolId::YtDlp);
        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(setup.web.calls().len(), 2);
        assert_eq!(host.sent().len(), 1);
    }

    /// The browser for yt-dlp's cookies (plan decision 13) goes to the running core when the user
    /// changes it, on the way every change of the tools' options goes, so what the core was last
    /// sent stays right; a core that starts after it (a restart of the player) is given it with
    /// the rest. Needs no network and no player.
    #[test]
    fn a_change_of_the_cookies_reaches_the_running_core_and_the_next_one() {
        let setup = Setup::new();
        let host = Arc::new(FakeHost::default());
        let service = Service::new(setup.tools(), &setup.paths, host.clone());
        let append = |spec: &str| {
            command(&[
                "change-list",
                "ytdl-raw-options",
                "append",
                &format!("cookies-from-browser={spec}"),
            ])
        };
        let remove = command(&[
            "change-list",
            "ytdl-raw-options",
            "remove",
            "cookies-from-browser",
        ]);

        // A core that starts with none chosen.
        assert!(service.options_for_new_core().contains(&remove));
        assert_eq!(host.sent(), Vec::<Vec<String>>::new());

        // Chosen: the core gets the key and nothing else.
        *host.cookies.lock().unwrap() = Some("firefox".to_owned());
        service.cookies_changed();
        assert_eq!(host.sent(), [append("firefox")]);
        // Told again with nothing new: nothing is sent.
        service.cookies_changed();
        assert_eq!(host.sent().len(), 1);

        // A restart: the new core is given it with the rest, and what it has is what it was
        // sent, so nothing is repeated.
        let options = service.options_for_new_core();
        assert!(options.contains(&append("firefox")), "{options:?}");
        assert!(!options.contains(&remove), "{options:?}");
        service.cookies_changed();
        assert_eq!(host.sent().len(), 1);

        // Another browser, with a profile as yt-dlp takes it: the key is replaced.
        let profile = r"firefox:C:\Users\Jiří Novák\AppData\Roaming\zen\Profiles\x.Default";
        *host.cookies.lock().unwrap() = Some(profile.to_owned());
        service.cookies_changed();
        assert_eq!(host.sent()[1..], [append(profile)]);

        // None: the key goes, and a core that starts later does not have it.
        *host.cookies.lock().unwrap() = None;
        service.cookies_changed();
        // Nothing else was sent: not the hook's path, not Deno.
        assert_eq!(host.sent().len(), 3);
        assert_eq!(host.sent()[2], remove);
        assert!(service.options_for_new_core().contains(&remove));
    }

    /// Ruling R10: a virus scanner that quarantines yt-dlp.exe right after its `--version` ran.
    /// The check is a failure that backs off, so that the scheduler does not download it again
    /// at every round.
    #[test]
    fn a_tool_that_vanishes_after_its_install_is_a_failure() {
        let setup = Setup::new();
        let exe = b"yt-dlp 2026.08.19";
        setup.release(Channel::Stable, &sha256_hex(exe), exe);
        setup.inspect.says(ToolId::YtDlp, "2026.08.19");
        setup.inspect.quarantines(ToolId::YtDlp, true);
        let tools = setup.tools();
        let source = source(ToolId::YtDlp, Channel::Stable);

        let before = now();
        let result = tools.check(ToolId::YtDlp, Channel::Stable, false);
        let after = now();

        assert_eq!(result, Err(ToolError::Gone(ToolId::YtDlp)));
        assert!(!setup.exe(ToolId::YtDlp).exists());
        assert_eq!(tools.path(ToolId::YtDlp), None);
        let status = tools.status(ToolId::YtDlp);
        assert_eq!((status.state, status.version), (ToolState::Failed, None));
        let error = status.error.unwrap();
        assert!(
            error.contains("yt-dlp.exe disappeared") && error.contains("antivirus"),
            "{error}"
        );
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.failures, 1);
        let next = time_of(&recorded.next_try);
        assert!(
            before + Duration::seconds(60) <= next && next <= after + Duration::seconds(60),
            "{next}"
        );
        // A check that failed is not a check.
        assert_eq!(recorded.checked_at, None);
        // Not due before the backoff is over: a round of the scheduler asks nothing.
        assert_eq!(
            tools.next_due(ToolId::YtDlp, Channel::Stable, now()),
            Some(next)
        );
        let calls = setup.web.calls().len();
        tools.check(ToolId::YtDlp, Channel::Stable, false).unwrap();
        assert_eq!(setup.web.calls().len(), calls);

        // Forced, it goes again, and the wait grows.
        let before = now();
        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Stable, true),
            Err(ToolError::Gone(ToolId::YtDlp))
        );
        let after = now();
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.failures, 2);
        let next = time_of(&recorded.next_try);
        assert!(
            before + Duration::seconds(300) <= next && next <= after + Duration::seconds(300),
            "{next}"
        );
        assert_eq!(setup.web.count(&source.asset_url()), 2);

        // The scanner lets it be: in place, and ready.
        setup.inspect.quarantines(ToolId::YtDlp, false);
        let status = tools.check(ToolId::YtDlp, Channel::Stable, true).unwrap();
        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(status.error, None);
        assert_eq!(tools.path(ToolId::YtDlp), Some(setup.exe(ToolId::YtDlp)));
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!((recorded.failures, recorded.next_try), (0, None));
        assert_eq!(tools.installs(ToolId::YtDlp), 3);
    }

    /// The backoff of `tool` over: its `next_try` a second ago, as a later start of Kaleido reads
    /// it, so that the test does not wait the minutes out.
    fn backoff_over(setup: &Setup, tool: ToolId) -> Tools {
        let path = setup.paths.tools_dir.join(store::FILE);
        let mut file = ToolsFile::load(&path);
        let record = file.tools.get_mut(&tool).expect("a record");
        record.next_try = Some(stamp(now() - Duration::seconds(1)));
        file.save(&path).unwrap();
        setup.tools()
    }

    /// Ruling R10: a virus scanner that lets `--version` run and takes the file away seconds after
    /// the check went through. The next check that is not forced counts it as a failure and
    /// downloads nothing; after the backoff it downloads again, and a scanner that keeps taking
    /// the file away makes the wait grow, although the downloads in between went through.
    #[test]
    fn a_tool_found_gone_at_the_start_of_a_check_is_a_failure_before_any_download() {
        let setup = Setup::new();
        let exe = b"yt-dlp 2026.08.19";
        setup.release(Channel::Stable, &sha256_hex(exe), exe);
        setup.inspect.says(ToolId::YtDlp, "2026.08.19");
        let source = source(ToolId::YtDlp, Channel::Stable);
        let tools = setup.tools();
        assert_eq!(
            tools
                .check(ToolId::YtDlp, Channel::Stable, false)
                .unwrap()
                .state,
            ToolState::Ready
        );
        assert_eq!(setup.web.count(&source.asset_url()), 1);

        // Seconds later the scanner takes it away: the record says it is there, the file is not,
        // and the scheduler sees it due at once.
        fs::remove_file(setup.exe(ToolId::YtDlp)).unwrap();
        assert_eq!(tools.next_due(ToolId::YtDlp, Channel::Stable, now()), None);
        let calls = setup.web.calls().len();
        let before = now();
        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Stable, false),
            Err(ToolError::Gone(ToolId::YtDlp))
        );
        let after = now();
        assert_eq!(
            setup.web.calls().len(),
            calls,
            "nothing asked of the network"
        );
        let status = tools.status(ToolId::YtDlp);
        assert_eq!((status.state, status.version), (ToolState::Failed, None));
        assert!(status.error.unwrap().contains("antivirus"));
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!((recorded.failures, recorded.vanished), (1, 1));
        let next = time_of(&recorded.next_try);
        assert!(
            before + Duration::seconds(60) <= next && next <= after + Duration::seconds(60),
            "{next}"
        );
        assert_eq!(
            tools.next_due(ToolId::YtDlp, Channel::Stable, now()),
            Some(next)
        );
        // The next round asks nothing either.
        tools.check(ToolId::YtDlp, Channel::Stable, false).unwrap();
        assert_eq!(setup.web.calls().len(), calls);

        // After the backoff: downloaded again, in place, its failures over, the vanishing kept.
        let tools = backoff_over(&setup, ToolId::YtDlp);
        assert_eq!(tools.next_due(ToolId::YtDlp, Channel::Stable, now()), None);
        assert_eq!(
            tools
                .check(ToolId::YtDlp, Channel::Stable, false)
                .unwrap()
                .state,
            ToolState::Ready
        );
        assert_eq!(setup.web.count(&source.asset_url()), 2);
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(
            (recorded.failures, recorded.next_try, recorded.vanished),
            (0, None, 1)
        );

        // Taken away again: the wait grows.
        fs::remove_file(setup.exe(ToolId::YtDlp)).unwrap();
        let before = now();
        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Stable, false),
            Err(ToolError::Gone(ToolId::YtDlp))
        );
        let after = now();
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!((recorded.failures, recorded.vanished), (2, 2));
        let next = time_of(&recorded.next_try);
        assert!(
            before + Duration::seconds(300) <= next && next <= after + Duration::seconds(300),
            "{next}"
        );
        assert_eq!(setup.web.count(&source.asset_url()), 2);
        // And again after the next download: 30 minutes.
        let tools = backoff_over(&setup, ToolId::YtDlp);
        tools.check(ToolId::YtDlp, Channel::Stable, false).unwrap();
        assert_eq!(setup.web.count(&source.asset_url()), 3);
        fs::remove_file(setup.exe(ToolId::YtDlp)).unwrap();
        let before = now();
        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Stable, false),
            Err(ToolError::Gone(ToolId::YtDlp))
        );
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!((recorded.failures, recorded.vanished), (3, 3));
        assert!(time_of(&recorded.next_try) >= before + Duration::seconds(1800));

        // "Zkontrolovat" downloads at once, whatever the backoff says.
        assert_eq!(
            tools
                .check(ToolId::YtDlp, Channel::Stable, true)
                .unwrap()
                .state,
            ToolState::Ready
        );
        assert_eq!(setup.web.count(&source.asset_url()), 4);
        assert_eq!(setup.record(ToolId::YtDlp).unwrap().vanished, 3);
        // A check that finds it still in place at its start ends the streak, and downloads
        // nothing; the next vanishing waits a minute again.
        tools.check(ToolId::YtDlp, Channel::Stable, true).unwrap();
        assert_eq!(setup.web.count(&source.asset_url()), 4);
        assert_eq!(setup.record(ToolId::YtDlp).unwrap().vanished, 0);
        fs::remove_file(setup.exe(ToolId::YtDlp)).unwrap();
        let before = now();
        tools
            .check(ToolId::YtDlp, Channel::Stable, false)
            .unwrap_err();
        let after = now();
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!((recorded.failures, recorded.vanished), (1, 1));
        let next = time_of(&recorded.next_try);
        assert!(
            before + Duration::seconds(60) <= next && next <= after + Duration::seconds(60),
            "{next}"
        );
    }

    /// The installation's bundled copy as `resources\tools\yt-dlp.exe`, with the `tools.json`
    /// beside it that names it (plan decision 7).
    fn put_bundled_copy(setup: &Setup, exe: &[u8]) {
        let dir = setup.paths.resource_dir.join(BUNDLED_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("yt-dlp.exe"), exe).unwrap();
        let mut file = ToolsFile::default();
        let mut bundled = record(exe, "2026.08.19", "2026-10-15T00:00:00Z");
        bundled.checked_at = None;
        file.tools.insert(ToolId::YtDlp, bundled);
        file.save(dir.join(store::FILE)).unwrap();
    }

    /// Ruling R10 with a bundled copy beside the tools (plan decision 7): taking it over again is
    /// putting it in place again, so a scanner that takes every copy away waits longer each time
    /// (60, 300, 1800 s) rather than a minute again and again.
    #[test]
    fn a_bundled_copy_taken_away_again_and_again_waits_longer_each_time() {
        let setup = Setup::new();
        let exe = b"bundled yt-dlp 2026.08.19";
        put_bundled_copy(&setup, exe);
        // The release has the same file: nothing is ever downloaded.
        setup.release(Channel::Stable, &sha256_hex(exe), b"never fetched");
        setup.inspect.says(ToolId::YtDlp, "2026.08.19");
        let source = source(ToolId::YtDlp, Channel::Stable);
        let mut tools = setup.tools();
        assert_eq!(
            tools
                .check(ToolId::YtDlp, Channel::Stable, false)
                .unwrap()
                .state,
            ToolState::Ready
        );
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);

        for (round, wait) in [(1, 60), (2, 300), (3, 1800)] {
            // The scanner takes it away; the next check counts it and copies nothing.
            fs::remove_file(setup.exe(ToolId::YtDlp)).unwrap();
            let before = now();
            assert_eq!(
                tools.check(ToolId::YtDlp, Channel::Stable, false),
                Err(ToolError::Gone(ToolId::YtDlp)),
                "round {round}"
            );
            let after = now();
            assert!(!setup.exe(ToolId::YtDlp).exists(), "round {round}");
            let recorded = setup.record(ToolId::YtDlp).unwrap();
            assert_eq!((recorded.failures, recorded.vanished), (round, round));
            let next = time_of(&recorded.next_try);
            assert!(
                before + Duration::seconds(wait) <= next && next <= after + Duration::seconds(wait),
                "round {round}: {next}"
            );

            // After the backoff the bundled copy is put back, ready, and the streak stays.
            tools = backoff_over(&setup, ToolId::YtDlp);
            assert_eq!(
                tools
                    .check(ToolId::YtDlp, Channel::Stable, false)
                    .unwrap()
                    .state,
                ToolState::Ready,
                "round {round}"
            );
            assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);
            let recorded = setup.record(ToolId::YtDlp).unwrap();
            assert_eq!(
                (recorded.failures, recorded.next_try, recorded.vanished),
                (0, None, round),
                "round {round}"
            );
        }
        assert_eq!(setup.web.count(&source.asset_url()), 0);
    }

    /// Ruling R10 and the scheduler's rounds: a tool put in place whose `--version` does not
    /// answer is a failure that backs off (not a day's wait), and is asked again without the
    /// network.
    #[test]
    fn a_tool_that_does_not_say_its_version_is_a_failure_and_is_asked_again() {
        let setup = Setup::new();
        let exe = b"yt-dlp 2026.08.19";
        setup.release(Channel::Stable, &sha256_hex(exe), exe);
        let tools = setup.tools();

        assert_eq!(
            tools.check(ToolId::YtDlp, Channel::Stable, false),
            Err(ToolError::Silent(ToolId::YtDlp))
        );

        // In place and verified: the hook may run it still.
        assert_eq!(fs::read(setup.exe(ToolId::YtDlp)).unwrap(), exe);
        assert_eq!(tools.path(ToolId::YtDlp), Some(setup.exe(ToolId::YtDlp)));
        let status = tools.status(ToolId::YtDlp);
        assert_eq!((status.state, status.version), (ToolState::Failed, None));
        assert!(status.error.unwrap().contains("did not say its version"));
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.failures, 1);
        // Tried again after the backoff, not a day after the install.
        let next = time_of(&recorded.next_try);
        assert_eq!(
            tools.next_due(ToolId::YtDlp, Channel::Stable, now()),
            Some(next)
        );
        assert_eq!(tools.next_due(ToolId::YtDlp, Channel::Stable, next), None);

        // Asked again: still silent, nothing changes.
        let calls = setup.web.calls().len();
        assert!(!tools.inspect_again(ToolId::YtDlp));
        assert_eq!(setup.record(ToolId::YtDlp).unwrap().failures, 1);
        // It answers now: ready, without the network.
        setup.inspect.says(ToolId::YtDlp, "2026.08.19");
        assert!(tools.inspect_again(ToolId::YtDlp));
        assert_eq!(setup.web.calls().len(), calls);
        let status = tools.status(ToolId::YtDlp);
        assert_eq!(status.state, ToolState::Ready);
        assert_eq!(status.version.as_deref(), Some("2026.08.19"));
        assert_eq!(status.error, None);
        let recorded = setup.record(ToolId::YtDlp).unwrap();
        assert_eq!(recorded.version.as_deref(), Some("2026.08.19"));
        assert_eq!((recorded.failures, recorded.next_try), (0, None));
        // Known: nothing to ask, and nothing runs.
        let asked = setup.inspect.asked().len();
        assert!(!tools.inspect_again(ToolId::YtDlp));
        assert_eq!(setup.inspect.asked().len(), asked);
        // Nor for a tool that is not there.
        assert!(!tools.inspect_again(ToolId::Deno));
    }

    /// A Deno whose `--version` did not answer at first reaches the running core once a round of
    /// the scheduler hears its version, without a check and without the network.
    #[test]
    fn a_deno_whose_version_comes_late_reaches_the_core() {
        let setup = Setup::new();
        let recent = stamp(now() - Duration::hours(1));
        setup.installed(
            ToolId::YtDlp,
            b"yt-dlp",
            record(b"yt-dlp", "2026.08.19", &recent),
        );
        setup.installed(
            ToolId::Deno,
            b"deno",
            ToolRecord {
                version: None,
                channel: None,
                ..record(b"deno", "2.9.7", &recent)
            },
        );
        let host = Arc::new(FakeHost::default());
        let service = Service::new(setup.tools(), &setup.paths, host.clone());
        let remove = command(&["change-list", "ytdl-raw-options", "remove", "js-runtimes"]);
        assert!(service.options_for_new_core().contains(&remove));
        assert_eq!(service.tools().path(ToolId::Deno), None);

        setup.inspect.says(ToolId::Deno, "2.9.7");
        service.start();

        eventually("the core to hear of Deno", || host.sent().len() == 1);
        let deno = setup.exe(ToolId::Deno).to_string_lossy().into_owned();
        assert_eq!(
            host.sent(),
            [command(&[
                "change-list",
                "ytdl-raw-options",
                "append",
                &format!("js-runtimes=deno:{deno}")
            ])]
        );
        assert_eq!(service.statuses()[1].state, ToolState::Ready);
        assert_eq!(host.states_of(ToolId::Deno), [ToolState::Ready]);
        assert!(setup.web.calls().is_empty(), "{:?}", setup.web.calls());
        drop(service);
    }

    #[test]
    fn the_scheduler_sleeps_until_the_next_check_within_its_bounds() {
        let now = parse_time("2026-10-19T12:00:00Z").unwrap();
        let at = |seconds: i64| Some(now + Duration::seconds(seconds));
        let seconds = std::time::Duration::from_secs;

        assert_eq!(scheduler_wait(&[at(120), at(7200)], now), seconds(121));
        assert_eq!(scheduler_wait(&[at(7200), at(600)], now), seconds(601));
        // Due now (it stayed due after its check), soon, or in the past: the floor.
        assert_eq!(scheduler_wait(&[None, at(86_400)], now), SCHEDULER_MIN_WAIT);
        assert_eq!(
            scheduler_wait(&[at(5), at(86_400)], now),
            SCHEDULER_MIN_WAIT
        );
        assert_eq!(scheduler_wait(&[at(-60), at(600)], now), SCHEDULER_MIN_WAIT);
        // A day or a week away: an hour at most.
        assert_eq!(
            scheduler_wait(&[at(86_400), at(604_800)], now),
            SCHEDULER_MAX_WAIT
        );
        assert_eq!(scheduler_wait(&[], now), SCHEDULER_MAX_WAIT);
        assert_eq!(SCHEDULER_MIN_WAIT, seconds(30));
        assert_eq!(SCHEDULER_MAX_WAIT, seconds(3600));
    }

    /// The real release, by hand only (`cargo test -p kaleido -- --ignored`): fetches only its
    /// small `SHA2-256SUMS`, through GitHub's redirects and the system's TLS.
    #[test]
    #[ignore = "network"]
    fn the_real_yt_dlp_release_has_a_checksum_for_the_exe() {
        let source = source(ToolId::YtDlp, Channel::Stable);
        let sums = http::Web::github()
            .get(&source.sums_url(), SUMS_LIMIT)
            .unwrap();
        let sums = String::from_utf8(sums).unwrap();
        let hex = checksum::from_sums(&sums, "yt-dlp.exe").expect("a line for yt-dlp.exe");
        assert_eq!(hex.len(), 64);
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit()));
    }
}
