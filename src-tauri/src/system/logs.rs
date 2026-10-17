//! The logs (spec 10.8): `kaleido.<date>.log` from Rust's `tracing`, one file a day and the last
//! seven kept, and mpv's `mpv.log`, which is renamed at every start and kept for seven days.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};
use tracing::Dispatch;
use tracing::level_filters::LevelFilter;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{InitError, RollingFileAppender, Rotation};
use tracing_subscriber::util::SubscriberInitExt;

use crate::paths::AppPaths;

/// `kaleido.2026-10-17.log`: the date is UTC, as `tracing-appender` names the files.
const KALEIDO_LOG_PREFIX: &str = "kaleido";
const KALEIDO_LOG_SUFFIX: &str = "log";
/// One file a day: a week of them.
const KALEIDO_LOG_FILES: usize = 7;

/// The file mpv writes to (`log-file`, enforced in `player::options`).
const MPV_LOG: &str = "mpv.log";
/// How long an archived `mpv.log` is kept.
const MPV_LOG_KEPT: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Keeps the log writer alive: `tracing` hands lines to a thread that writes them, and the
/// lines still queued are lost if it ends first. Managed by the app for as long as it runs.
pub struct LogGuard(Mutex<Option<WorkerGuard>>);

impl LogGuard {
    /// Writes what is still queued and ends the writer. The process ends without dropping the
    /// app's managed state, so the app calls this when it exits. Lines logged afterwards are
    /// lost.
    pub fn flush(&self) {
        let guard = self.0.lock().unwrap_or_else(PoisonError::into_inner).take();
        drop(guard);
    }
}

/// Starts logging to `kaleido.<date>.log` in the logs folder, from `info` up. Called as soon as
/// the setup knows the folders, which exist only from there: what is logged before is not
/// captured. When the file cannot be opened, the app runs without a log.
pub fn init(paths: &AppPaths) -> LogGuard {
    let guard = match build(&paths.logs_dir) {
        Ok((dispatch, guard)) => match dispatch.try_init() {
            Ok(()) => Some(guard),
            Err(error) => {
                eprintln!("Kaleido: cannot start logging: {error}");
                None
            }
        },
        Err(error) => {
            eprintln!(
                "Kaleido: cannot write the log in {}: {error}",
                paths.logs_dir.display()
            );
            None
        }
    };
    LogGuard(Mutex::new(guard))
}

/// The logger for `logs_dir` and the guard of its writer thread. Separate from [`init`], which
/// installs it for the whole process, so that a test can use it for one thread.
fn build(logs_dir: &Path) -> Result<(Dispatch, WorkerGuard), InitError> {
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(KALEIDO_LOG_PREFIX)
        .filename_suffix(KALEIDO_LOG_SUFFIX)
        .max_log_files(KALEIDO_LOG_FILES)
        .build(logs_dir)?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let subscriber = tracing_subscriber::fmt()
        .with_writer(writer)
        // A text file, not a terminal.
        .with_ansi(false)
        .with_max_level(LevelFilter::INFO)
        .finish();
    Ok((Dispatch::new(subscriber), guard))
}

/// Before mpv starts, which opens `mpv.log` anew: renames the `mpv.log` of the last run to
/// `mpv-YYYYMMDD-HHMMSS.log` (UTC, `now`) and deletes the archives that are more than seven
/// days old. A failure to archive does not keep the old archives from going; the first error is
/// returned.
pub fn rotate_mpv_log(logs_dir: &Path, now: SystemTime) -> io::Result<()> {
    let archived = archive_mpv_log(logs_dir, now);
    let pruned = prune_mpv_archives(logs_dir, now);
    archived.and(pruned)
}

fn archive_mpv_log(logs_dir: &Path, now: SystemTime) -> io::Result<()> {
    match fs::rename(logs_dir.join(MPV_LOG), logs_dir.join(archive_name(now))) {
        // The first start, or a run that never started mpv.
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Deletes the archives older than [`MPV_LOG_KEPT`] by the time in their names, not by when
/// the file was written: the log of the last run is an archive from now on and stays for the
/// whole week, however long ago the run was. Files that are not archives are not touched.
fn prune_mpv_archives(logs_dir: &Path, now: SystemTime) -> io::Result<()> {
    let mut first_error = None;
    for entry in fs::read_dir(logs_dir)? {
        if let Err(error) = entry.and_then(|entry| prune_if_old(&entry, now)) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn prune_if_old(entry: &fs::DirEntry, now: SystemTime) -> io::Result<()> {
    let name = entry.file_name();
    let Some(archived) = name.to_str().and_then(archive_time) else {
        return Ok(());
    };
    // A name from the future (the clock was set back) is kept.
    let old = now
        .duration_since(archived)
        .is_ok_and(|age| age > MPV_LOG_KEPT);
    if old && entry.file_type()?.is_file() {
        fs::remove_file(entry.path())
    } else {
        Ok(())
    }
}

/// `mpv-20261017-120000.log`.
fn archive_name(at: SystemTime) -> String {
    let at = OffsetDateTime::from(at);
    format!(
        "mpv-{:04}{:02}{:02}-{:02}{:02}{:02}.log",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

/// The time in the name of an archive; `None` for any other name, and for a time before 1970,
/// which no archive of ours has: Windows' `SystemTime` starts in 1601, and the conversion
/// panics before that, so a hand-made `mpv-00010101-000000.log` must not get that far.
fn archive_time(name: &str) -> Option<SystemTime> {
    let stamp = name.strip_prefix("mpv-")?.strip_suffix(".log")?;
    // Digits only, which also keeps `parse` from taking a sign, and ASCII, so that slicing at
    // a fixed place cannot cut a character.
    let shape_ok = stamp.len() == 15
        && stamp.bytes().enumerate().all(|(at, byte)| {
            if at == 8 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    if !shape_ok {
        return None;
    }
    let two = |from: usize| stamp[from..from + 2].parse::<u8>().ok();
    let date = Date::from_calendar_date(
        stamp[..4].parse().ok()?,
        Month::try_from(two(4)?).ok()?,
        two(6)?,
    )
    .ok()?;
    let time = Time::from_hms(two(9)?, two(11)?, two(13)?).ok()?;
    let at = PrimitiveDateTime::new(date, time).assume_utc();
    (at >= OffsetDateTime::UNIX_EPOCH).then(|| at.into())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::UNIX_EPOCH;

    use super::*;

    /// 2026-10-17 12:00:00 UTC.
    fn noon() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_792_238_400)
    }

    fn write(dir: &Path, name: &str, contents: &str) {
        fs::write(dir.join(name), contents).unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn rotation_keeps_seven_days_of_mpv_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write(dir, "mpv.log", "the last run");
        // 1, 6 and 8 days before `noon`.
        write(dir, "mpv-20261016-120000.log", "yesterday");
        write(dir, "mpv-20261011-120000.log", "six days ago");
        write(dir, "mpv-20261009-120000.log", "eight days ago");

        rotate_mpv_log(dir, noon()).unwrap();

        assert_eq!(
            names(dir),
            [
                "mpv-20261011-120000.log",
                "mpv-20261016-120000.log",
                "mpv-20261017-120000.log",
            ]
        );
        // The log of the last run is the new archive, with its text.
        assert_eq!(
            fs::read_to_string(dir.join("mpv-20261017-120000.log")).unwrap(),
            "the last run"
        );
    }

    #[test]
    fn rotation_keeps_an_archive_that_is_exactly_seven_days_old() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "mpv-20261010-120000.log", "a week ago");
        write(tmp.path(), "mpv-20261010-115959.log", "a second more");

        rotate_mpv_log(tmp.path(), noon()).unwrap();

        // No mpv.log: nothing to archive.
        assert_eq!(names(tmp.path()), ["mpv-20261010-120000.log"]);
    }

    #[test]
    fn rotation_does_not_touch_files_that_are_not_mpv_archives() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let others = [
            "kaleido.2020-01-01.log",
            "mpv-notes.log",
            "mpv-20200101-120000.txt",
            "mpv-2020010-1200000.log",
            "mpv-+0200101-120000.log",
            "mpv-20201301-120000.log",
            // Before 1970: not ours, and too early for Windows' SystemTime (1601), whose
            // conversion would panic.
            "mpv-00010101-000000.log",
            "mpv-15000101-000000.log",
            "mpv-19691231-235959.log",
            "mpv.log.old",
            // From the future: the clock was wrong once.
            "mpv-20271017-120000.log",
        ];
        for name in others {
            write(dir, name, "x");
        }

        rotate_mpv_log(dir, noon()).unwrap();

        let mut expected = others.to_vec();
        expected.sort_unstable();
        assert_eq!(names(dir), expected);
    }

    #[test]
    fn archive_names_carry_the_time_and_read_back() {
        for (seconds, name) in [
            (0, "mpv-19700101-000000.log"),
            (951_782_400, "mpv-20000229-000000.log"),
            (1_792_238_400, "mpv-20261017-120000.log"),
            (4_107_542_399, "mpv-21000228-235959.log"),
            (4_107_542_400, "mpv-21000301-000000.log"),
        ] {
            let at = UNIX_EPOCH + Duration::from_secs(seconds);
            assert_eq!(archive_name(at), name);
            assert_eq!(archive_time(name), Some(at), "{name}");
        }
        // Before 1970 there is no archive, however well the name is formed.
        for name in [
            "mpv-00010101-000000.log",
            "mpv-15000101-000000.log",
            "mpv-19691231-235959.log",
        ] {
            assert_eq!(archive_time(name), None, "{name}");
        }
    }

    #[test]
    fn kaleido_log_is_written_to_the_logs_folder() {
        let tmp = tempfile::tempdir().unwrap();
        // Not created yet: the logger makes the folder when it has to.
        let logs = tmp.path().join("logs");

        let (logger, guard) = build(&logs).unwrap();
        // Only for this thread: `init` would install it for every test in the binary.
        tracing::dispatcher::with_default(&logger, || {
            tracing::info!("the player started");
            tracing::debug!("below the default level");
        });
        // Dropping the guard writes what is queued.
        drop(guard);

        let files: Vec<String> = names(&logs);
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(
            files[0].starts_with("kaleido.") && files[0].ends_with(".log"),
            "{}",
            files[0]
        );
        let text = fs::read_to_string(logs.join(&files[0])).unwrap();
        assert!(text.contains("the player started"), "{text}");
        assert!(text.contains("INFO"), "{text}");
        assert!(!text.contains("below the default level"), "{text}");
        // Plain text, no colour codes.
        assert!(!text.contains('\u{1b}'), "{text:?}");
    }
}
