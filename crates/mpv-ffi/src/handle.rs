use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::{Arc, Mutex, PoisonError};

use crate::error::{Error, Result};
use crate::event::{self, Event, PropertyKind};
use crate::sys::{self, Api};

const MPV_ERROR_PROPERTY_UNAVAILABLE: i32 = -10;

/// One libmpv core (`mpv_handle`). Dropping it destroys the core.
pub struct Mpv {
    pub(crate) api: Arc<Api>,
    pub(crate) ctx: *mut sys::mpv_handle,
    /// Held across mpv_wait_event and the conversion of the event it returns.
    events: Mutex<()>,
}

// SAFETY: the libmpv client API is thread-safe. Its one restriction (mpv_wait_event
// must not run on two threads at once) is enforced by `Mpv::events`.
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

impl Mpv {
    pub fn create(api: Arc<Api>) -> Result<Mpv> {
        let version = api.client_api_version();
        let (major, minor) = (version >> 16, version & 0xffff);
        if major != 2 {
            return Err(Error::ApiVersion { major, minor });
        }
        // SAFETY: plain constructor, returns NULL on failure.
        let ctx = unsafe { (api.create)() };
        if ctx.is_null() {
            return Err(Error::Create);
        }
        Ok(Mpv {
            api,
            ctx,
            events: Mutex::new(()),
        })
    }

    /// Only meaningful before `initialize` for most options.
    pub fn set_option(&self, name: &str, value: &str) -> Result<()> {
        let (n, v) = (CString::new(name)?, CString::new(value)?);
        // SAFETY: ctx is live; both strings are NUL-terminated and outlive the call.
        let code = unsafe { (self.api.set_option_string)(self.ctx, n.as_ptr(), v.as_ptr()) };
        self.check(code, || format!("set option {name}={value}"))
    }

    pub fn initialize(&self) -> Result<()> {
        // SAFETY: ctx is live.
        let code = unsafe { (self.api.initialize)(self.ctx) };
        self.check(code, || "initialize".to_owned())
    }

    /// Runs an input command given as separate arguments (no quoting needed).
    pub fn command(&self, args: &[&str]) -> Result<()> {
        let owned = args
            .iter()
            .map(|a| CString::new(*a))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        // SAFETY: NULL-terminated array of valid C strings that outlive the call.
        let code = unsafe { (self.api.command)(self.ctx, ptrs.as_mut_ptr()) };
        self.check(code, || format!("command {args:?}"))
    }

    pub fn set_property(&self, name: &str, value: &str) -> Result<()> {
        let (n, v) = (CString::new(name)?, CString::new(value)?);
        // SAFETY: see set_option.
        let code = unsafe { (self.api.set_property_string)(self.ctx, n.as_ptr(), v.as_ptr()) };
        self.check(code, || format!("set property {name}={value}"))
    }

    pub fn get_string(&self, name: &str) -> Result<String> {
        let mut out: *mut c_char = std::ptr::null_mut();
        self.get_raw(name, sys::MPV_FORMAT_STRING, (&raw mut out).cast())?;
        if out.is_null() {
            return Err(Error::Mpv {
                code: MPV_ERROR_PROPERTY_UNAVAILABLE,
                message: "property unavailable".to_owned(),
                context: format!("get {name}"),
            });
        }
        // SAFETY: mpv returned an owned C string that we must release with mpv_free.
        let value = unsafe { CStr::from_ptr(out) }
            .to_string_lossy()
            .into_owned();
        unsafe { (self.api.free)(out.cast()) };
        Ok(value)
    }

    pub fn get_f64(&self, name: &str) -> Result<f64> {
        let mut value: f64 = 0.0;
        self.get_raw(name, sys::MPV_FORMAT_DOUBLE, (&raw mut value).cast())?;
        Ok(value)
    }

    pub fn get_i64(&self, name: &str) -> Result<i64> {
        let mut value: i64 = 0;
        self.get_raw(name, sys::MPV_FORMAT_INT64, (&raw mut value).cast())?;
        Ok(value)
    }

    pub fn get_flag(&self, name: &str) -> Result<bool> {
        let mut value: c_int = 0;
        self.get_raw(name, sys::MPV_FORMAT_FLAG, (&raw mut value).cast())?;
        Ok(value != 0)
    }

    /// Name other clients use to reach us with `script-message-to` ("main").
    pub fn client_name(&self) -> String {
        // SAFETY: returns a string owned by the handle, valid while ctx lives.
        let ptr = unsafe { (self.api.client_name)(self.ctx) };
        unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned()
    }

    /// Delivers `Event::PropertyChange { id, .. }` now and on every change.
    pub fn observe(&self, id: u64, name: &str, kind: PropertyKind) -> Result<()> {
        let n = CString::new(name)?;
        // SAFETY: ctx is live; name outlives the call.
        let code = unsafe { (self.api.observe_property)(self.ctx, id, n.as_ptr(), kind.format()) };
        self.check(code, || format!("observe {name}"))
    }

    /// `min_level` is an mpv log level: "no", "fatal", "error", "warn", "info", "v", "debug", "trace".
    pub fn request_log_messages(&self, min_level: &str) -> Result<()> {
        let level = CString::new(min_level)?;
        // SAFETY: ctx is live; level outlives the call.
        let code = unsafe { (self.api.request_log_messages)(self.ctx, level.as_ptr()) };
        self.check(code, || format!("request_log_messages {min_level}"))
    }

    /// Blocks up to `timeout_secs` (negative = forever). Concurrent callers take turns: a
    /// second caller waits until the first returns. `wakeup` interrupts the current wait.
    pub fn wait_event(&self, timeout_secs: f64) -> Event {
        let _turn = self.events.lock().unwrap_or_else(PoisonError::into_inner);
        // SAFETY: the next mpv_wait_event frees the returned event's data; the lock keeps it
        // from running until the event has been converted into owned Rust values.
        unsafe {
            let raw = (self.api.wait_event)(self.ctx, timeout_secs);
            event::from_raw(&self.api, raw)
        }
    }

    /// Makes a blocked `wait_event` return `Event::None`.
    pub fn wakeup(&self) {
        // SAFETY: ctx is live; mpv_wakeup is explicitly thread-safe.
        unsafe { (self.api.wakeup)(self.ctx) }
    }

    fn get_raw(&self, name: &str, format: sys::mpv_format, out: *mut c_void) -> Result<()> {
        let n = CString::new(name)?;
        // SAFETY: `out` points to storage of the C type matching `format`.
        let code = unsafe { (self.api.get_property)(self.ctx, n.as_ptr(), format, out) };
        self.check(code, || format!("get {name}"))
    }

    pub(crate) fn check(&self, code: c_int, context: impl FnOnce() -> String) -> Result<()> {
        if code >= 0 {
            return Ok(());
        }
        Err(Error::Mpv {
            code,
            message: self.api.error_string(code),
            context: context(),
        })
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        // SAFETY: ctx came from mpv_create and is destroyed exactly once.
        unsafe { (self.api.terminate_destroy)(self.ctx) }
    }
}
