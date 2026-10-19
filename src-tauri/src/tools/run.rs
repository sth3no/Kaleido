//! Running the managed tools (spec 6.6): only Rust starts yt-dlp and Deno, without a shell
//! (`std::process::Command`, never `cmd /c`), without a console window (`CREATE_NO_WINDOW`), with
//! nothing on their stdin, and as children in Kaleido's Job Object (M1), so they end with it.
//!
//! [`run`] waits for one with a time limit and a limit on what it may write. Each run is in a Job
//! Object of its own as well, which [`run`] closes when it is done: `yt-dlp.exe` is a PyInstaller
//! program whose first process starts a second one (the bootloader puts it in no job, checked in
//! PyInstaller's `bootloader/src/pyi_utils_win32.c` on 2026-10-19), and that second one holds the
//! pipes. Killing the first alone would leave the second running, and its pipes open.
//!
//! [`Processes`] reads the tools' versions from their `--version` ([`Inspect`]), and
//! [`deno_supported`] says whether a Deno is new enough for yt-dlp (plan decision 20).

use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

use super::{Inspect, ToolId};
use crate::job::Job;

/// How much of what a tool writes to stderr is kept: its end, where yt-dlp puts its `ERROR:`.
pub const STDERR_LIMIT: usize = 64 * 1024;
/// How long `--version` may take: a first start of `yt-dlp.exe` unpacks itself, and a virus
/// scanner may look at it first.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(30);
/// The most `--version` may write.
pub const VERSION_LIMIT: usize = 64 * 1024;
/// The oldest Deno yt-dlp can solve YouTube's challenges with (plan decision 20).
pub const DENO_MINIMUM: [u64; 3] = [2, 3, 0];
/// [`DENO_MINIMUM`] as people read it.
pub const DENO_MINIMUM_TEXT: &str = "2.3.0";

/// How long a process may wait between closing its output and ending, when it is not told to.
const EXIT_POLL: Duration = Duration::from_millis(10);
/// How much a reader takes from a pipe at a time.
const CHUNK: usize = 16 * 1024;

/// What a tool that ended well wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    /// All of its stdout (at most the limit [`run`] was given).
    pub stdout: Vec<u8>,
    /// The end of its stderr ([`STDERR_LIMIT`]), as text.
    pub stderr: String,
}

/// Why [`run`] has no output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// It could not be started: no such file, no permission, not a program.
    Spawn(String),
    /// It ran for longer than it may and was killed.
    Timeout,
    /// It wrote more to stdout than it may and was killed.
    TooLarge,
    /// It ended with an error: its exit code (`None` where it has none) and the end of its
    /// stderr.
    Exit { code: Option<i32>, stderr: String },
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunError::Spawn(message) => write!(f, "it cannot be started: {message}"),
            RunError::Timeout => f.write_str("it took too long and was stopped"),
            RunError::TooLarge => f.write_str("it wrote more than it may and was stopped"),
            RunError::Exit {
                code: Some(code),
                stderr,
            } => write!(f, "it ended with code {code}: {}", stderr.trim()),
            RunError::Exit { code: None, stderr } => write!(f, "it ended: {}", stderr.trim()),
        }
    }
}

impl std::error::Error for RunError {}

/// Runs `exe` with `args` (each one argument as it is, nothing a shell would read) and waits for
/// it, at most `timeout`; it may write at most `stdout_limit` bytes to stdout. stdout and stderr
/// are read on threads of their own, so that neither pipe fills up and holds the tool; the caller
/// waits for them to close, for stdout to pass its limit, or for the time to run out. A tool that
/// runs too long or writes too much is killed with what it started ([`RunError::Timeout`],
/// [`RunError::TooLarge`]); one that ends with an exit code other than 0 is
/// [`RunError::Exit`]. Blocks: not for the main thread.
pub fn run(
    exe: &Path,
    args: &[OsString],
    timeout: Duration,
    stdout_limit: usize,
) -> Result<Output, RunError> {
    let deadline = Instant::now() + timeout;
    let mut child = Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn()
        .map_err(|error| RunError::Spawn(error.to_string()))?;
    // Closed (and what is still in it killed) when this function returns, however it does.
    let tree = own_job(&child);

    let (sender, pieces) = mpsc::channel();
    let readers = [
        reader(child.stdout.take(), Stream::Stdout, stdout_limit, &sender),
        reader(child.stderr.take(), Stream::Stderr, STDERR_LIMIT, &sender),
    ];
    drop(sender);
    if let Some(Err(error)) = readers.into_iter().find(Result::is_err) {
        stop(&mut child, tree);
        return Err(RunError::Spawn(format!("cannot read its output: {error}")));
    }

    let mut stdout = None;
    let mut stderr = None;
    while stdout.is_none() || stderr.is_none() {
        let left = deadline.saturating_duration_since(Instant::now());
        match pieces.recv_timeout(left) {
            Ok(Piece::Done(Stream::Stdout, bytes)) => stdout = Some(bytes),
            Ok(Piece::Done(Stream::Stderr, bytes)) => stderr = Some(bytes),
            Ok(Piece::TooLarge) => {
                stop(&mut child, tree);
                return Err(RunError::TooLarge);
            }
            Err(RecvTimeoutError::Timeout) => {
                stop(&mut child, tree);
                return Err(RunError::Timeout);
            }
            // Both readers are gone without a word (they panicked): what they had is lost.
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    // Its output is closed: it has ended, or ends now.
    let Some(status) = exit_by(&mut child, deadline)? else {
        stop(&mut child, tree);
        return Err(RunError::Timeout);
    };
    drop(tree);
    let stderr = text_of(&stderr.unwrap_or_default());
    if status.success() {
        Ok(Output {
            stdout: stdout.unwrap_or_default(),
            stderr,
        })
    } else {
        Err(RunError::Exit {
            code: status.code(),
            stderr,
        })
    }
}

/// The child in a kill-on-close job of its own, so that what it starts can be killed with it.
/// `None` (logged) where the job cannot be made: then only the child itself is killed.
fn own_job(child: &Child) -> Option<Job> {
    let job = Job::kill_on_close()
        .inspect_err(|error| tracing::warn!("no job for a tool's process: {error}"))
        .ok()?;
    job.assign(HANDLE(child.as_raw_handle()))
        .inspect_err(|error| tracing::warn!("a tool's process is not in its job: {error}"))
        .ok()?;
    Some(job)
}

/// Kills the child and what it started, and waits for it to be gone. The readers are left: they
/// end as soon as the pipes close.
fn stop(child: &mut Child, tree: Option<Job>) {
    // Closing the job kills every process in it.
    drop(tree);
    // Fails when it has ended already, which is what is wanted.
    let _ = child.kill();
    let _ = child.wait();
}

/// The child's exit status, waiting until `deadline` at most; `None` when it still runs then.
fn exit_by(child: &mut Child, deadline: Instant) -> Result<Option<ExitStatus>, RunError> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) if Instant::now() >= deadline => return Ok(None),
            // It closed its output a moment before it ends, as a process does.
            Ok(None) => thread::sleep(EXIT_POLL),
            Err(error) => return Err(RunError::Spawn(format!("cannot wait for it: {error}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stream {
    Stdout,
    Stderr,
}

/// What a reader tells [`run`].
enum Piece {
    /// The pipe closed: what was kept of it.
    Done(Stream, Vec<u8>),
    /// stdout passed its limit.
    TooLarge,
}

/// Reads `pipe` on a thread of its own until it closes. stdout keeps its first `limit` bytes and
/// says so the moment more comes; stderr keeps its last `limit` bytes. Both read on to the end, so
/// that the tool never waits for a full pipe.
fn reader(
    pipe: Option<impl Read + Send + 'static>,
    stream: Stream,
    limit: usize,
    sender: &mpsc::Sender<Piece>,
) -> io::Result<()> {
    let sender = sender.clone();
    let name = match stream {
        Stream::Stdout => "tool-stdout",
        Stream::Stderr => "tool-stderr",
    };
    let Some(mut pipe) = pipe else {
        // Not piped: nothing to read.
        let _ = sender.send(Piece::Done(stream, Vec::new()));
        return Ok(());
    };
    thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let mut kept = Vec::new();
            let mut chunk = vec![0u8; CHUNK];
            let mut over = false;
            loop {
                let read = match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    // A broken pipe is its end.
                    Err(_) => break,
                };
                match stream {
                    Stream::Stdout => {
                        let room = limit.saturating_sub(kept.len());
                        kept.extend_from_slice(&chunk[..read.min(room)]);
                        if read > room && !over {
                            over = true;
                            // The caller may be gone already (it timed out); then nobody listens.
                            let _ = sender.send(Piece::TooLarge);
                        }
                    }
                    Stream::Stderr => {
                        kept.extend_from_slice(&chunk[..read]);
                        // Cut back now and then, not at every chunk.
                        if kept.len() > limit.saturating_mul(2) {
                            kept.drain(..kept.len() - limit);
                        }
                    }
                }
            }
            if stream == Stream::Stderr && kept.len() > limit {
                kept.drain(..kept.len() - limit);
            }
            let _ = sender.send(Piece::Done(stream, kept));
        })
        .map(|_| ())
}

/// stderr as text: a tool writes UTF-8, or what the console's code page makes of it.
fn text_of(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        // Where the end was cut in the middle of a character.
        .trim_start_matches('\u{fffd}')
        .to_owned()
}

/// Reads a tool's version with its `--version` (the real [`Inspect`]).
pub struct Processes;

impl Inspect for Processes {
    fn version(&self, tool: ToolId, exe: &Path) -> Option<String> {
        let output = run(
            exe,
            &[OsString::from("--version")],
            VERSION_TIMEOUT,
            VERSION_LIMIT,
        )
        .inspect_err(|error| tracing::warn!("cannot read the version of {tool}: {error}"))
        .ok()?;
        let version = parse_version(tool, &String::from_utf8_lossy(&output.stdout));
        if version.is_none() {
            tracing::warn!("{tool} --version says no version that can be read");
        }
        version
    }
}

/// The version in what `--version` wrote: yt-dlp writes only its version (`2026.10.10`, the
/// nightly builds `2026.10.10.233141`), Deno `deno 2.5.4 (stable, release,
/// x86_64-pc-windows-msvc)` and then the versions of V8 and TypeScript. `None` for anything else.
pub fn parse_version(tool: ToolId, stdout: &str) -> Option<String> {
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let version = match tool {
        ToolId::YtDlp => line.split_whitespace().next()?,
        ToolId::Deno => line.strip_prefix("deno ")?.split_whitespace().next()?,
    };
    let plausible = version.len() <= 64
        && version.starts_with(|c: char| c.is_ascii_digit())
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'));
    plausible.then(|| version.to_owned())
}

/// Whether a Deno of `version` is one yt-dlp can use: [`DENO_MINIMUM`] or newer (plan decision
/// 20). `X.Y.Z` or `X.Y`, with a `v` in front or a pre-release after it; a version that cannot be
/// read is not new enough, so that a Deno that may be too old is never handed to yt-dlp.
pub fn deno_supported(version: &str) -> bool {
    deno_parts(version).is_some_and(|parts| parts >= DENO_MINIMUM)
}

/// `[major, minor, patch]` of a Deno version.
fn deno_parts(version: &str) -> Option<[u64; 3]> {
    let version = version.trim();
    let version = version.strip_prefix('v').unwrap_or(version);
    let core = version.split(['-', '+']).next()?;
    let numbers: Vec<&str> = core.split('.').collect();
    if !(2..=3).contains(&numbers.len()) {
        return None;
    }
    let mut parts = [0; 3];
    for (part, number) in parts.iter_mut().zip(&numbers) {
        if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *part = number.parse().ok()?;
    }
    Some(parts)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// Windows' own cmd.exe, as a tool that is there on every machine. Run directly, never as a
    /// shell for the code (shared constraints): here it stands in for a tool.
    fn cmd_exe() -> PathBuf {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        PathBuf::from(root).join("System32").join("cmd.exe")
    }

    fn args(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn versions_are_read_from_their_output() {
        assert_eq!(
            parse_version(ToolId::YtDlp, "2026.10.10\n").as_deref(),
            Some("2026.10.10")
        );
        assert_eq!(
            parse_version(ToolId::YtDlp, "2026.10.10.233141\r\n").as_deref(),
            Some("2026.10.10.233141")
        );
        assert_eq!(
            parse_version(
                ToolId::Deno,
                "deno 2.5.4 (stable, release, x86_64-pc-windows-msvc)\nv8 14.0.365.4-rusty\ntypescript 5.9.2\n"
            )
            .as_deref(),
            Some("2.5.4")
        );
        assert_eq!(
            parse_version(
                ToolId::Deno,
                "\r\ndeno 2.9.7 (stable, release, x86_64-pc-windows-msvc)\r\n"
            )
            .as_deref(),
            Some("2.9.7")
        );
        // Nothing that reads as a version.
        for (tool, stdout) in [
            (ToolId::YtDlp, ""),
            (ToolId::YtDlp, "\n\n"),
            (ToolId::YtDlp, "Usage: yt-dlp [OPTIONS] URL\n"),
            (ToolId::YtDlp, "C:\\Users\\a\\yt-dlp.exe\n"),
            (ToolId::Deno, "2.5.4\n"),
            (ToolId::Deno, "deno\n"),
            (ToolId::Deno, "deno upgrade available\n"),
        ] {
            assert_eq!(parse_version(tool, stdout), None, "{tool}: {stdout:?}");
        }
    }

    #[test]
    fn deno_versions_are_compared_as_numbers() {
        for (version, supported) in [
            ("2.2.9", false),
            ("2.3.0", true),
            ("2.9.7", true),
            ("2.10.0", true),
            ("3.0.0", true),
            ("1.46.3", false),
            ("v2.9.7", true),
            ("2.3", true),
            ("2.3.0-rc.1", true),
            ("x", false),
            ("", false),
            ("2", false),
            ("2.3.0.1", false),
            ("2..0", false),
            ("2.x.0", false),
        ] {
            assert_eq!(deno_supported(version), supported, "{version:?}");
        }
    }

    /// Spawns cmd.exe (with ping.exe under it) without a window; no network beyond the loopback.
    #[test]
    fn a_hung_process_is_killed_at_the_timeout() {
        let started = Instant::now();

        let result = run(
            &cmd_exe(),
            &args(&["/c", "ping", "-n", "30", "127.0.0.1"]),
            Duration::from_millis(500),
            64 * 1024,
        );

        assert_eq!(result, Err(RunError::Timeout));
        // ping.exe, cmd's child, holds the pipes: the run waits for neither.
        let took = started.elapsed();
        assert!(took < Duration::from_secs(2), "{took:?}");
    }

    /// Spawns cmd.exe without a window.
    #[test]
    fn output_exit_codes_and_limits_come_back() {
        let output = run(
            &cmd_exe(),
            &args(&["/c", "echo", "kaleido"]),
            Duration::from_secs(10),
            1024,
        )
        .unwrap();
        assert_eq!(output.stdout, b"kaleido\r\n");
        assert_eq!(output.stderr, "");

        // An error: its code and what it wrote to stderr.
        let failed = run(
            &cmd_exe(),
            &args(&["/c", "echo", "it went wrong", "1>&2", "&", "exit", "3"]),
            Duration::from_secs(10),
            1024,
        );
        match failed {
            Err(RunError::Exit {
                code: Some(3),
                stderr,
            }) => assert!(stderr.contains("it went wrong"), "{stderr:?}"),
            other => panic!("{other:?}"),
        }

        // One byte more than it may: stopped.
        assert_eq!(
            run(
                &cmd_exe(),
                &args(&["/c", "echo", "0123456789"]),
                Duration::from_secs(10),
                11,
            ),
            Err(RunError::TooLarge)
        );
        // Exactly the limit (ten digits and CRLF) is fine.
        assert_eq!(
            run(
                &cmd_exe(),
                &args(&["/c", "echo", "0123456789"]),
                Duration::from_secs(10),
                12,
            )
            .unwrap()
            .stdout,
            b"0123456789\r\n"
        );

        // A tool that is not there.
        let tmp = tempfile::tempdir().unwrap();
        assert!(matches!(
            run(
                &tmp.path().join("yt-dlp.exe"),
                &[],
                Duration::from_secs(10),
                1024
            ),
            Err(RunError::Spawn(_))
        ));
    }
}
