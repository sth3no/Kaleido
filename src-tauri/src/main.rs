#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kaleido::run();
}

/// Player tests that need Kaleido.exe's application manifest: tauri-build links it into the
/// binary targets only, so the library's test binary runs without it.
#[cfg(test)]
mod player {
    use std::time::{Duration, Instant};

    use mpv_ffi::{Event, Mpv, load_api, locate_libmpv};

    const UTF8_DIR: &str = "KALEIDO_TEST_UTF8_DIR";

    /// thumbfast builds its output path from os.getenv("TEMP") and moves the result with
    /// os.rename. With a non-ASCII TEMP (C:\Users\Jiří\...) no thumbnail ever arrived: LuaJIT's
    /// os functions use the process's ANSI code page, which the manifest sets to UTF-8. The C
    /// runtime copies the environment at startup, hence the child process.
    #[test]
    fn lua_scripts_see_utf8_paths_from_the_environment() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("Videa čeština");
        std::fs::create_dir(&dir).unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["player::lua_child_writes_where_the_environment_says"])
            .args(["--exact", "--ignored", "--nocapture"])
            .env(UTF8_DIR, &dir)
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "{}{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        assert_eq!(std::fs::read_to_string(dir.join("lua.txt")).unwrap(), "ok");
    }

    #[test]
    #[ignore = "child process of lua_scripts_see_utf8_paths_from_the_environment"]
    fn lua_child_writes_where_the_environment_says() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("utf8-env.lua");
        std::fs::write(
            &script,
            format!(
                // The same steps as thumbfast: path from getenv, then os.rename (move_file).
                r#"local dir = os.getenv("{UTF8_DIR}")
local f = dir and io.open(dir .. "\\lua.tmp", "w")
if f then f:write("ok") f:close() end
local moved = f and os.rename(dir .. "\\lua.tmp", dir .. "\\lua.txt")
mp.commandv("script-message", "utf8-env", moved and "written" or "failed")
"#
            ),
        )
        .unwrap();

        let mpv = Mpv::create(load_api(&locate_libmpv()).unwrap()).unwrap();
        for (name, value) in [
            ("vo", "null"),
            ("ao", "null"),
            ("terminal", "no"),
            ("idle", "yes"),
        ] {
            mpv.set_option(name, value).unwrap();
        }
        mpv.set_option("scripts", &script.to_string_lossy())
            .unwrap();
        mpv.initialize().unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let result = loop {
            assert!(Instant::now() < deadline, "script never reported");
            if let Event::ClientMessage { args } = mpv.wait_event(0.1)
                && args.first().map(String::as_str) == Some("utf8-env")
            {
                break args[1].clone();
            }
        };
        assert_eq!(result, "written");
    }
}
