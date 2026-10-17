#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod engine;
mod glass;
mod input;
mod open_requests;
mod options;
mod surface;
mod thumbs;

use std::sync::Arc;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{Emitter, Manager, WindowEvent};

use engine::Engine;
use open_requests::{OpenRequests, files_from_args, open_files};
use surface::SurfaceState;

fn main() {
    let requests = OpenRequests::default();
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut files = files_from_args(std::env::args_os().skip(1), &cwd);
    if files.is_empty()
        && let Some(path) = std::env::var_os("KALEIDO_M0_OPEN")
    {
        files = files_from_args([path], &cwd);
    }
    requests.submit(files);
    tauri::Builder::default()
        .manage(requests)
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let files = files_from_args(
                args.into_iter().skip(1).map(Into::into),
                std::path::Path::new(&cwd),
            );
            let batches = app.state::<OpenRequests>().submit(files);
            if let Some(engine) = app.try_state::<Arc<Engine>>()
                && let Err(error) = open_files(&engine.mpv, batches)
            {
                let _ = app.emit("player:log", error.to_string());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window missing")?;
            let parent = match window.window_handle()?.as_raw() {
                RawWindowHandle::Win32(handle) => handle.hwnd.get(),
                other => return Err(format!("unsupported window handle {other:?}").into()),
            };
            let paths = options::Paths::resolve(app.handle())?;
            // mpv creates its own child window inside the top-level window (see SurfaceState).
            let engine =
                Engine::start(app.handle().clone(), parent, &options::mpv_options(&paths))?;
            let surface = SurfaceState::new(parent);
            let size = window.inner_size()?;
            surface.apply(size.width, size.height, window.scale_factor()?);
            app.manage(surface);
            app.manage(engine);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                if let (Some(surface), Ok(size), Ok(scale)) = (
                    window.try_state::<SurfaceState>(),
                    window.inner_size(),
                    window.scale_factor(),
                ) {
                    surface.apply(size.width, size.height, scale);
                }
                // The UI's CSS rects do not change with DPI, so it pushes nothing (spec 8.2).
                if let WindowEvent::ScaleFactorChanged { scale_factor, .. } = event
                    && let Some(engine) = window.try_state::<Arc<Engine>>()
                {
                    let _ = engine.set_glass_scale(*scale_factor);
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                // mpv shuts down first; the event thread exits the app on SHUTDOWN.
                if let Some(engine) = window.try_state::<Arc<Engine>>() {
                    api.prevent_close();
                    let _ = engine.mpv.command(&["quit"]);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::player_ready,
            commands::player_command,
            commands::surface_set_layout,
            commands::player_input,
            commands::glass_set_regions,
            commands::thumb_request,
            commands::thumb_clear,
            commands::thumb_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("Kaleido M0 se nepodařilo spustit");
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use mpv_ffi::{Event, Mpv, load_api, locate_libmpv};

    const UTF8_DIR: &str = "KALEIDO_TEST_UTF8_DIR";

    /// thumbfast builds its output path from os.getenv("TEMP") and moves the result with
    /// os.rename. With a non-ASCII TEMP (C:\Users\Jiří\...) no thumbnail ever arrived: LuaJIT's
    /// os functions use the process's ANSI code page. The C runtime copies the environment at
    /// startup, hence the child process. This test binary embeds the same application manifest
    /// as Kaleido.exe (tauri-build links it into the bin target).
    #[test]
    fn lua_scripts_use_non_ascii_paths_from_the_environment() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("Videa čeština");
        std::fs::create_dir(&dir).unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["tests::lua_child_writes_where_the_environment_says"])
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
    #[ignore = "child process of lua_scripts_use_non_ascii_paths_from_the_environment"]
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
