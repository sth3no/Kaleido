use std::ffi::{CStr, c_char, c_int, c_void};

use crate::sys::{self, Api};

/// C type an observed property is delivered as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropertyKind {
    Flag,
    Int64,
    Double,
    String,
}

impl PropertyKind {
    pub(crate) fn format(self) -> sys::mpv_format {
        match self {
            PropertyKind::Flag => sys::MPV_FORMAT_FLAG,
            PropertyKind::Int64 => sys::MPV_FORMAT_INT64,
            PropertyKind::Double => sys::MPV_FORMAT_DOUBLE,
            PropertyKind::String => sys::MPV_FORMAT_STRING,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PropertyValue {
    Unavailable,
    Flag(bool),
    Int64(i64),
    Double(f64),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndFileReason {
    Eof,
    Stop,
    Quit,
    Error { code: i32, message: String },
    Redirect,
    Other(i32),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    None,
    Shutdown,
    LogMessage {
        prefix: String,
        level: String,
        text: String,
    },
    StartFile,
    FileLoaded,
    EndFile {
        reason: EndFileReason,
    },
    VideoReconfig,
    Seek,
    PlaybackRestart,
    PropertyChange {
        id: u64,
        name: String,
        value: PropertyValue,
    },
    ClientMessage {
        args: Vec<String>,
    },
    Other(i32),
}

unsafe fn string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}

unsafe fn property_value(format: sys::mpv_format, data: *mut c_void) -> PropertyValue {
    if data.is_null() {
        return PropertyValue::Unavailable;
    }
    unsafe {
        match format {
            sys::MPV_FORMAT_FLAG => PropertyValue::Flag(*data.cast::<c_int>() != 0),
            sys::MPV_FORMAT_INT64 => PropertyValue::Int64(*data.cast::<i64>()),
            sys::MPV_FORMAT_DOUBLE => PropertyValue::Double(*data.cast::<f64>()),
            sys::MPV_FORMAT_STRING => PropertyValue::String(string(*data.cast::<*const c_char>())),
            _ => PropertyValue::Unavailable,
        }
    }
}

/// # Safety
/// `raw` must come from `mpv_wait_event` on a live handle and is only valid until the next call.
pub(crate) unsafe fn from_raw(api: &Api, raw: *const sys::mpv_event) -> Event {
    if raw.is_null() {
        return Event::None;
    }
    unsafe {
        let event = &*raw;
        match event.event_id {
            sys::MPV_EVENT_NONE => Event::None,
            sys::MPV_EVENT_SHUTDOWN => Event::Shutdown,
            sys::MPV_EVENT_LOG_MESSAGE => {
                let m = &*event.data.cast::<sys::mpv_event_log_message>();
                Event::LogMessage {
                    prefix: string(m.prefix),
                    level: string(m.level),
                    text: string(m.text).trim_end().to_owned(),
                }
            }
            sys::MPV_EVENT_START_FILE => Event::StartFile,
            sys::MPV_EVENT_FILE_LOADED => Event::FileLoaded,
            sys::MPV_EVENT_END_FILE => {
                let e = &*event.data.cast::<sys::mpv_event_end_file>();
                let reason = match e.reason {
                    sys::MPV_END_FILE_REASON_EOF => EndFileReason::Eof,
                    sys::MPV_END_FILE_REASON_STOP => EndFileReason::Stop,
                    sys::MPV_END_FILE_REASON_QUIT => EndFileReason::Quit,
                    sys::MPV_END_FILE_REASON_ERROR => EndFileReason::Error {
                        code: e.error,
                        message: api.error_string(e.error),
                    },
                    sys::MPV_END_FILE_REASON_REDIRECT => EndFileReason::Redirect,
                    other => EndFileReason::Other(other),
                };
                Event::EndFile { reason }
            }
            sys::MPV_EVENT_VIDEO_RECONFIG => Event::VideoReconfig,
            sys::MPV_EVENT_SEEK => Event::Seek,
            sys::MPV_EVENT_PLAYBACK_RESTART => Event::PlaybackRestart,
            sys::MPV_EVENT_PROPERTY_CHANGE => {
                let p = &*event.data.cast::<sys::mpv_event_property>();
                Event::PropertyChange {
                    id: event.reply_userdata,
                    name: string(p.name),
                    value: property_value(p.format, p.data),
                }
            }
            sys::MPV_EVENT_CLIENT_MESSAGE => {
                let m = &*event.data.cast::<sys::mpv_event_client_message>();
                let count = usize::try_from(m.num_args).unwrap_or(0);
                let args = (0..count).map(|i| string(*m.args.add(i))).collect();
                Event::ClientMessage { args }
            }
            other => Event::Other(other),
        }
    }
}
