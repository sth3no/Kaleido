use std::ffi::NulError;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cannot load libmpv: {0}")]
    Load(#[from] libloading::Error),
    #[error("unsupported libmpv client API {major}.{minor}, need 2.x")]
    ApiVersion { major: u64, minor: u64 },
    #[error("mpv_create returned NULL")]
    Create,
    #[error("{context}: {message} ({code})")]
    Mpv {
        code: i32,
        message: String,
        context: String,
    },
    #[error("string contains an interior NUL byte")]
    Nul(#[from] NulError),
}

pub type Result<T> = std::result::Result<T, Error>;
