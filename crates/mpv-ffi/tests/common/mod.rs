#![allow(dead_code)]

use std::path::{Path, PathBuf};

use mpv_ffi::{Mpv, load_api, locate_libmpv};

/// Initialized core without any window or audio output.
pub fn headless() -> Mpv {
    let mpv = Mpv::create(load_api(&locate_libmpv()).expect("load libmpv")).expect("create");
    for (name, value) in [
        ("vo", "null"),
        ("ao", "null"),
        ("audio", "no"),
        ("untimed", "yes"),
        ("terminal", "no"),
    ] {
        mpv.set_option(name, value).expect(name);
    }
    mpv.initialize().expect("initialize");
    mpv
}

/// 2 s of 64×36 uncompressed video inside `dir`.
pub fn clip(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    mpv_ffi::testing::write_y4m(&path, 64, 36, 60).expect("write clip");
    path
}

use std::time::{Duration, Instant};

use mpv_ffi::Event;

/// Pumps events until `pred` matches; panics with everything seen on timeout.
pub fn wait_for(mpv: &Mpv, secs: u64, mut pred: impl FnMut(&Event) -> bool) -> Vec<Event> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        let event = mpv.wait_event(0.25);
        if event == Event::None {
            continue;
        }
        let hit = pred(&event);
        seen.push(event);
        if hit {
            return seen;
        }
    }
    panic!("event not received within {secs}s; seen: {seen:#?}");
}
