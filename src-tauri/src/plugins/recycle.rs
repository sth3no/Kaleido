//! Removal to the Windows Recycle Bin (plan decision 4): an uninstalled plugin can be brought back
//! from there. `SHFileOperationW` with `FO_DELETE` and `FOF_ALLOWUNDO` is what Explorer's Delete
//! does; the other flags keep every dialog away (no confirmation, no progress, no error box), so
//! it can run on any thread and never waits for the user.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use windows::Win32::UI::Shell::{
    FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, SHFILEOPSTRUCTW,
    SHFileOperationW,
};
use windows::core::PCWSTR;

/// Moves the files and folders `paths` to the Recycle Bin, all in one operation. Each must be
/// there: one that is not is an error before anything moves. Paths are made absolute first
/// (`SHFileOperationW` would delete a relative one for good instead of recycling it); `*` and `?`
/// are refused, because it would read them as wildcards. An empty list does nothing.
///
/// Windows decides what the Recycle Bin takes: a file on a drive without one, or one larger
/// than the bin may hold, is deleted for good without a question (that is `FOF_NOCONFIRMATION`).
/// The config folder is on the system drive, which has one.
pub fn to_recycle_bin(paths: &[PathBuf]) -> io::Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut from: Vec<u16> = Vec::new();
    for path in paths {
        let path = checked(path)?;
        from.extend(path.as_os_str().encode_wide());
        from.push(0);
    }
    // The list ends with a second zero.
    from.push(0);

    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        pTo: PCWSTR::null(),
        // The flags are a WORD in this struct.
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT).0 as u16,
        ..Default::default()
    };
    // SAFETY: `operation` is a valid SHFILEOPSTRUCTW for the whole call, and `from` (which
    // `pFrom` points into) is a double-zero-terminated list of UTF-16 paths that outlives it.
    let code = unsafe { SHFileOperationW(&mut operation) };
    if code != 0 {
        // Not always a Win32 error code: SHFileOperation has its own (DE_*) values too.
        return Err(io::Error::other(format!(
            "the Recycle Bin did not take {} (SHFileOperationW returned {code:#x})",
            listed(paths)
        )));
    }
    if operation.fAnyOperationsAborted.as_bool() {
        return Err(io::Error::other(format!(
            "moving {} to the Recycle Bin was stopped",
            listed(paths)
        )));
    }
    Ok(())
}

/// `path` made absolute, if it is there and has no wildcard in it.
fn checked(path: &Path) -> io::Result<PathBuf> {
    let text = path.as_os_str().to_string_lossy();
    if text.contains(['*', '?']) || path.as_os_str().encode_wide().any(|unit| unit == 0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not one file or folder", path.display()),
        ));
    }
    // Before anything moves, so that a list with a missing entry moves nothing.
    std::fs::symlink_metadata(path)?;
    std::path::absolute(path)
}

fn listed(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// Puts two small entries into the real Recycle Bin of whoever runs the tests.
    #[test]
    fn the_recycle_bin_takes_files_and_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("kaleido-recycle-test.lua");
        fs::write(&file, "-- a plugin\n").unwrap();
        let folder = tmp.path().join("kaleido-recycle-test");
        fs::create_dir_all(folder.join("lib")).unwrap();
        fs::write(folder.join("main.lua"), "-- a plugin\n").unwrap();
        fs::write(folder.join("lib").join("util.lua"), "-- a helper\n").unwrap();
        let kept = tmp.path().join("kept.txt");
        fs::write(&kept, "stays").unwrap();

        to_recycle_bin(&[file.clone(), folder.clone()]).unwrap();

        assert!(!file.exists());
        assert!(!folder.exists());
        assert_eq!(fs::read_to_string(&kept).unwrap(), "stays");
    }

    #[test]
    fn the_recycle_bin_is_not_asked_for_what_it_cannot_take() {
        let tmp = tempfile::tempdir().unwrap();
        let there = tmp.path().join("there.lua");
        fs::write(&there, "-- a plugin\n").unwrap();

        // Nothing to do.
        to_recycle_bin(&[]).unwrap();
        // One entry is missing: nothing moves, the other stays.
        let error = to_recycle_bin(&[there.clone(), tmp.path().join("missing.lua")]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(there.exists());
        // A wildcard would take more than the entry named.
        for wildcard in ["*.lua", "there.?ua"] {
            let error = to_recycle_bin(&[tmp.path().join(wildcard)]).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{wildcard}");
        }
        assert!(there.exists());
    }
}
