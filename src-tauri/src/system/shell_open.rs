//! Opening a web address or a folder with the desktop's own programs (Ruling R51): the browser for
//! the roadmap and the source pages, the file manager for the logs folder.
//!
//! Kaleido runs in a kill-on-close job (`job.rs`), and a process it starts joins that job. Opened
//! from Kaleido's own process (`ShellExecuteExW`, the way tauri-plugin-opener does it), a browser
//! that was not running yet would start in the job and die with Kaleido, with every tab opened
//! since. So the target goes to `explorer.exe`, started with `CREATE_BREAKAWAY_FROM_JOB`, which the
//! job allows: explorer, and the browser or the folder window it opens, are outside the job.
//! Explorer is a GUI program, so there is no console window to keep away (`CREATE_NO_WINDOW` only
//! concerns console programs).
//!
//! The web addresses are fixed in Rust (Ruling R49): no command hands this module one from the UI.

use std::ffi::{OsStr, OsString};
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, MAX_PATH};
use windows::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;
use windows::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CreateProcessW, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    STARTUPINFOW,
};
use windows::core::{PCWSTR, PWSTR};

/// Opens `target`, a web address or a folder, the way a double click in Explorer does: in the
/// default browser, or in a folder window. Returns once explorer.exe has started; what it opens
/// comes a moment later, and what goes wrong there (no browser at all) is for Windows to say.
pub fn open(target: impl AsRef<OsStr>) -> anyhow::Result<()> {
    let target = target.as_ref();
    let windows_dir = windows_dir()?;
    let explorer = windows_dir.join("explorer.exe");
    let line = command_line(&[explorer.as_os_str(), target])?;
    let shown = target.to_string_lossy();
    // In the Windows folder, so that a folder window explorer keeps open does not hold Kaleido's
    // working folder (a USB stick the videos are on) in use.
    match start(&explorer, &line, CREATE_BREAKAWAY_FROM_JOB, &windows_dir) {
        Ok(_) => Ok(()),
        // Whoever started Kaleido may have put it in a job of theirs that lets no process break
        // away. It still opens, only inside Kaleido's job, as it did before Ruling R51.
        Err(error) if error.code() == E_ACCESSDENIED => {
            tracing::warn!("{shown} opens inside Kaleido's job, which cannot be left: {error}");
            start(&explorer, &line, PROCESS_CREATION_FLAGS(0), &windows_dir)
                .map(drop)
                .with_context(|| format!("cannot start explorer.exe for {shown}"))
        }
        Err(error) => Err(error).with_context(|| format!("cannot start explorer.exe for {shown}")),
    }
}

/// Windows' own folder (`C:\Windows`), where explorer.exe is. Asked of the system, not of the
/// environment, and explorer.exe is started by its full path: a program of that name in the
/// working folder or on `PATH` is never the one that runs.
fn windows_dir() -> anyhow::Result<PathBuf> {
    let mut buffer = [0u16; MAX_PATH as usize];
    // SAFETY: the call writes at most the length of the buffer it is given.
    let length = unsafe { GetSystemWindowsDirectoryW(Some(&mut buffer)) } as usize;
    if length == 0 || length >= buffer.len() {
        bail!("cannot find the Windows folder");
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

/// The command line of `args`, each in quotes, as UTF-16 with the closing NUL. A quote cannot be
/// inside a quoted argument, and a backslash just before the closing quote would escape it, so an
/// argument with either is refused, and so is an empty one (neither is in an address Kaleido
/// opens or in a folder it names).
fn command_line(args: &[&OsStr]) -> anyhow::Result<Vec<u16>> {
    let mut line = Vec::new();
    for arg in args {
        let wide: Vec<u16> = arg.encode_wide().collect();
        let refused = wide.is_empty()
            || wide.contains(&u16::from(b'"'))
            || wide.contains(&0)
            || wide.last() == Some(&u16::from(b'\\'));
        if refused {
            bail!("cannot pass {} to explorer.exe", arg.to_string_lossy());
        }
        if !line.is_empty() {
            line.push(u16::from(b' '));
        }
        line.push(u16::from(b'"'));
        line.extend(wide);
        line.push(u16::from(b'"'));
    }
    line.push(0);
    Ok(line)
}

/// Starts `application` with the command line `line` (UTF-16 with its NUL, the program first) and
/// `flags`, in `directory`, and returns the new process's handle. No handle of Kaleido's is
/// inherited.
fn start(
    application: &Path,
    line: &[u16],
    flags: PROCESS_CREATION_FLAGS,
    directory: &Path,
) -> windows::core::Result<OwnedHandle> {
    let wide = |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain([0]).collect() };
    let application = wide(application);
    let directory = wide(directory);
    // CreateProcessW may write into the command line, so it gets a copy of its own.
    let mut line = line.to_vec();
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: the strings end with a NUL and outlive the call; `startup` (with its size) and
    // `process` are the structs the call reads and fills.
    unsafe {
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            false,
            flags,
            None,
            PCWSTR(directory.as_ptr()),
            &startup,
            &mut process,
        )?;
        // Nothing waits for the thread; the process handle goes to the caller.
        let _ = CloseHandle(process.hThread);
        Ok(OwnedHandle::from_raw_handle(process.hProcess.0))
    }
}

#[cfg(test)]
mod tests {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    use windows::Win32::Foundation::{HANDLE, WAIT_TIMEOUT};
    use windows::Win32::System::JobObjects::IsProcessInJob;
    use windows::Win32::System::Threading::{
        CREATE_NO_WINDOW, GetCurrentProcess, TerminateProcess, WaitForSingleObject,
    };
    use windows::core::BOOL;

    use super::*;
    use crate::job::Job;

    const CHILD: &str = "system::shell_open::tests::child_in_a_kill_on_close_job";

    #[test]
    fn the_command_line_quotes_each_argument() {
        let line = command_line(&[
            OsStr::new(r"C:\Windows\explorer.exe"),
            OsStr::new(r"C:\Users\Jiří Novák\AppData\Local\Kaleido\logs"),
        ])
        .unwrap();
        assert_eq!(
            String::from_utf16(&line).unwrap(),
            "\"C:\\Windows\\explorer.exe\" \"C:\\Users\\Jiří Novák\\AppData\\Local\\Kaleido\\logs\"\0"
        );
        let url = command_line(&[
            OsStr::new("explorer.exe"),
            OsStr::new(crate::system::ROADMAP_URL),
        ])
        .unwrap();
        assert_eq!(
            String::from_utf16(&url).unwrap(),
            format!("\"explorer.exe\" \"{}\"\0", crate::system::ROADMAP_URL)
        );
    }

    /// What a pair of quotes cannot hold is refused, not passed on broken.
    #[test]
    fn the_command_line_refuses_what_quotes_cannot_hold() {
        for target in ["", "a\"b", r"C:\Videa\", "a\0b"] {
            assert!(
                command_line(&[OsStr::new("explorer.exe"), OsStr::new(target)]).is_err(),
                "{target:?}"
            );
        }
    }

    #[test]
    fn explorer_is_in_the_windows_folder() {
        let explorer = windows_dir().unwrap().join("explorer.exe");
        assert!(explorer.is_file(), "{}", explorer.display());
    }

    /// Ruling R51. The job is the one Kaleido puts itself in, so the test runs in a process of its
    /// own (`CHILD`): a test cannot put the whole test binary in a kill-on-close job.
    #[test]
    fn a_process_started_for_the_shell_is_outside_kaleidos_job() {
        let child = Command::new(std::env::current_exe().unwrap())
            .args([CHILD, "--exact", "--ignored", "--nocapture"])
            .output()
            .unwrap();
        let output = format!(
            "{}{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(child.status.success(), "{output}");
        // The child test ran, rather than being filtered out.
        assert!(output.contains("1 passed"), "{output}");
    }

    /// Whether `process` is in `job`.
    fn in_job(process: HANDLE, job: &Job) -> bool {
        let mut member = BOOL(0);
        // SAFETY: both handles are live; the call writes the answer into `member`.
        unsafe { IsProcessInJob(process, Some(job.handle()), &mut member) }.unwrap();
        member.as_bool()
    }

    #[test]
    #[ignore = "child process of a_process_started_for_the_shell_is_outside_kaleidos_job"]
    fn child_in_a_kill_on_close_job() {
        // The job `job::bind_children_to_this_process` makes, with the handle kept to ask about.
        let job = Job::kill_on_close().unwrap();
        // SAFETY: the pseudo handle of the current process is always valid.
        job.assign(unsafe { GetCurrentProcess() }).unwrap();
        let windows = windows_dir().unwrap();
        let cmd = windows.join("System32").join("cmd.exe");
        // Something harmless that runs long enough to be asked about, without a window.
        let waits = ["/c", "ping -n 30 127.0.0.1 >NUL"];

        // A child started the usual way (as mpv starts kaleido-mpv) is in the job.
        let mut usual = Command::new(&cmd)
            .args(waits)
            .creation_flags(CREATE_NO_WINDOW.0)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let usual_in_job = in_job(HANDLE(usual.as_raw_handle()), &job);
        let _ = usual.kill();
        assert!(
            usual_in_job,
            "a child started the usual way is not in the job"
        );

        // One started the way `open` starts explorer.exe is not.
        let mut line = command_line(&[cmd.as_os_str()]).unwrap();
        line.pop();
        line.extend(OsStr::new(&format!(" {} {}", waits[0], waits[1])).encode_wide());
        line.push(0);
        let started = start(
            &cmd,
            &line,
            CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW,
            &windows,
        )
        .unwrap();
        let process = HANDLE(started.as_raw_handle());
        // SAFETY: a live process handle; 0 ms only asks.
        let running = unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT;
        let outside = !in_job(process, &job);
        // SAFETY: the handle has every right on the process it started.
        let _ = unsafe { TerminateProcess(process, 0) };
        assert!(running, "it ended before it was asked about");
        assert!(outside, "a process that broke away is still in the job");

        // Closing the job's handle would end this process with the job.
        std::mem::forget(job);
    }
}
