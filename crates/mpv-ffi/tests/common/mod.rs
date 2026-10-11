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
