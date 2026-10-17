mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use mpv_ffi::{EndFileReason, Event, PropertyKind, PropertyValue};

const MISSING: &str = "C:/kaleido/missing/file.mkv";

#[test]
fn plays_generated_clip_to_eof() {
    let dir = tempfile::tempdir().unwrap();
    let clip = common::clip(dir.path(), "clip.y4m");
    let mpv = common::headless();
    mpv.command(&["loadfile", clip.to_str().unwrap()]).unwrap();
    let seen = common::wait_for(&mpv, 20, |e| matches!(e, Event::EndFile { .. }));
    assert!(seen.contains(&Event::FileLoaded), "{seen:#?}");
    assert_eq!(
        seen.last(),
        Some(&Event::EndFile {
            reason: EndFileReason::Eof
        })
    );
}

#[test]
fn opens_path_with_czech_characters_and_spaces() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Videa čeština (2026)");
    std::fs::create_dir(&folder).unwrap();
    let clip = common::clip(&folder, "žluťoučký kůň.y4m");
    let mpv = common::headless();
    mpv.command(&["loadfile", clip.to_str().unwrap()]).unwrap();
    common::wait_for(&mpv, 20, |e| *e == Event::FileLoaded);
}

#[test]
fn missing_file_ends_with_error() {
    let mpv = common::headless();
    mpv.command(&["loadfile", MISSING]).unwrap();
    let seen = common::wait_for(&mpv, 20, |e| matches!(e, Event::EndFile { .. }));
    assert!(
        matches!(
            seen.last(),
            Some(Event::EndFile {
                reason: EndFileReason::Error { .. }
            })
        ),
        "{seen:#?}"
    );
}

#[test]
fn error_log_messages_are_delivered() {
    let mpv = common::headless();
    mpv.request_log_messages("error").unwrap();
    mpv.command(&["loadfile", MISSING]).unwrap();
    common::wait_for(
        &mpv,
        20,
        |e| matches!(e, Event::LogMessage { level, .. } if level == "error"),
    );
}

#[test]
fn observed_flag_reports_initial_value_and_changes() {
    let mpv = common::headless();
    mpv.observe(7, "pause", PropertyKind::Flag).unwrap();
    let change = |on| Event::PropertyChange {
        id: 7,
        name: "pause".into(),
        value: PropertyValue::Flag(on),
    };
    common::wait_for(&mpv, 5, |e| *e == change(false));
    mpv.set_property("pause", "yes").unwrap();
    common::wait_for(&mpv, 5, |e| *e == change(true));
}

#[test]
fn script_message_reaches_host_client() {
    let mpv = common::headless();
    mpv.command(&["script-message", "kaleido", "hello world"])
        .unwrap();
    common::wait_for(&mpv, 5, |e| {
        *e == Event::ClientMessage {
            args: vec!["kaleido".into(), "hello world".into()],
        }
    });
}

#[test]
fn quit_yields_shutdown_and_drop_does_not_hang() {
    let mpv = common::headless();
    mpv.command(&["quit"]).unwrap();
    common::wait_for(&mpv, 5, |e| *e == Event::Shutdown);
    let started = Instant::now();
    drop(mpv);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn wakeup_interrupts_an_infinite_wait() {
    let mpv = Arc::new(common::headless());
    let waker = Arc::clone(&mpv);
    let (woken, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // Spontaneous events (e.g. the deprecated IDLE, id 11) may arrive first;
        // only Event::None means the wait was interrupted.
        while mpv.wait_event(-1.0) != Event::None {}
        woken.send(()).unwrap();
    });
    std::thread::sleep(Duration::from_millis(200));
    waker.wakeup();
    rx.recv_timeout(Duration::from_secs(5))
        .expect("wait_event(-1) was not interrupted by wakeup");
}

/// mpv_wait_event frees the previous event's data on the next call, so two threads inside it
/// at once would read freed memory. `Mpv` is Sync, so a second waiter must wait its turn.
#[test]
fn a_second_waiter_waits_for_the_first() {
    let mpv = Arc::new(common::headless());
    let first = Arc::clone(&mpv);
    let (first_done, first_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        while first.wait_event(-1.0) != Event::None {}
        first_done.send(()).unwrap();
    });
    std::thread::sleep(Duration::from_millis(200));

    let second = Arc::clone(&mpv);
    let (second_done, second_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        second.wait_event(0.0);
        second_done.send(()).unwrap();
    });
    assert!(
        second_rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "wait_event ran while another thread was inside it"
    );

    mpv.wakeup();
    first_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    second_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the second waiter never got its turn");
}
