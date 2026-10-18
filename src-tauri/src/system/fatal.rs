//! A start that fails, told where the user sees it (spec 10.1: nothing fails silently; Ruling
//! R53): the setup logs the whole chain of causes, and a message box says what failed and names
//! the logs folder. Tauri turns a failed setup into a panic whose message goes to stderr, which a
//! release build does not have: without this, a failed start is a window that flashes and goes.
//!
//! A panic on the main thread before the start is complete (the main window or WebView2 could not
//! be made, before the setup runs) is a failed start too; the panic hook (`logs`) says so here.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::thread;

use windows::Win32::UI::WindowsAndMessaging::{
    MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW,
};
use windows::core::{HSTRING, w};

/// The setup has finished: a panic from now on is no failed start.
static STARTED: AtomicBool = AtomicBool::new(false);
/// A failed start was shown: the panic Tauri raises for the same failure is not shown again.
static SHOWN: AtomicBool = AtomicBool::new(false);
/// The logs folder, once the log is being written there.
static LOGS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The language of the message box: the UI's own setting is not read yet, so Windows' language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Czech,
    English,
}

impl Language {
    /// Czech for a Czech Windows, English for any other (spec 8.8).
    fn of_the_system() -> Language {
        match sys_locale::get_locale() {
            Some(locale) if locale.to_ascii_lowercase().starts_with("cs") => Language::Czech,
            _ => Language::English,
        }
    }
}

/// The log is written to `dir` from now on: a failed start names the folder.
pub fn logging_to(dir: &Path) {
    *LOGS_DIR.lock().unwrap_or_else(PoisonError::into_inner) = Some(dir.to_path_buf());
}

/// The setup is done.
pub fn started() {
    STARTED.store(true, Ordering::SeqCst);
}

/// `error` with every cause after it, as the log and the message box say it:
/// `cannot start the player: cannot load libmpv: …`.
pub fn describe(error: &anyhow::Error) -> String {
    format!("{error:#}")
}

/// The start failed for `reason` (see [`describe`]): shows the message box, once, and returns when
/// the user has closed it. Logging the reason is the caller's, before, so that the log holds it
/// when the user looks.
pub fn start_failed(reason: &str) {
    if SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    let logs = LOGS_DIR
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    show(&start_failure_text(
        Language::of_the_system(),
        reason,
        logs.as_deref(),
    ));
}

/// From the panic hook: a panic with `message`, on the main thread or not.
pub fn on_panic(main_thread: bool, message: &str) {
    if main_thread && !STARTED.load(Ordering::SeqCst) {
        start_failed(message);
    }
}

/// What the message box says: that Kaleido did not start, why, and where the log is (`logs`, none
/// when nothing could be logged).
pub fn start_failure_text(language: Language, reason: &str, logs: Option<&Path>) -> String {
    let (headline, where_to_look) = match language {
        Language::Czech => (
            "Kaleido se nepodařilo spustit.",
            "Podrobnosti jsou v logu ve složce:",
        ),
        Language::English => (
            "Kaleido could not start.",
            "The details are in the log in this folder:",
        ),
    };
    match logs {
        Some(dir) => format!(
            "{headline}\n\n{reason}\n\n{where_to_look}\n{}",
            dir.display()
        ),
        None => format!("{headline}\n\n{reason}"),
    }
}

/// A native message box with `text`, on a thread of its own: its message loop must not run the
/// main thread's windows in the middle of a failed start or a panic. Never in the tests, where
/// nobody would close it.
fn show(text: &str) {
    if cfg!(test) {
        return;
    }
    let text = HSTRING::from(text);
    let shown = thread::Builder::new()
        .name("start-failure".into())
        .spawn(move || {
            // SAFETY: both strings end with a NUL and outlive the call; no owner window.
            unsafe {
                MessageBoxW(
                    None,
                    &text,
                    w!("Kaleido"),
                    MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST,
                )
            };
        });
    match shown {
        Ok(thread) => {
            let _ = thread.join();
        }
        Err(error) => tracing::error!("cannot show why Kaleido did not start: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use anyhow::Context;

    use super::*;

    /// A failed start of the player, as `Engine::start` without libmpv-2.dll reports it.
    fn without_libmpv() -> anyhow::Error {
        Err::<(), _>(io::Error::new(
            io::ErrorKind::NotFound,
            "LoadLibraryExW failed: libmpv-2.dll",
        ))
        .context("cannot load libmpv")
        .context("cannot start the player")
        .unwrap_err()
    }

    #[test]
    fn the_reason_keeps_the_whole_chain_of_causes() {
        assert_eq!(
            describe(&without_libmpv()),
            "cannot start the player: cannot load libmpv: LoadLibraryExW failed: libmpv-2.dll"
        );
    }

    #[test]
    fn the_message_says_why_and_where_the_log_is() {
        let reason = describe(&without_libmpv());
        let logs = Path::new(r"C:\Users\Jiří\AppData\Local\Kaleido\logs");

        let english = start_failure_text(Language::English, &reason, Some(logs));
        assert_eq!(
            english,
            format!(
                "Kaleido could not start.\n\n{reason}\n\nThe details are in the log in this \
                 folder:\nC:\\Users\\Jiří\\AppData\\Local\\Kaleido\\logs"
            )
        );
        let czech = start_failure_text(Language::Czech, &reason, Some(logs));
        assert!(
            czech.starts_with("Kaleido se nepodařilo spustit."),
            "{czech}"
        );
        assert!(czech.contains(&reason), "{czech}");
        assert!(
            czech.ends_with(r"C:\Users\Jiří\AppData\Local\Kaleido\logs"),
            "{czech}"
        );

        // Before the log is written anywhere, no folder is named.
        assert_eq!(
            start_failure_text(Language::English, &reason, None),
            format!("Kaleido could not start.\n\n{reason}")
        );
    }

    /// The tests never show the box (`show` returns at once), so this would return either way.
    #[test]
    fn a_panic_off_the_main_thread_is_no_failed_start() {
        on_panic(false, "a helper thread");
        assert!(!SHOWN.load(Ordering::SeqCst));
    }
}
