use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mpv_ffi::Mpv;

/// Shell arguments are local files, never mpv options or special protocols.
pub fn files_from_args(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<String> {
    let mut files_only = false;
    args.into_iter()
        .filter_map(|arg| {
            if !files_only && arg == "--" {
                files_only = true;
                return None;
            }
            if !files_only && arg.to_string_lossy().starts_with('-') {
                return None;
            }
            let path = PathBuf::from(arg);
            let path = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            path.is_file().then(|| path.to_string_lossy().into_owned())
        })
        .collect()
}

#[derive(Default)]
struct Pending {
    ready: bool,
    batches: Vec<Vec<String>>,
}

/// Keep startup and second-instance requests until React has subscribed to player events.
#[derive(Default)]
pub struct OpenRequests(Mutex<Pending>);

impl OpenRequests {
    pub fn submit(&self, files: Vec<String>) -> Vec<Vec<String>> {
        let mut pending = self.0.lock().unwrap();
        if !files.is_empty() {
            pending.batches.push(files);
        }
        if pending.ready {
            std::mem::take(&mut pending.batches)
        } else {
            Vec::new()
        }
    }

    pub fn ready(&self) -> Vec<Vec<String>> {
        let mut pending = self.0.lock().unwrap();
        pending.ready = true;
        std::mem::take(&mut pending.batches)
    }
}

pub fn open_files(mpv: &Mpv, batches: Vec<Vec<String>>) -> mpv_ffi::Result<()> {
    for files in batches {
        for (index, file) in files.iter().enumerate() {
            let mode = if index == 0 { "replace" } else { "append" };
            mpv.command(&["loadfile", file, mode])?;
            if index == 0 {
                // A new open request means play, even after pause or keep-open EOF.
                mpv.set_property("pause", "no")?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_a_file_resumes_an_existing_paused_player() {
        let dir = tempfile::tempdir().unwrap();
        let clip = dir.path().join("next.y4m");
        mpv_ffi::testing::write_y4m(&clip, 64, 36, 300).unwrap();
        let mpv = Mpv::create(mpv_ffi::load_api(&mpv_ffi::locate_libmpv()).unwrap()).unwrap();
        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("vo", "null"),
            ("ao", "null"),
            ("idle", "yes"),
            ("pause", "yes"),
        ] {
            mpv.set_option(name, value).unwrap();
        }
        mpv.initialize().unwrap();
        assert!(mpv.get_flag("pause").unwrap());
        open_files(&mpv, vec![vec![clip.to_string_lossy().into_owned()]]).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            assert!(std::time::Instant::now() < deadline, "FileLoaded timed out");
            if mpv.wait_event(0.1) == mpv_ffi::Event::FileLoaded {
                break;
            }
        }
        assert!(
            !mpv.get_flag("pause").unwrap(),
            "New file must start playing"
        );
    }

    #[test]
    fn preserves_spaces_unicode_and_relative_shell_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Žluťoučký kůň (zkouška).mkv");
        std::fs::write(&file, []).unwrap();
        let result = files_from_args([file.file_name().unwrap().to_owned()], dir.path());
        assert_eq!(result, [file.to_string_lossy()]);
    }

    #[test]
    fn skips_options_protocols_directories_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let args = ["--pause", "edl://anything", "missing.mkv", "."].map(OsString::from);
        assert!(files_from_args(args, dir.path()).is_empty());
    }

    #[test]
    fn double_dash_allows_filenames_starting_with_dash() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("-film.mkv"), []).unwrap();
        let args = ["--", "-film.mkv"].map(OsString::from);
        assert_eq!(files_from_args(args, dir.path()).len(), 1);
    }

    #[test]
    fn startup_and_early_second_instance_wait_for_the_ui() {
        let queue = OpenRequests::default();
        assert!(queue.submit(vec!["first.mkv".into()]).is_empty());
        assert!(queue.submit(vec!["second.mkv".into()]).is_empty());
        assert_eq!(queue.ready(), vec![vec!["first.mkv"], vec!["second.mkv"]]);
        assert!(queue.ready().is_empty());
    }

    #[test]
    fn ready_ui_gets_new_requests_immediately_without_empty_batches() {
        let queue = OpenRequests::default();
        assert!(queue.ready().is_empty());
        assert_eq!(
            queue.submit(vec!["film.mkv".into()]),
            vec![vec!["film.mkv"]]
        );
        assert!(queue.submit(Vec::new()).is_empty());
    }
}
