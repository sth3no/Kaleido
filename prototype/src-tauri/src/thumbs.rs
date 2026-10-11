use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Largest thumbnail side we accept from thumbfast.
pub const MAX_SIDE: u32 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbError {
    Json,
    Size,
    Path,
    Read,
    Length,
}

/// The fields of thumbfast's `thumbfast-render` JSON we use.
#[derive(Debug, Deserialize)]
pub struct RenderInfo {
    pub width: u32,
    pub height: u32,
    pub thumbnail: String,
}

pub struct Thumb {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Checks a `thumbfast-render` payload; returns the `.bgra` file to read.
/// Any script can send this message, so the path must be thumbfast's own temp file.
pub fn validate(json: &str, temp_dir: &Path) -> Result<(RenderInfo, PathBuf), ThumbError> {
    let info: RenderInfo = serde_json::from_str(json).map_err(|_| ThumbError::Json)?;
    if info.width == 0 || info.height == 0 || info.width > MAX_SIDE || info.height > MAX_SIDE {
        return Err(ThumbError::Size);
    }
    let file = PathBuf::from(format!("{}.bgra", info.thumbnail));
    let named_like_thumbfast = file
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("thumbfast"));
    let in_temp = file.parent().is_some_and(|dir| same_dir(dir, temp_dir));
    if !named_like_thumbfast || !in_temp {
        return Err(ThumbError::Path);
    }
    Ok((info, file))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

pub fn bgra_to_rgba(mut data: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, ThumbError> {
    if data.len() != width as usize * height as usize * 4 {
        return Err(ThumbError::Length);
    }
    for px in data.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
        px[3] = 255;
    }
    Ok(data)
}

pub fn load(json: &str, temp_dir: &Path) -> Result<Thumb, ThumbError> {
    let (info, file) = validate(json, temp_dir)?;
    let data = std::fs::read(&file).map_err(|_| ThumbError::Read)?;
    let rgba = bgra_to_rgba(data, info.width, info.height)?;
    Ok(Thumb {
        width: info.width,
        height: info.height,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(width: u32, height: u32, thumbnail: &Path) -> String {
        format!(
            r#"{{"width":{width},"height":{height},"thumbnail":{}}}"#,
            serde_json::to_string(&thumbnail.display().to_string()).unwrap()
        )
    }

    #[test]
    fn accepts_thumbfasts_own_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let (info, file) = validate(
            &payload(200, 112, &dir.path().join("thumbfast.out1234")),
            dir.path(),
        )
        .unwrap();
        assert_eq!((info.width, info.height), (200, 112));
        assert!(file.ends_with("thumbfast.out1234.bgra"));
    }

    #[test]
    fn rejects_paths_outside_temp() {
        let dir = tempfile::tempdir().unwrap();
        let foreign = Path::new(r"C:\Windows\System32\thumbfast");
        assert_eq!(
            validate(&payload(10, 10, foreign), dir.path()).unwrap_err(),
            ThumbError::Path
        );
    }

    #[test]
    fn rejects_other_files_in_temp() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            validate(&payload(10, 10, &dir.path().join("secret")), dir.path()).unwrap_err(),
            ThumbError::Path
        );
    }

    #[test]
    fn rejects_bad_sizes_and_json() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("thumbfast.out1");
        assert_eq!(
            validate(&payload(0, 10, &file), dir.path()).unwrap_err(),
            ThumbError::Size
        );
        assert_eq!(
            validate(&payload(4096, 10, &file), dir.path()).unwrap_err(),
            ThumbError::Size
        );
        assert_eq!(
            validate("not json", dir.path()).unwrap_err(),
            ThumbError::Json
        );
    }

    #[test]
    fn converts_bgra_to_opaque_rgba() {
        assert_eq!(
            bgra_to_rgba(vec![1, 2, 3, 0, 4, 5, 6, 7], 2, 1),
            Ok(vec![3, 2, 1, 255, 6, 5, 4, 255])
        );
    }

    #[test]
    fn rejects_truncated_pixel_data() {
        assert_eq!(bgra_to_rgba(vec![0; 7], 2, 1), Err(ThumbError::Length));
    }

    #[test]
    fn loads_a_written_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("thumbfast.out9");
        std::fs::write(dir.path().join("thumbfast.out9.bgra"), [9, 8, 7, 6]).unwrap();
        let thumb = load(&payload(1, 1, &base), dir.path()).unwrap();
        assert_eq!(thumb.rgba, vec![7, 8, 9, 255]);
    }

    #[test]
    fn missing_file_is_a_read_error() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("thumbfast.out404");
        assert_eq!(
            load(&payload(1, 1, &base), dir.path()).err(),
            Some(ThumbError::Read)
        );
    }
}
