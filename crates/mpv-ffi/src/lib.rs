//! Thin, safe wrapper over the upstream libmpv client API, loaded at runtime (spec 3, 4.2).

mod error;
mod event;
mod handle;
pub mod sys;
#[doc(hidden)]
pub mod testing;

use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use error::{Error, Result};
pub use event::{EndFileReason, Event, PropertyKind, PropertyValue};
pub use handle::Mpv;

/// Overrides where libmpv is loaded from (debug builds only).
pub const LIBMPV_ENV: &str = "KALEIDO_LIBMPV";
pub const LIBMPV_DLL: &str = "libmpv-2.dll";

/// Release builds load only the DLL next to the running executable, so neither the environment
/// nor the build machine's paths choose the code Kaleido runs. Debug builds look at
/// `$KALEIDO_LIBMPV` first and fall back to the repo's `vendor/`.
pub fn locate_libmpv() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os(LIBMPV_ENV) {
        return PathBuf::from(path);
    }
    let beside_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join(LIBMPV_DLL)));
    #[cfg(debug_assertions)]
    if !beside_exe.as_deref().is_some_and(Path::is_file) {
        return Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../vendor/libmpv")
            .join(LIBMPV_DLL);
    }
    // Without an executable path, an empty path fails to load instead of searching the DLL path.
    beside_exe.unwrap_or_default()
}

pub fn load_api(path: &Path) -> Result<Arc<sys::Api>> {
    // SAFETY: the path comes from the application (locate_libmpv), never from user input.
    Ok(Arc::new(unsafe { sys::Api::load(path)? }))
}
