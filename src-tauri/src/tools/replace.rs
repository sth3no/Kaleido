//! Putting a new `yt-dlp.exe` or `deno.exe` in place while the old one may run (spec 6.6): Windows
//! does not delete or overwrite an executable that runs, but it does rename it. So the new one is
//! written beside it as `<name>.new`, the old one is renamed to `<name>.old-<nanos>`, and the new
//! one takes its name. A process that runs the old one keeps running it; the next one starts the
//! new one. The old file goes at once when nothing runs it, and otherwise at a later [`sweep`].

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// What the old file of a replace is called after `<name>`.
const OLD_MARK: &str = ".old-";

/// Replaces `dir\<name>` with `bytes` (see the module); `dir` must be there. On an error the file
/// that was there before is still there under its name, and no `<name>.new` is left.
pub fn replace_binary(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let target = dir.join(name);
    let new = dir.join(format!("{name}.new"));
    // Left by a replace that did not finish (the app ended): never run, never the only copy.
    if let Err(error) = fs::remove_file(&new)
        && error.kind() != io::ErrorKind::NotFound
    {
        return Err(error);
    }
    if let Err(error) = write_new(&new, bytes) {
        let _ = fs::remove_file(&new);
        return Err(error);
    }
    let old = match fs::symlink_metadata(&target) {
        Ok(_) => {
            let old = dir.join(format!("{name}{OLD_MARK}{}", nanos()));
            if let Err(error) = fs::rename(&target, &old) {
                let _ = fs::remove_file(&new);
                return Err(error);
            }
            Some(old)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            let _ = fs::remove_file(&new);
            return Err(error);
        }
    };
    if let Err(error) = fs::rename(&new, &target) {
        if let Some(old) = &old
            && let Err(back) = fs::rename(old, &target)
        {
            tracing::error!(
                "cannot put {} back after a failed replace ({back}); it is {}",
                target.display(),
                old.display()
            );
        }
        let _ = fs::remove_file(&new);
        return Err(error);
    }
    if let Some(old) = old {
        // Fails while it runs: the sweep takes it later.
        let _ = fs::remove_file(old);
    }
    Ok(())
}

/// Deletes the old files of earlier replaces in `dir` (`<name>.old-<digits>`, of any name) that
/// can be deleted; the ones that still run stay. Returns those that stayed, sorted. For a time no
/// replace runs (the start); during one, [`sweep_of`] its own name only.
pub fn sweep(dir: &Path) -> Vec<PathBuf> {
    sweep_where(dir, |file| {
        file.rsplit_once(OLD_MARK)
            .is_some_and(|(base, stamp)| !base.is_empty() && is_stamp(stamp))
    })
}

/// [`sweep`] of the old files of `name` only (`<name>.old-<digits>`): what a replace of `name`
/// may clear, while a replace of another tool may be between its two renames and need its old
/// file back.
pub fn sweep_of(dir: &Path, name: &str) -> Vec<PathBuf> {
    sweep_where(dir, |file| {
        file.strip_prefix(name)
            .and_then(|rest| rest.strip_prefix(OLD_MARK))
            .is_some_and(is_stamp)
    })
}

fn sweep_where(dir: &Path, old: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut kept = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(&old) {
            continue;
        }
        let path = entry.path();
        if fs::remove_file(&path).is_err() {
            kept.push(path);
        }
    }
    kept.sort();
    kept
}

/// Whether `stamp` is the `<digits>` [`replace_binary`] puts after [`OLD_MARK`].
fn is_stamp(stamp: &str) -> bool {
    !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit())
}

/// `bytes` into the new file `path`, through to the disk: the rename into place must not move a
/// file that is not all there.
fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names of the files in `dir`, sorted.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_replace_puts_the_new_bytes_in_place_and_leaves_one_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        replace_binary(dir, "yt-dlp.exe", b"first").unwrap();
        assert_eq!(fs::read(dir.join("yt-dlp.exe")).unwrap(), b"first");
        assert_eq!(names(dir), ["yt-dlp.exe"]);

        // Nothing runs the old one: it goes at once.
        replace_binary(dir, "yt-dlp.exe", b"second").unwrap();
        assert_eq!(fs::read(dir.join("yt-dlp.exe")).unwrap(), b"second");
        assert_eq!(names(dir), ["yt-dlp.exe"]);

        // A `.new` a replace left behind is not in the way, and other files are not touched.
        fs::write(dir.join("yt-dlp.exe.new"), "half").unwrap();
        fs::write(dir.join("deno.exe"), "deno").unwrap();
        replace_binary(dir, "yt-dlp.exe", b"third").unwrap();
        assert_eq!(fs::read(dir.join("yt-dlp.exe")).unwrap(), b"third");
        assert_eq!(names(dir), ["deno.exe", "yt-dlp.exe"]);

        // A folder that is not there: an error, and nothing made.
        let missing = dir.join("missing");
        assert!(replace_binary(&missing, "yt-dlp.exe", b"x").is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn sweep_takes_only_old_files_of_replaces() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for name in [
            "yt-dlp.exe.old-1",
            "deno.exe.old-17923456789",
            "yt-dlp.exe",
            "tools.json",
            "yt-dlp.exe.old-",
            "yt-dlp.exe.old-x1",
            ".old-1",
            "yt-dlp.exe.new",
        ] {
            fs::write(dir.join(name), name).unwrap();
        }
        assert!(sweep(dir).is_empty());
        assert_eq!(
            names(dir),
            [
                ".old-1",
                "tools.json",
                "yt-dlp.exe",
                "yt-dlp.exe.new",
                "yt-dlp.exe.old-",
                "yt-dlp.exe.old-x1",
            ]
        );
        assert!(sweep(&dir.join("missing")).is_empty());
    }

    /// A replace of one tool clears its own old files only: the other tool's may be the one its
    /// replace needs to put back.
    #[test]
    fn sweep_of_a_name_takes_only_its_old_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for name in [
            "yt-dlp.exe.old-1",
            "yt-dlp.exe.old-2",
            "deno.exe.old-3",
            "yt-dlp.exe",
            "yt-dlp.exe.old-x",
            "xyt-dlp.exe.old-4",
        ] {
            fs::write(dir.join(name), name).unwrap();
        }
        assert!(sweep_of(dir, "yt-dlp.exe").is_empty());
        assert_eq!(
            names(dir),
            [
                "deno.exe.old-3",
                "xyt-dlp.exe.old-4",
                "yt-dlp.exe",
                "yt-dlp.exe.old-x",
            ]
        );
        assert!(sweep_of(dir, "deno.exe").is_empty());
        assert_eq!(
            names(dir),
            ["xyt-dlp.exe.old-4", "yt-dlp.exe", "yt-dlp.exe.old-x"]
        );
        assert!(sweep_of(&dir.join("missing"), "deno.exe").is_empty());
    }

    /// Review focus 3: yt-dlp.exe runs (ytdl_hook or a quality probe started it) while a new one
    /// comes. A copy of cmd.exe stands in for it, kept busy by `ping` for about four seconds.
    #[cfg(windows)]
    #[test]
    fn the_exe_is_replaced_while_the_old_one_runs() {
        use std::os::windows::process::CommandExt;
        use std::process::{Child, Command, Stdio};

        use windows::Win32::System::Threading::CREATE_NO_WINDOW;

        /// Kills the stand-in when the test fails half-way, so that no process is left.
        struct Running(Child);
        impl Drop for Running {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("tools");
        fs::create_dir(&dir).unwrap();
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let cmd = Path::new(&system_root).join("System32").join("cmd.exe");
        let exe = dir.join("yt-dlp.exe");
        fs::copy(&cmd, &exe).unwrap();
        let original = fs::read(&exe).unwrap();
        let mut running = Running(
            Command::new(&exe)
                .args(["/c", "ping", "-n", "5", "127.0.0.1"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW.0)
                .spawn()
                .unwrap(),
        );
        // A running executable cannot be deleted: the stand-in holds its file.
        assert!(
            fs::remove_file(&exe).is_err(),
            "the old one must be running"
        );

        replace_binary(&dir, "yt-dlp.exe", b"the new yt-dlp").unwrap();

        assert_eq!(fs::read(&exe).unwrap(), b"the new yt-dlp");
        assert!(running.0.try_wait().unwrap().is_none(), "still running");
        let olds: Vec<String> = names(&dir)
            .into_iter()
            .filter(|name| name.starts_with("yt-dlp.exe.old-"))
            .collect();
        assert_eq!(olds.len(), 1, "{olds:?}");
        let old = dir.join(&olds[0]);
        assert_eq!(fs::read(&old).unwrap(), original);
        assert!(!dir.join("yt-dlp.exe.new").exists());
        // While it runs, the sweep leaves it.
        assert_eq!(sweep(&dir), std::slice::from_ref(&old));
        assert!(old.exists());

        assert!(running.0.wait().unwrap().success());
        // Windows (or a virus scanner looking at the file) may let go of the image a moment
        // after the process ends: the sweep is tried again for up to five seconds.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !sweep(&dir).is_empty() {
            assert!(
                std::time::Instant::now() < deadline,
                "{} is still there after the process ended",
                old.display()
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(names(&dir), ["yt-dlp.exe"]);
        assert_eq!(fs::read(&exe).unwrap(), b"the new yt-dlp");
    }
}
