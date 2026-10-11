mod common;

use std::path::Path;

use mpv_ffi::{Error, Mpv, load_api, locate_libmpv};

#[test]
fn missing_library_is_a_load_error() {
    match load_api(Path::new("C:/kaleido/missing/libmpv-2.dll")) {
        Err(Error::Load(_)) => {}
        Err(other) => panic!("unexpected error {other}"),
        Ok(_) => panic!("loaded a library that does not exist"),
    }
}

#[test]
fn pinned_libmpv_speaks_client_api_2() {
    let api = load_api(&locate_libmpv()).expect("load libmpv");
    assert_eq!(api.client_api_version() >> 16, 2);
}

#[test]
fn initializes_headless_and_reports_version() {
    let mpv = common::headless();
    assert!(mpv.get_string("mpv-version").unwrap().starts_with("mpv "));
}

#[test]
fn volume_roundtrip() {
    let mpv = common::headless();
    mpv.set_property("volume", "42").unwrap();
    assert_eq!(mpv.get_f64("volume").unwrap(), 42.0);
}

#[test]
fn flag_roundtrip() {
    let mpv = common::headless();
    mpv.set_property("pause", "yes").unwrap();
    assert!(mpv.get_flag("pause").unwrap());
}

#[test]
fn unknown_option_reports_mpv_error_code() {
    let mpv = Mpv::create(load_api(&locate_libmpv()).unwrap()).unwrap();
    match mpv.set_option("kaleido-no-such-option", "1") {
        Err(Error::Mpv { code, .. }) => assert_eq!(code, -5, "MPV_ERROR_OPTION_NOT_FOUND"),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn interior_nul_never_reaches_mpv() {
    let mpv = common::headless();
    assert!(matches!(
        mpv.command(&["show-text", "a\0b"]),
        Err(Error::Nul(_))
    ));
}

#[test]
fn host_client_is_named_main() {
    assert_eq!(common::headless().client_name(), "main");
}
