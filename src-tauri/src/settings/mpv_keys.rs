//! The mpv options the settings pages may change (spec 8.10) and how their values are checked.
//! The UI names a key from [`MPV_SETTINGS`] and a value; any other key is refused, and a value is
//! checked against its kind before it reaches mpv.conf or mpv (spec 4.2: no free mpv commands).

use super::{SettingsError, is_hex_color};

/// How `glsl-shaders` names a file in `config_dir/shaders` (`~~` is mpv's config-dir).
pub const SHADERS_PREFIX: &str = "~~/shaders/";
/// mpv's path list separator on Windows: what `glsl-shaders` entries are joined with.
pub const SHADERS_SEPARATOR: char = ';';

/// What a value may be.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ValueKind {
    /// One of these words.
    Choice(&'static [&'static str]),
    /// One of these words, or empty for none.
    ChoiceOrNone(&'static [&'static str]),
    /// `yes` or `no`.
    Flag,
    /// A number from `min` to `max`.
    Number { min: f64, max: f64 },
    /// `#RRGGBB` or `#AARRGGBB`.
    Color,
    /// Language codes (`[a-z]{2,3}`) separated by commas, or empty for none.
    Languages,
    /// A font family from `system_fonts`.
    Font,
    /// A device from mpv's `audio-device-list`.
    AudioDevice,
    /// Files from `config_dir/shaders`, separated by `;`, or empty for none.
    Shaders,
}

/// An mpv option the settings may change. `live` ones are also set in the running player; the
/// others apply from the next start.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MpvSetting {
    pub key: &'static str,
    pub kind: ValueKind,
    pub live: bool,
}

const fn live(key: &'static str, kind: ValueKind) -> MpvSetting {
    MpvSetting {
        key,
        kind,
        live: true,
    }
}

/// Written to mpv.conf only: it applies from the next start.
const fn at_start(key: &'static str, kind: ValueKind) -> MpvSetting {
    MpvSetting {
        key,
        kind,
        live: false,
    }
}

/// The default qualities of links a user can choose (Settings → Playback, "Výchozí kvalita
/// streamů", plan decision 10): yt-dlp's selections for at most 2160, 1440, 1080, 720 and 480 lines
/// (the best video of that height or lower with the best audio, or the best single file of it),
/// and audio alone. `ytdl-format` takes only these, or nothing for yt-dlp's own default. Each one
/// passes the check of a format to load (`player::load::LoadOptions::validate`), so the quality
/// chosen for a link can be one of them too.
pub const STREAM_QUALITY_PRESETS: &[&str] = &[
    "bv*[height<=?2160]+ba/b[height<=?2160]",
    "bv*[height<=?1440]+ba/b[height<=?1440]",
    "bv*[height<=?1080]+ba/b[height<=?1080]",
    "bv*[height<=?720]+ba/b[height<=?720]",
    "bv*[height<=?480]+ba/b[height<=?480]",
    "ba/b",
];

/// Every mpv option Kaleido's settings manage, by section of the settings page (spec 8.10).
pub const MPV_SETTINGS: &[MpvSetting] = &[
    // Playback
    live(
        "hwdec",
        ValueKind::Choice(&["auto-safe", "auto-copy-safe", "no"]),
    ),
    live(
        "autocreate-playlist",
        ValueKind::Choice(&["no", "filter", "same"]),
    ),
    live("save-position-on-quit", ValueKind::Flag),
    // The default quality of links (plan decision 10): mpv's `ytdl_hook` reads it for every link
    // it opens, so it is live for the next one; the quality of the link that plays is changed
    // with `player_set_quality` (streams.rs).
    live(
        "ytdl-format",
        ValueKind::ChoiceOrNone(STREAM_QUALITY_PRESETS),
    ),
    // Subtitles
    live("sub-font", ValueKind::Font),
    live(
        "sub-font-size",
        ValueKind::Number {
            min: 10.0,
            max: 120.0,
        },
    ),
    live("sub-color", ValueKind::Color),
    live("sub-border-color", ValueKind::Color),
    live("sub-back-color", ValueKind::Color),
    live(
        "sub-border-size",
        ValueKind::Number {
            min: 0.0,
            max: 10.0,
        },
    ),
    live("slang", ValueKind::Languages),
    // Audio
    live("audio-device", ValueKind::AudioDevice),
    // The default volume (spec 8.10): changing it must not make the playing volume jump
    // (Ruling R25).
    at_start(
        "volume",
        ValueKind::Number {
            min: 0.0,
            max: 100.0,
        },
    ),
    live(
        "volume-max",
        ValueKind::Number {
            min: 100.0,
            max: 1000.0,
        },
    ),
    live("alang", ValueKind::Languages),
    // Video
    live("deinterlace", ValueKind::Choice(&["auto", "no", "yes"])),
    live(
        "tone-mapping",
        ValueKind::Choice(&[
            "auto",
            "clip",
            "mobius",
            "reinhard",
            "hable",
            "bt.2390",
            "bt.2446a",
            "spline",
            "st2094-40",
            "st2094-10",
        ]),
    ),
    live(
        "hdr-compute-peak",
        ValueKind::Choice(&["auto", "yes", "no"]),
    ),
    // mpv applies profiles at start; `apply-profile` cannot be undone, so it waits for a restart.
    at_start(
        "profile",
        ValueKind::ChoiceOrNone(&["fast", "high-quality"]),
    ),
    live("glsl-shaders", ValueKind::Shaders),
];

/// What the system offers for the values that must come from it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ValidationCtx {
    /// Device names from mpv's `audio-device-list`.
    pub audio_devices: Vec<String>,
    /// Font families from `system_fonts`.
    pub fonts: Vec<String>,
    /// File names directly in `config_dir/shaders`.
    pub shaders: Vec<String>,
}

/// The managed setting called `key`.
pub fn setting(key: &str) -> Option<&'static MpvSetting> {
    MPV_SETTINGS.iter().find(|setting| setting.key == key)
}

/// Checks `value` for `key` and returns what to write: the value in its normal form, or `None`
/// for "not set" (the line goes from mpv.conf). `None` in is always allowed for a managed key.
/// A key that is not managed, and a value the system does not offer (an audio device, a font
/// or a shader that is not there), is [`SettingsError::NotAllowed`]; any other bad value is
/// [`SettingsError::Invalid`].
pub fn validate_mpv(
    key: &str,
    value: Option<&str>,
    ctx: &ValidationCtx,
) -> Result<Option<String>, SettingsError> {
    let Some(setting) = setting(key) else {
        return Err(not_allowed(key));
    };
    let Some(value) = value else {
        return Ok(None);
    };
    // mpv.conf is read line by line; nothing may break out of the line.
    if value.chars().any(char::is_control) {
        return Err(invalid(key, "control characters"));
    }
    match setting.kind {
        ValueKind::Choice(words) => choice(key, value, words).map(Some),
        ValueKind::ChoiceOrNone(_) if value.is_empty() => Ok(None),
        ValueKind::ChoiceOrNone(words) => choice(key, value, words).map(Some),
        ValueKind::Flag => choice(key, value, &["yes", "no"]).map(Some),
        ValueKind::Number { min, max } => number(key, value, min, max).map(Some),
        ValueKind::Color if is_hex_color(value, &[6, 8]) => Ok(Some(value.to_owned())),
        ValueKind::Color => Err(invalid(key, "#RRGGBB or #AARRGGBB")),
        ValueKind::Languages => languages(key, value),
        ValueKind::Font => listed(&ctx.fonts, value)
            .map(|font| Some(font.to_owned()))
            .ok_or_else(|| not_allowed(key)),
        ValueKind::AudioDevice if ctx.audio_devices.iter().any(|device| device == value) => {
            Ok(Some(value.to_owned()))
        }
        ValueKind::AudioDevice => Err(not_allowed(key)),
        ValueKind::Shaders => shaders(key, value, ctx),
    }
}

/// The `glsl-shaders` entries of a value [`validate_mpv`] returned (`""` for none).
pub fn shader_entries(value: &str) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    value.split(SHADERS_SEPARATOR).map(str::to_owned).collect()
}

/// A file name that stays in its folder: no separators, no `..`, nothing mpv's path list would
/// split (`;`), no control characters.
pub fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && !name.contains("..")
        && !name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':' | ';') || c.is_control())
}

fn not_allowed(key: &str) -> SettingsError {
    SettingsError::NotAllowed {
        key: key.to_owned(),
    }
}

fn invalid(key: &str, reason: &str) -> SettingsError {
    SettingsError::invalid(key, reason)
}

fn choice(key: &str, value: &str, words: &[&str]) -> Result<String, SettingsError> {
    if words.contains(&value) {
        Ok(value.to_owned())
    } else {
        Err(invalid(key, &format!("one of {}", words.join(", "))))
    }
}

/// A finite number in the range, in its short form.
fn number(key: &str, value: &str, min: f64, max: f64) -> Result<String, SettingsError> {
    match value.parse::<f64>() {
        Ok(number) if number.is_finite() && (min..=max).contains(&number) => {
            Ok(short_number(number))
        }
        _ => Err(invalid(key, &format!("a number from {min} to {max}"))),
    }
}

/// A number the short way, as Kaleido writes it to mpv.conf: `40`, not `40.0` or mpv's own
/// `40.000000`; -0 is 0.
pub fn short_number(number: f64) -> String {
    format!("{}", number + 0.0)
}

/// `value` in the short form if it is a finite number, else as it is.
pub fn normal_number(value: &str) -> String {
    match value.parse::<f64>() {
        Ok(number) if number.is_finite() => short_number(number),
        _ => value.to_owned(),
    }
}

fn languages(key: &str, value: &str) -> Result<Option<String>, SettingsError> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    let codes: Vec<&str> = value.split(',').map(str::trim).collect();
    let valid = codes
        .iter()
        .all(|code| (2..=3).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase()));
    if valid {
        Ok(Some(codes.join(",")))
    } else {
        Err(invalid(key, "language codes such as cs,en"))
    }
}

/// The entry of `list` that is `value`, ignoring case (font families and Windows file names
/// are matched so), as the list spells it.
fn listed<'a>(list: &'a [String], value: &str) -> Option<&'a str> {
    let wanted = value.to_lowercase();
    list.iter()
        .find(|entry| entry.to_lowercase() == wanted)
        .map(String::as_str)
}

/// Each entry is a bare file name or `~~/shaders/<name>`; the value comes back as the latter,
/// joined by `;`.
fn shaders(key: &str, value: &str, ctx: &ValidationCtx) -> Result<Option<String>, SettingsError> {
    if value.is_empty() {
        return Ok(None);
    }
    let mut entries = Vec::new();
    for entry in value.split(SHADERS_SEPARATOR) {
        let name = entry.strip_prefix(SHADERS_PREFIX).unwrap_or(entry);
        if !is_plain_file_name(name) {
            return Err(invalid(key, "file names from the shaders folder"));
        }
        let name = listed(&ctx.shaders, name).ok_or_else(|| not_allowed(key))?;
        entries.push(format!("{SHADERS_PREFIX}{name}"));
    }
    Ok(Some(entries.join(&SHADERS_SEPARATOR.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ValidationCtx {
        ValidationCtx {
            audio_devices: vec!["auto".into(), "wasapi/{0.0.0.00000000}.{abc}".into()],
            fonts: vec!["Arial".into(), "Segoe UI".into()],
            shaders: vec!["Other.hook".into(), "user.glsl".into()],
        }
    }

    fn refused(key: &str) -> Result<Option<String>, SettingsError> {
        Err(SettingsError::NotAllowed { key: key.into() })
    }

    /// The allow-list is the one spec 8.10 and the plan give, no more.
    #[test]
    fn the_allow_list_is_the_planned_one() {
        let keys: Vec<&str> = MPV_SETTINGS.iter().map(|setting| setting.key).collect();
        assert_eq!(
            keys,
            [
                "hwdec",
                "autocreate-playlist",
                "save-position-on-quit",
                "ytdl-format",
                "sub-font",
                "sub-font-size",
                "sub-color",
                "sub-border-color",
                "sub-back-color",
                "sub-border-size",
                "slang",
                "audio-device",
                "volume",
                "volume-max",
                "alang",
                "deinterlace",
                "tone-mapping",
                "hdr-compute-peak",
                "profile",
                "glsl-shaders",
            ]
        );
        let waiting: Vec<&str> = MPV_SETTINGS
            .iter()
            .filter(|setting| !setting.live)
            .map(|setting| setting.key)
            .collect();
        // The default volume must not move the playing one (R25); profiles apply at start.
        assert_eq!(waiting, ["volume", "profile"]);
    }

    #[test]
    fn unknown_keys_and_bad_values_are_rejected() {
        let ctx = ctx();
        // Keys Kaleido does not manage, some of which would hand the UI the player.
        for key in [
            "vo",
            "script",
            "scripts",
            "input-conf",
            "include",
            "profile-desc",
            "glsl-shader",
            "VOLUME",
            "",
        ] {
            assert_eq!(validate_mpv(key, Some("x"), &ctx), refused(key), "{key}");
            assert_eq!(validate_mpv(key, None, &ctx), refused(key), "{key}");
        }
        // Values outside the kind of the key.
        for (key, value) in [
            ("sub-color", "red"),
            ("sub-color", "#12345"),
            ("sub-color", "#1234567"),
            ("sub-color", "#GG0000"),
            ("sub-back-color", "FF0000"),
            ("volume", "5000"),
            ("volume", "-1"),
            ("volume", "loud"),
            ("volume", "NaN"),
            ("volume", "inf"),
            ("volume", " 50"),
            ("volume-max", "99"),
            ("sub-font-size", "9"),
            ("sub-font-size", "121"),
            ("sub-border-size", "11"),
            ("slang", "cs;rm"),
            ("slang", "cs,"),
            ("slang", "CS"),
            ("slang", "czech"),
            ("alang", "en\u{0}"),
            ("hwdec", "vaapi"),
            ("hwdec", ""),
            ("autocreate-playlist", "all"),
            ("save-position-on-quit", "true"),
            ("deinterlace", "maybe"),
            ("tone-mapping", "aces"),
            ("hdr-compute-peak", "sometimes"),
            ("profile", "gpu-hq"),
            ("sub-font", "Segoe UI\n"),
            ("glsl-shaders", "../user.glsl"),
        ] {
            assert!(
                matches!(
                    validate_mpv(key, Some(value), &ctx),
                    Err(SettingsError::Invalid { key: ref k, .. }) if k == key
                ),
                "{key}={value:?} got {:?}",
                validate_mpv(key, Some(value), &ctx)
            );
        }
        // Values that have to be on the system.
        for (key, value) in [
            ("audio-device", "nic-takoveho"),
            ("audio-device", ""),
            ("sub-font", "Comic Sans MS"),
            ("glsl-shaders", "missing.glsl"),
        ] {
            assert_eq!(validate_mpv(key, Some(value), &ctx), refused(key));
        }
    }

    #[test]
    fn good_values_pass_in_their_normal_form() {
        let ctx = ctx();
        let check = |key: &str, value: Option<&str>| validate_mpv(key, value, &ctx).unwrap();
        assert_eq!(
            check("hwdec", Some("auto-safe")).as_deref(),
            Some("auto-safe")
        );
        assert_eq!(
            check("save-position-on-quit", Some("no")).as_deref(),
            Some("no")
        );
        assert_eq!(check("volume", Some("40.0")).as_deref(), Some("40"));
        assert_eq!(check("volume", Some("-0")).as_deref(), Some("0"));
        assert_eq!(check("volume-max", Some("130.5")).as_deref(), Some("130.5"));
        assert_eq!(check("sub-font-size", Some("120")).as_deref(), Some("120"));
        assert_eq!(
            check("sub-color", Some("#80ffFFff")).as_deref(),
            Some("#80ffFFff")
        );
        assert_eq!(
            check("sub-color", Some("#FFFFFF")).as_deref(),
            Some("#FFFFFF")
        );
        assert_eq!(
            check("slang", Some("cs, en,ces")).as_deref(),
            Some("cs,en,ces")
        );
        assert_eq!(check("alang", Some("")), None);
        assert_eq!(
            check("sub-font", Some("segoe ui")).as_deref(),
            Some("Segoe UI")
        );
        assert_eq!(check("audio-device", Some("auto")).as_deref(), Some("auto"));
        assert_eq!(
            check("tone-mapping", Some("bt.2446a")).as_deref(),
            Some("bt.2446a")
        );
        assert_eq!(
            check("profile", Some("high-quality")).as_deref(),
            Some("high-quality")
        );
        assert_eq!(check("profile", Some("")), None, "no profile");
        // mpv's own way of printing numbers reads as the form Kaleido writes.
        assert_eq!(normal_number("55.000000"), "55");
        assert_eq!(normal_number("1.500000"), "1.5");
        assert_eq!(normal_number("-0.000000"), "0");
        assert_eq!(normal_number("auto"), "auto");
        assert_eq!(normal_number("inf"), "inf");
        // Removing a managed key is always allowed.
        for setting in MPV_SETTINGS {
            assert_eq!(check(setting.key, None), None, "{}", setting.key);
        }
    }

    /// Plan decision 10: a preset is what a link loads with (mpv.conf's `ytdl-format`, or the
    /// quality chosen for one link), so each one passes the check `--format` and the chosen
    /// quality go through. The table is the plan's, word for word.
    #[test]
    fn presets_pass_the_format_check() {
        assert_eq!(
            STREAM_QUALITY_PRESETS,
            [
                "bv*[height<=?2160]+ba/b[height<=?2160]",
                "bv*[height<=?1440]+ba/b[height<=?1440]",
                "bv*[height<=?1080]+ba/b[height<=?1080]",
                "bv*[height<=?720]+ba/b[height<=?720]",
                "bv*[height<=?480]+ba/b[height<=?480]",
                "ba/b",
            ]
        );
        for preset in STREAM_QUALITY_PRESETS {
            let options = crate::player::load::LoadOptions {
                start: None,
                format: Some((*preset).to_owned()),
            };
            assert_eq!(options.validate(), Ok(()), "{preset}");
        }
        let unique: std::collections::BTreeSet<&str> =
            STREAM_QUALITY_PRESETS.iter().copied().collect();
        assert_eq!(unique.len(), STREAM_QUALITY_PRESETS.len());
    }

    /// The default quality is one of the presets or nothing (yt-dlp's own default); anything else,
    /// a format that would set another option among it too, is refused before mpv.conf is touched.
    #[test]
    fn ytdl_format_accepts_only_presets_or_nothing() {
        let ctx = ctx();
        let setting = setting("ytdl-format").expect("ytdl-format is managed");
        assert!(setting.live, "the next link takes it");
        assert_eq!(
            setting.kind,
            ValueKind::ChoiceOrNone(STREAM_QUALITY_PRESETS)
        );
        for preset in STREAM_QUALITY_PRESETS {
            assert_eq!(
                validate_mpv("ytdl-format", Some(preset), &ctx)
                    .unwrap()
                    .as_deref(),
                Some(*preset)
            );
        }
        assert_eq!(validate_mpv("ytdl-format", Some(""), &ctx), Ok(None));
        assert_eq!(validate_mpv("ytdl-format", None, &ctx), Ok(None));
        for bad in [
            "best,vo=gpu",
            "bestvideo+bestaudio",
            "bv*[height<=?1080]+ba/b",
            "BA/B",
            " ba/b",
            "ba/b\n",
            "ba/b\nvo=gpu",
        ] {
            assert!(
                matches!(
                    validate_mpv("ytdl-format", Some(bad), &ctx),
                    Err(SettingsError::Invalid { ref key, .. }) if key == "ytdl-format"
                ),
                "{bad:?} got {:?}",
                validate_mpv("ytdl-format", Some(bad), &ctx)
            );
        }
    }

    #[test]
    fn glsl_shaders_accept_only_files_from_the_shaders_folder() {
        let ctx = ctx();
        assert_eq!(
            validate_mpv(
                "glsl-shaders",
                Some("user.glsl;~~/shaders/other.hook"),
                &ctx
            )
            .unwrap()
            .as_deref(),
            Some("~~/shaders/user.glsl;~~/shaders/Other.hook")
        );
        assert_eq!(validate_mpv("glsl-shaders", Some(""), &ctx), Ok(None));
        for bad in [
            "../user.glsl",
            "~~/shaders/../user.glsl",
            "~~/shaders/..",
            "C:\\shaders\\user.glsl",
            "C:user.glsl",
            "sub/user.glsl",
            "~~/shaders/sub\\user.glsl",
            "~~/user.glsl",
            "user.glsl;",
            ";user.glsl",
            "user.glsl,other.hook",
        ] {
            assert!(
                validate_mpv("glsl-shaders", Some(bad), &ctx).is_err(),
                "{bad} was accepted"
            );
        }
        assert_eq!(
            shader_entries("~~/shaders/user.glsl;~~/shaders/Other.hook"),
            ["~~/shaders/user.glsl", "~~/shaders/Other.hook"]
        );
        assert!(shader_entries("").is_empty());
    }
}
