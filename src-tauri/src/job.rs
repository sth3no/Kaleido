//! A Windows Job Object that ends every process in it when its last handle closes. Kaleido puts
//! itself in one at startup, so the helpers it starts (mpv helper, yt-dlp, ...) never outlive
//! the app, however the app ends (crash, kill from Task Manager, power-off of the session).
//!
//! A process may leave the job only by asking for it (`CREATE_BREAKAWAY_FROM_JOB`, allowed by
//! `JOB_OBJECT_LIMIT_BREAKAWAY_OK`): the desktop shell Kaleido starts to open a link or a folder
//! does (`system::shell_open`, Ruling R51), so the user's browser does not die with Kaleido. The
//! job does not let processes go silently (`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`): the helpers
//! mpv starts (kaleido-mpv for thumbfast, yt-dlp) never ask, so they stay in it.

use std::ffi::c_void;
use std::mem::size_of;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows::Win32::System::Threading::GetCurrentProcess;
use windows::core::{PCWSTR, Result};

/// Owns the job handle; closing it (drop, or the end of the owning process) kills the members.
pub struct Job(HANDLE);

impl Job {
    /// A new, empty job whose members are killed when the job handle is closed. A process
    /// started with `CREATE_BREAKAWAY_FROM_JOB` is not a member (see the top of the file).
    pub fn kill_on_close() -> Result<Job> {
        // SAFETY: plain Win32 calls; the limit struct outlives the call and its size is passed.
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null())?;
            // From here on `job` owns the handle, so an error below still closes it.
            let job = Job(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )?;
            Ok(job)
        }
    }

    /// Puts `process` (a handle with `PROCESS_SET_QUOTA | PROCESS_TERMINATE` access) in the job.
    /// Processes it starts later join the job too.
    pub fn assign(&self, process: HANDLE) -> Result<()> {
        // SAFETY: `self.0` is a live job handle; the OS validates `process`.
        unsafe { AssignProcessToJobObject(self.0, process) }
    }

    /// The job handle, for the tests that ask whether a process is in it.
    #[cfg(test)]
    pub(crate) fn handle(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a handle this value owns and closes only here.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Makes every process started from now on die with this one: creates a kill-on-close job, puts
/// the current process in it and leaves the handle open until the process ends. The OS then
/// closes it, which kills whatever is still running. Call once, early in `run`.
pub fn bind_children_to_this_process() -> Result<()> {
    let job = Job::kill_on_close()?;
    // SAFETY: the pseudo handle of the current process is always valid.
    job.assign(unsafe { GetCurrentProcess() })?;
    // Not dropped on purpose: closing the handle here would kill us along with the children.
    std::mem::forget(job);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::HANDLE;

    use super::Job;

    #[test]
    fn dropping_the_job_kills_assigned_processes() {
        let mut child = Command::new("cmd")
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let job = Job::kill_on_close().unwrap();
        job.assign(HANDLE(child.as_raw_handle())).unwrap();
        assert!(child.try_wait().unwrap().is_none(), "child ended early");

        drop(job);

        let deadline = Instant::now() + Duration::from_secs(2);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("child survived the job being closed");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
