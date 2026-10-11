//! End-to-end: pinned thumbfast inside libmpv spawns kaleido-mpv and reports a thumbnail
//! via `thumbfast-render` (spec 5.4 #7). Needs `scripts/fetch-thumbfast.ps1`.

use std::path::Path;
use std::time::{Duration, Instant};

use mpv_ffi::{Event, Mpv, load_api, locate_libmpv};

#[test]
fn thumbfast_renders_through_kaleido_mpv() {
    let thumbfast =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/thumbfast/thumbfast.lua");
    assert!(thumbfast.is_file(), "run scripts/fetch-thumbfast.ps1 first");
    let dir = tempfile::tempdir().unwrap();
    let clip = dir.path().join("clip.y4m");
    mpv_ffi::testing::write_y4m(&clip, 320, 180, 90).unwrap();

    let mpv = Mpv::create(load_api(&locate_libmpv()).unwrap()).unwrap();
    for (name, value) in [
        ("vo", "null"),
        ("ao", "null"),
        ("audio", "no"),
        ("terminal", "no"),
        ("pause", "yes"),
        ("keep-open", "yes"),
    ] {
        mpv.set_option(name, value).unwrap();
    }
    mpv.set_option("scripts", thumbfast.to_str().unwrap())
        .unwrap();
    mpv.set_option(
        "script-opts",
        &format!("thumbfast-mpv_path={}", env!("CARGO_BIN_EXE_kaleido-mpv")),
    )
    .unwrap();
    mpv.initialize().unwrap();
    mpv.command(&["loadfile", clip.to_str().unwrap()]).unwrap();

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last_request = Instant::now() - Duration::from_secs(1);
    let json = loop {
        assert!(
            Instant::now() < deadline,
            "thumbfast never sent thumbfast-render"
        );
        if last_request.elapsed() > Duration::from_millis(500) {
            let _ = mpv.command(&[
                "script-message-to",
                "thumbfast",
                "thumb",
                "1.5",
                "",
                "",
                "main",
            ]);
            last_request = Instant::now();
        }
        if let Event::ClientMessage { args } = mpv.wait_event(0.1)
            && args.first().map(String::as_str) == Some("thumbfast-render")
        {
            break args[1].clone();
        }
    };

    let width = json_number(&json, "width");
    let height = json_number(&json, "height");
    let base = json_string(&json, "thumbnail");
    let bytes = std::fs::metadata(format!("{base}.bgra")).unwrap().len();
    assert!(width > 0 && height > 0, "{json}");
    assert_eq!(bytes, width * height * 4, "{json}");
    let _ = mpv.command(&["quit"]);
}

fn json_number(json: &str, key: &str) -> u64 {
    let start = json
        .find(&format!("\"{key}\":"))
        .unwrap_or_else(|| panic!("{key} in {json}"))
        + key.len()
        + 3;
    json[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap()
}

fn json_string(json: &str, key: &str) -> String {
    let start = json
        .find(&format!("\"{key}\":\""))
        .unwrap_or_else(|| panic!("{key} in {json}"))
        + key.len()
        + 4;
    let raw: String = json[start..].chars().take_while(|c| *c != '"').collect();
    raw.replace("\\\\", "\\")
}
