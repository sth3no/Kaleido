//! Raw libmpv client API (`client.h`, API 2.x), resolved at runtime from the DLL.
#![allow(non_camel_case_types)]

use std::ffi::{CStr, c_char, c_double, c_int, c_ulong, c_void};
use std::path::Path;

use libloading::Library;

#[repr(C)]
pub struct mpv_handle {
    _private: [u8; 0],
}

pub type mpv_format = c_int;
pub const MPV_FORMAT_NONE: mpv_format = 0;
pub const MPV_FORMAT_STRING: mpv_format = 1;
pub const MPV_FORMAT_FLAG: mpv_format = 3;
pub const MPV_FORMAT_INT64: mpv_format = 4;
pub const MPV_FORMAT_DOUBLE: mpv_format = 5;

pub type mpv_event_id = c_int;
pub const MPV_EVENT_NONE: mpv_event_id = 0;
pub const MPV_EVENT_SHUTDOWN: mpv_event_id = 1;
pub const MPV_EVENT_LOG_MESSAGE: mpv_event_id = 2;
pub const MPV_EVENT_START_FILE: mpv_event_id = 6;
pub const MPV_EVENT_END_FILE: mpv_event_id = 7;
pub const MPV_EVENT_FILE_LOADED: mpv_event_id = 8;
pub const MPV_EVENT_CLIENT_MESSAGE: mpv_event_id = 16;
pub const MPV_EVENT_VIDEO_RECONFIG: mpv_event_id = 17;
pub const MPV_EVENT_SEEK: mpv_event_id = 20;
pub const MPV_EVENT_PLAYBACK_RESTART: mpv_event_id = 21;
pub const MPV_EVENT_PROPERTY_CHANGE: mpv_event_id = 22;

pub const MPV_END_FILE_REASON_EOF: c_int = 0;
pub const MPV_END_FILE_REASON_STOP: c_int = 2;
pub const MPV_END_FILE_REASON_QUIT: c_int = 3;
pub const MPV_END_FILE_REASON_ERROR: c_int = 4;
pub const MPV_END_FILE_REASON_REDIRECT: c_int = 5;

#[repr(C)]
pub struct mpv_event {
    pub event_id: mpv_event_id,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_property {
    pub name: *const c_char,
    pub format: mpv_format,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_log_message {
    pub prefix: *const c_char,
    pub level: *const c_char,
    pub text: *const c_char,
    pub log_level: c_int,
}

#[repr(C)]
pub struct mpv_event_end_file {
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
    pub playlist_insert_id: i64,
    pub playlist_insert_num_entries: c_int,
}

#[repr(C)]
pub struct mpv_event_client_message {
    pub num_args: c_int,
    pub args: *const *const c_char,
}

type FnVersion = unsafe extern "C" fn() -> c_ulong;
type FnCreate = unsafe extern "C" fn() -> *mut mpv_handle;
type FnInitialize = unsafe extern "C" fn(*mut mpv_handle) -> c_int;
type FnHandleOnly = unsafe extern "C" fn(*mut mpv_handle);
type FnSetString = unsafe extern "C" fn(*mut mpv_handle, *const c_char, *const c_char) -> c_int;
type FnCommand = unsafe extern "C" fn(*mut mpv_handle, *mut *const c_char) -> c_int;
type FnGetProperty =
    unsafe extern "C" fn(*mut mpv_handle, *const c_char, mpv_format, *mut c_void) -> c_int;
type FnFree = unsafe extern "C" fn(*mut c_void);
type FnObserve = unsafe extern "C" fn(*mut mpv_handle, u64, *const c_char, mpv_format) -> c_int;
type FnRequestLog = unsafe extern "C" fn(*mut mpv_handle, *const c_char) -> c_int;
type FnWaitEvent = unsafe extern "C" fn(*mut mpv_handle, c_double) -> *mut mpv_event;
type FnErrorString = unsafe extern "C" fn(c_int) -> *const c_char;
type FnClientName = unsafe extern "C" fn(*mut mpv_handle) -> *const c_char;

/// Function table of a loaded libmpv. Keeps the DLL loaded for as long as it lives.
pub struct Api {
    pub(crate) client_api_version: FnVersion,
    pub(crate) create: FnCreate,
    pub(crate) initialize: FnInitialize,
    pub(crate) terminate_destroy: FnHandleOnly,
    pub(crate) set_option_string: FnSetString,
    pub(crate) set_property_string: FnSetString,
    pub(crate) command: FnCommand,
    pub(crate) get_property: FnGetProperty,
    pub(crate) free: FnFree,
    pub(crate) observe_property: FnObserve,
    pub(crate) request_log_messages: FnRequestLog,
    pub(crate) wait_event: FnWaitEvent,
    pub(crate) wakeup: FnHandleOnly,
    pub(crate) error_string: FnErrorString,
    pub(crate) client_name: FnClientName,
    _lib: Library,
}

impl Api {
    /// # Safety
    /// `path` must be a libmpv 2.x DLL chosen by the application; loading runs its init code.
    pub unsafe fn load(path: &Path) -> Result<Api, libloading::Error> {
        unsafe {
            let lib = Library::new(path)?;
            let client_api_version = *lib.get::<FnVersion>(b"mpv_client_api_version\0")?;
            let create = *lib.get::<FnCreate>(b"mpv_create\0")?;
            let initialize = *lib.get::<FnInitialize>(b"mpv_initialize\0")?;
            let terminate_destroy = *lib.get::<FnHandleOnly>(b"mpv_terminate_destroy\0")?;
            let set_option_string = *lib.get::<FnSetString>(b"mpv_set_option_string\0")?;
            let set_property_string = *lib.get::<FnSetString>(b"mpv_set_property_string\0")?;
            let command = *lib.get::<FnCommand>(b"mpv_command\0")?;
            let get_property = *lib.get::<FnGetProperty>(b"mpv_get_property\0")?;
            let free = *lib.get::<FnFree>(b"mpv_free\0")?;
            let observe_property = *lib.get::<FnObserve>(b"mpv_observe_property\0")?;
            let request_log_messages = *lib.get::<FnRequestLog>(b"mpv_request_log_messages\0")?;
            let wait_event = *lib.get::<FnWaitEvent>(b"mpv_wait_event\0")?;
            let wakeup = *lib.get::<FnHandleOnly>(b"mpv_wakeup\0")?;
            let error_string = *lib.get::<FnErrorString>(b"mpv_error_string\0")?;
            let client_name = *lib.get::<FnClientName>(b"mpv_client_name\0")?;
            Ok(Api {
                client_api_version,
                create,
                initialize,
                terminate_destroy,
                set_option_string,
                set_property_string,
                command,
                get_property,
                free,
                observe_property,
                request_log_messages,
                wait_event,
                wakeup,
                error_string,
                client_name,
                _lib: lib,
            })
        }
    }

    /// `major << 16 | minor`.
    pub fn client_api_version(&self) -> u64 {
        // SAFETY: no arguments, no preconditions.
        unsafe { (self.client_api_version)() as u64 }
    }

    pub fn error_string(&self, code: i32) -> String {
        // SAFETY: mpv_error_string accepts any value and returns a static string.
        let ptr = unsafe { (self.error_string)(code) };
        if ptr.is_null() {
            return format!("mpv error {code}");
        }
        unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
    }
}
