//! Kaleido: the Tauri shell around libmpv.

pub mod job;
pub mod paths;

use tauri::Manager;

pub fn run() {
    // Before anything is spawned, so every child process is covered.
    if let Err(error) = job::bind_children_to_this_process() {
        // There is no log file yet; a stray helper after a crash is not worth refusing to start.
        eprintln!("Kaleido: child processes will not end with the app: {error}");
    }
    tauri::Builder::default()
        .setup(|app| {
            let paths = paths::AppPaths::resolve(app.handle())?;
            paths.ensure_dirs()?;
            app.manage(paths);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Kaleido");
}
