use std::fs::OpenOptions;
use std::io::Write;
use std::process::{Child, Command, ExitStatus};
use std::time::{Duration, Instant};

const EXE: &str = env!("CARGO_BIN_EXE_kaleido-mpv");

fn wait_with_timeout(child: &mut Child, limit: Duration) -> ExitStatus {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("kaleido-mpv did not exit within {limit:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The exact encode path thumbfast relies on: one raw BGRA frame written to a file.
#[test]
fn encodes_one_bgra_frame_like_thumbfast() {
    let dir = tempfile::tempdir().unwrap();
    let clip = dir.path().join("clip.y4m");
    mpv_ffi::testing::write_y4m(&clip, 64, 36, 30).unwrap();
    let out = dir.path().join("thumbfast.out");
    let mut child = Command::new(EXE)
        .args([
            "--no-config",
            "--msg-level=all=no",
            "--no-sub",
            "--no-audio",
            "--frames=1",
            "--vf=scale=w=32:h=18,format=fmt=bgra",
            "--sws-scaler=fast-bilinear",
            "--ovc=rawvideo",
            "--of=image2",
            "--ofopts=update=1",
        ])
        .arg(format!("--o={}", out.display()))
        .arg("--")
        .arg(&clip)
        .spawn()
        .unwrap();
    assert!(wait_with_timeout(&mut child, Duration::from_secs(20)).success());
    assert_eq!(std::fs::metadata(&out).unwrap().len(), 32 * 18 * 4);
}

/// thumbfast controls its thumbnailer through a named pipe and ends it with `quit`.
#[test]
fn quits_when_told_over_ipc() {
    let pipe = format!("kaleido-test-{}", std::process::id());
    let mut child = Command::new(EXE)
        .args(["--no-config", "--idle"])
        .arg(format!("--input-ipc-server={pipe}"))
        .spawn()
        .unwrap();
    let path = format!(r"\\.\pipe\{pipe}");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut connection = loop {
        match OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => break file,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                let _ = child.kill();
                panic!("pipe {path} never appeared: {e}");
            }
        }
    };
    connection.write_all(b"quit\n").unwrap();
    drop(connection);
    assert!(wait_with_timeout(&mut child, Duration::from_secs(10)).success());
}

#[test]
fn fails_cleanly_without_libmpv() {
    let mut child = Command::new(EXE)
        .env(mpv_ffi::LIBMPV_ENV, "C:/kaleido/missing/libmpv-2.dll")
        .arg("--idle")
        .spawn()
        .unwrap();
    assert_eq!(wait_with_timeout(&mut child, Duration::from_secs(10)).code(), Some(1));
}
