//! Thin, safe wrapper over the upstream libmpv client API, loaded at runtime (spec 3, 4.2).

mod error;
mod handle;
pub mod sys;
#[doc(hidden)]
pub mod testing;

use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use error::{Error, Result};
pub use handle::Mpv;

/// Overrides where libmpv is loaded from.
pub const LIBMPV_ENV: &str = "KALEIDO_LIBMPV";
pub const LIBMPV_DLL: &str = "libmpv-2.dll";

/// `$KALEIDO_LIBMPV`, then next to the running executable, then the repo's `vendor/` (dev builds).
pub fn locate_libmpv() -> PathBuf {
    if let Some(path) = std::env::var_os(LIBMPV_ENV) {
        return PathBuf::from(path);
    }
    if let Some(candidate) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(LIBMPV_DLL)))
        .filter(|path| path.is_file())
    {
        return candidate;
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../vendor/libmpv")
        .join(LIBMPV_DLL)
}

pub fn load_api(path: &Path) -> Result<Arc<sys::Api>> {
    // SAFETY: the path comes from the application (locate_libmpv), never from user input.
    Ok(Arc::new(unsafe { sys::Api::load(path)? }))
}
