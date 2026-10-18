//! Where a plugin's files may go (spec 6.1): into its own folder in `scripts\`, its own options
//! file in `script-opts\`, and the shared `shaders\` and `fonts\`. Nothing else in the config
//! folder (`mpv.conf`, `input.conf`, `plugins.json`, another plugin's folder) is a plugin's to
//! write, and neither is a path that Windows would read as anything but plain names inside these
//! folders. [`parse`] says where a file goes, or why it may not, before anything is written.
//!
//! A destination is written with `/` or `\` between its parts. Each part must be a plain name:
//!
//! - not empty: a leading separator (`/abs.lua`, `\\server\share`), two in a row or one at the end
//!   would make the path absolute, a share, or a folder;
//! - not `.` or `..`;
//! - no `:` anywhere: a drive letter (`C:`) or an alternate data stream (`a.lua:evil`);
//! - none of the characters Windows refuses in a name (`< > " | ? *`) and no control character;
//! - not a device name of Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`, the
//!   superscript `COM¹`… and `LPT¹`… and `CONIN$`, `CONOUT$`), in any case and with an extension
//!   too (`CON.lua`, `nul.txt`): Windows opens the device instead of the file;
//! - no dot or space at its end, which Windows drops (`a. ` would be `a`);
//! - not of the form of a short (8.3) name (`SUB-SE~1`, `FSRSHA~1.GLS`): Windows may open the
//!   file or folder whose long name it abbreviates, another plugin's folder, say.

use std::fmt;
use std::path::{Component, Path, PathBuf};

use crate::paths::AppPaths;

/// mpv's folder for shaders in the config folder (`~~/shaders/`).
pub const SHADERS_DIR: &str = "shaders";
/// mpv's folder for fonts in the config folder (`~~/fonts/`).
pub const FONTS_DIR: &str = "fonts";

/// The folders a plugin's files go into, as a destination names them.
const SCRIPTS: &str = "scripts";
const SCRIPT_OPTS: &str = "script-opts";

/// Where one file of a plugin goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// `scripts/<plugin>/<rel>`: a file in the plugin's own folder, `rel` in it.
    ScriptFile { plugin: String, rel: PathBuf },
    /// `script-opts/<plugin>.conf`: the plugin's options. The user's once it is there.
    ScriptOpts { plugin: String },
    /// `shaders/<file>`, shared by all.
    Shader(PathBuf),
    /// `fonts/<file>`, shared by all.
    Font(PathBuf),
}

impl Target {
    /// The file on the disk. A script file is in `scripts\`, where a plugin that is on lives.
    pub fn path(&self, paths: &AppPaths) -> PathBuf {
        match self {
            Target::ScriptFile { plugin, rel } => paths.scripts_dir.join(plugin).join(rel),
            Target::ScriptOpts { plugin } => paths.script_opts_dir.join(format!("{plugin}.conf")),
            Target::Shader(file) => paths.config_dir.join(SHADERS_DIR).join(file),
            Target::Font(file) => paths.config_dir.join(FONTS_DIR).join(file),
        }
    }

    /// The destination as `plugins.json` records it: under the config folder, with `/`.
    pub fn dest(&self) -> String {
        match self {
            Target::ScriptFile { plugin, rel } => format!("{SCRIPTS}/{plugin}/{}", slashed(rel)),
            Target::ScriptOpts { plugin } => format!("{SCRIPT_OPTS}/{plugin}.conf"),
            Target::Shader(file) => format!("{SHADERS_DIR}/{}", slashed(file)),
            Target::Font(file) => format!("{FONTS_DIR}/{}", slashed(file)),
        }
    }
}

/// `path`, a relative path of plain names, with `/` between them.
fn slashed(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Why a destination was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// A part is empty: the path starts with a separator (absolute, a share), has two in a row or
    /// ends with one.
    EmptyPart,
    /// A part is `.` or `..`.
    DotPart,
    /// A `:`: a drive letter or an alternate data stream.
    Colon,
    /// A character Windows does not allow in a name (`< > " | ? *`), or a control character.
    BadCharacter,
    /// A device name of Windows, with an extension or not.
    ReservedName,
    /// A part ends in a dot or a space, which Windows drops.
    TrailingDotOrSpace,
    /// A part has the form of a short (8.3) name (`SUB-SE~1`), which may be another file's or
    /// folder's.
    ShortName,
    /// Not in one of the folders a plugin may write to, or in another plugin's.
    Outside,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Refusal::EmptyPart => {
                "an empty part (an absolute path, a share or a doubled separator)"
            }
            Refusal::DotPart => "a part that is . or ..",
            Refusal::Colon => "a colon (a drive or an alternate data stream)",
            Refusal::BadCharacter => "a character Windows does not allow in a name",
            Refusal::ReservedName => "a device name of Windows",
            Refusal::TrailingDotOrSpace => "a part that ends in a dot or a space",
            Refusal::ShortName => "a part of the form of a short name, which may be another's",
            Refusal::Outside => {
                "not in the plugin's own folder of scripts or its script-opts file, nor in \
                 shaders or fonts"
            }
        })
    }
}

/// A destination that was refused, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetError {
    pub dest: String,
    pub refusal: Refusal,
}

impl fmt::Display for TargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?} is refused: {}", self.dest, self.refusal)
    }
}

impl std::error::Error for TargetError {}

/// Where the file `dest` of the plugin `plugin` goes, or why it may not: only
/// `scripts/<plugin>/<…>`, `script-opts/<plugin>.conf`, `shaders/<file>` and `fonts/<file>`, with
/// parts that are plain names (see the module). The folder names are matched as they are written
/// here, and `plugin` exactly.
pub fn parse(dest: &str, plugin: &str) -> Result<Target, TargetError> {
    let refuse = |refusal| TargetError {
        dest: dest.to_owned(),
        refusal,
    };
    let parts: Vec<&str> = dest.split(['/', '\\']).collect();
    for part in &parts {
        check_part(part).map_err(refuse)?;
    }
    // A plugin that is no plain name has nowhere to go.
    check_name(plugin).map_err(|_| refuse(Refusal::Outside))?;
    match parts.as_slice() {
        [SCRIPTS, folder, rel @ ..] if *folder == plugin && !rel.is_empty() => {
            Ok(Target::ScriptFile {
                plugin: plugin.to_owned(),
                rel: rel.iter().collect(),
            })
        }
        [SCRIPT_OPTS, file] if file.strip_suffix(".conf") == Some(plugin) => {
            Ok(Target::ScriptOpts {
                plugin: plugin.to_owned(),
            })
        }
        [SHADERS_DIR, file] => Ok(Target::Shader(PathBuf::from(file))),
        [FONTS_DIR, file] => Ok(Target::Font(PathBuf::from(file))),
        _ => Err(refuse(Refusal::Outside)),
    }
}

/// Whether `name` (a plugin's name, the folder it gets in `scripts\`) is one plain name: what
/// [`parse`] asks of every part of a destination, and no separator.
pub fn check_name(name: &str) -> Result<(), Refusal> {
    if name.contains(['/', '\\']) {
        return Err(Refusal::BadCharacter);
    }
    check_part(name)
}

/// The rules of the module for one part of a path.
fn check_part(part: &str) -> Result<(), Refusal> {
    if part.is_empty() {
        return Err(Refusal::EmptyPart);
    }
    if part == "." || part == ".." {
        return Err(Refusal::DotPart);
    }
    if part.contains(':') {
        return Err(Refusal::Colon);
    }
    if part
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(Refusal::BadCharacter);
    }
    if part.ends_with(['.', ' ']) {
        return Err(Refusal::TrailingDotOrSpace);
    }
    if is_reserved(part) {
        return Err(Refusal::ReservedName);
    }
    if is_short_name(part) {
        return Err(Refusal::ShortName);
    }
    Ok(())
}

/// Whether `part` has the form of a short (8.3) name, `SUB-SE~1` or `FSRSHA~1.GLS`: a `~` and
/// digits at the end of what comes before its first dot. On a volume that keeps short names,
/// Windows opens the file or folder that has it, which may be another one.
fn is_short_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part);
    stem.rsplit_once('~')
        .is_some_and(|(_, number)| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
}

/// The device names of Windows. Windows reads a name as the device when what comes before its
/// first dot, less spaces at its end, is one of them.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM0", "COM1", "COM2", "COM3", "COM4",
    "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3",
    "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
];

fn is_reserved(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part).trim_end_matches(' ');
    RESERVED
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn paths() -> AppPaths {
        AppPaths::from_roots(
            Path::new("R"),
            Path::new("L"),
            Path::new("I"),
            Path::new("D"),
            Path::new("I"),
        )
    }

    #[test]
    fn targets_are_the_plugins_own_folder_its_options_shaders_and_fonts() {
        let paths = paths();
        for (dest, target, path, recorded) in [
            (
                "scripts/x/main.lua",
                Target::ScriptFile {
                    plugin: "x".into(),
                    rel: PathBuf::from("main.lua"),
                },
                "R/Kaleido/scripts/x/main.lua",
                "scripts/x/main.lua",
            ),
            (
                r"scripts\x\lib\util.lua",
                Target::ScriptFile {
                    plugin: "x".into(),
                    rel: ["lib", "util.lua"].iter().collect(),
                },
                "R/Kaleido/scripts/x/lib/util.lua",
                "scripts/x/lib/util.lua",
            ),
            (
                "script-opts/x.conf",
                Target::ScriptOpts { plugin: "x".into() },
                "R/Kaleido/script-opts/x.conf",
                "script-opts/x.conf",
            ),
            (
                "shaders/FSR.glsl",
                Target::Shader(PathBuf::from("FSR.glsl")),
                "R/Kaleido/shaders/FSR.glsl",
                "shaders/FSR.glsl",
            ),
            (
                r"fonts\icons.ttf",
                Target::Font(PathBuf::from("icons.ttf")),
                "R/Kaleido/fonts/icons.ttf",
                "fonts/icons.ttf",
            ),
            // Names that only look odd: a leading dot, a dot inside, a device name inside a
            // longer one.
            (
                "scripts/x/.hidden",
                Target::ScriptFile {
                    plugin: "x".into(),
                    rel: PathBuf::from(".hidden"),
                },
                "R/Kaleido/scripts/x/.hidden",
                "scripts/x/.hidden",
            ),
            (
                "scripts/x/console.lua",
                Target::ScriptFile {
                    plugin: "x".into(),
                    rel: PathBuf::from("console.lua"),
                },
                "R/Kaleido/scripts/x/console.lua",
                "scripts/x/console.lua",
            ),
        ] {
            let parsed = parse(dest, "x").unwrap_or_else(|error| panic!("{dest}: {error}"));
            assert_eq!(parsed, target, "{dest}");
            assert_eq!(parsed.path(&paths), Path::new(path), "{dest}");
            assert_eq!(parsed.dest(), recorded, "{dest}");
        }
    }

    #[test]
    fn targets_outside_the_allowed_folders_or_not_plain_names_are_refused() {
        for (dest, refusal) in [
            ("scripts/x/../../mpv.conf", Refusal::DotPart),
            ("scripts/x/./main.lua", Refusal::DotPart),
            ("shaders/../a", Refusal::DotPart),
            ("C:/a.lua", Refusal::Colon),
            ("scripts/x/a.lua:evil", Refusal::Colon),
            ("scripts/x/a.lua::$DATA", Refusal::Colon),
            (r"\\srv\s\a.lua", Refusal::EmptyPart),
            ("//srv/s/a.lua", Refusal::EmptyPart),
            ("/abs.lua", Refusal::EmptyPart),
            (r"\abs.lua", Refusal::EmptyPart),
            ("scripts//x/a.lua", Refusal::EmptyPart),
            ("scripts/x/", Refusal::EmptyPart),
            ("", Refusal::EmptyPart),
            ("scripts/x/CON.lua", Refusal::ReservedName),
            ("scripts/x/con", Refusal::ReservedName),
            ("scripts/x/Nul.tar.gz", Refusal::ReservedName),
            ("scripts/x/COM1.lua", Refusal::ReservedName),
            ("scripts/x/lpt9", Refusal::ReservedName),
            ("scripts/x/COM¹.lua", Refusal::ReservedName),
            ("scripts/x/AUX .lua", Refusal::ReservedName),
            ("fonts/PRN", Refusal::ReservedName),
            ("scripts/x/a. ", Refusal::TrailingDotOrSpace),
            ("scripts/x/a.", Refusal::TrailingDotOrSpace),
            ("scripts/x/a ", Refusal::TrailingDotOrSpace),
            ("scripts/x /a.lua", Refusal::TrailingDotOrSpace),
            ("scripts/x/a\0.lua", Refusal::BadCharacter),
            ("scripts/x/a\n.lua", Refusal::BadCharacter),
            ("scripts/x/a\u{7f}.lua", Refusal::BadCharacter),
            ("scripts/x/a?.lua", Refusal::BadCharacter),
            ("scripts/x/*.lua", Refusal::BadCharacter),
            ("scripts/x/a<b>.lua", Refusal::BadCharacter),
            ("scripts/x/a|b", Refusal::BadCharacter),
            ("scripts/x/\"a\"", Refusal::BadCharacter),
            ("scripts/SUB-SE~1/main.lua", Refusal::ShortName),
            ("scripts/x/LONGFI~1.LUA", Refusal::ShortName),
            ("shaders/FSRSHA~12.GLS", Refusal::ShortName),
            // Places that are not the plugin's.
            ("scripts/other/a.lua", Refusal::Outside),
            ("scripts/X/a.lua", Refusal::Outside),
            ("scripts/x", Refusal::Outside),
            ("scripts/a.lua", Refusal::Outside),
            ("Scripts/x/a.lua", Refusal::Outside),
            ("input.conf", Refusal::Outside),
            ("mpv.conf", Refusal::Outside),
            ("plugins.json", Refusal::Outside),
            ("script-opts/other.conf", Refusal::Outside),
            ("script-opts/x.lua", Refusal::Outside),
            ("script-opts/x/x.conf", Refusal::Outside),
            ("shaders/sub/a.glsl", Refusal::Outside),
            ("fonts/sub/a.ttf", Refusal::Outside),
            ("scripts-disabled/x/main.lua", Refusal::Outside),
            ("watch_later/x", Refusal::Outside),
        ] {
            assert_eq!(
                parse(dest, "x"),
                Err(TargetError {
                    dest: dest.to_owned(),
                    refusal
                }),
                "{dest:?}"
            );
        }
    }

    #[test]
    fn a_plugin_name_is_one_plain_name() {
        for name in [
            "x",
            "sub-select",
            "my.plugin",
            "Žluť kůň",
            "@at",
            "a~b",
            "v~2a",
            "x.v~1",
        ] {
            assert_eq!(check_name(name), Ok(()), "{name}");
        }
        for (name, refusal) in [
            ("", Refusal::EmptyPart),
            ("..", Refusal::DotPart),
            ("a/b", Refusal::BadCharacter),
            (r"a\b", Refusal::BadCharacter),
            ("C:", Refusal::Colon),
            ("con", Refusal::ReservedName),
            ("x.", Refusal::TrailingDotOrSpace),
            // The short name sub-select's folder may have.
            ("SUB-SE~1", Refusal::ShortName),
            ("~1", Refusal::ShortName),
        ] {
            assert_eq!(check_name(name), Err(refusal), "{name:?}");
        }
        // A plugin without a plain name has no target at all.
        for plugin in ["", "..", "a/b", "con"] {
            assert_eq!(
                parse("shaders/a.glsl", plugin).map(|_| ()),
                Err(TargetError {
                    dest: "shaders/a.glsl".to_owned(),
                    refusal: Refusal::Outside
                }),
                "{plugin:?}"
            );
            assert!(parse(&format!("script-opts/{plugin}.conf"), plugin).is_err());
        }
    }
}
