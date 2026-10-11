#![cfg_attr(not(test), windows_subsystem = "windows")]
//! Headless mpv-compatible CLI over libmpv. Exists so thumbfast can spawn its
//! thumbnailer without Kaleido shipping a full mpv.exe (spec 4.1).

mod args;

use mpv_ffi::{Event, Mpv, load_api, locate_libmpv};

fn main() {
    let code = match run() {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("kaleido-mpv: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn run() -> mpv_ffi::Result<()> {
    let invocation = args::parse_args(std::env::args().skip(1));
    let mpv = Mpv::create(load_api(&locate_libmpv())?)?;
    // mpv CLI behaviour that libmpv does not default to: leave once the playlist is done,
    // never read a config directory, never touch a terminal.
    mpv.set_option("idle", "once")?;
    mpv.set_option("config", "no")?;
    mpv.set_option("terminal", "no")?;
    for (name, value) in &invocation.options {
        if let Err(e) = mpv.set_option(name, value) {
            eprintln!("kaleido-mpv: ignoring --{name}={value}: {e}");
        }
    }
    mpv.initialize()?;
    for file in &invocation.files {
        mpv.command(&["loadfile", file, "append-play"])?;
    }
    while mpv.wait_event(-1.0) != Event::Shutdown {}
    Ok(())
}
