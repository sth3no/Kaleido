//! The name mpv knows a script by, and the scripts Kaleido will not run beside its own interface.
//!
//! mpv names every script it loads from the entry in `scripts\` (`player/scripting.c`,
//! `mp_load_script` and `script_name_from_filename`, then `mp_new_client` in `player/client.c`;
//! read at the commit the pinned build is made from, accb7b2821). That name is the script's
//! client: `script-message-to`, `mp.get_script_name()`, the identifier `read_options` takes by
//! default (`script-opts\<name>.conf`) and the prefix of its lines in the log use it. The rule,
//! step by step:
//!
//! 1. A **folder** is named by the folder, whole: `dot.dir` stays `dot.dir`, a leading `@` stays.
//!    A **file** is named by the file name without its last extension (`my.plugin.lua` →
//!    `my.plugin`), and a leading `@` of the file name is dropped first (`@osc.lua` → `osc`).
//! 2. Whatever the name is, `mp_new_client` keeps its first 60 bytes and turns every byte that is
//!    not an ASCII letter or digit into `_`. Bytes, not characters: `ž` is two bytes of UTF-8, so
//!    it becomes `__`.
//! 3. A name that a running client has already is followed by its number: the second `thumbfast`
//!    is `thumbfast2`. That depends on what else runs, so it is not part of [`script_name`];
//!    [`super::scan::duplicates`] finds the scripts that collide.
//!
//! The test `script_names_match_mpvs_clients` (scan.rs) checks this against a real libmpv.

/// The scripting languages whose scripts Kaleido lists, by file extension (mpv has more: C
/// plugins and `.run` programs are not plugins in Kaleido's sense).
pub const EXTENSIONS: &[&str] = &["lua", "js"];

/// Scripts that draw their own user interface over the video, as Kaleido does. They cannot run
/// beside it (spec 6.5), by the lowercase name of the script. Until the index of the store
/// (M3) says it per plugin, this is the list.
pub const INCOMPATIBLE: &[&str] = &["uosc", "modernz"];

/// The clients mpv makes in Kaleido's core before it loads the scripts in `scripts\`: the main
/// handle and the built-in scripts (`mp_load_builtin_scripts` runs first; the OSC is off in
/// Kaleido). A user's script of one of these names is numbered by mpv (`stats.lua` is `stats2`).
pub const BUILT_IN_CLIENTS: &[&str] = &[
    "main",
    "select",
    "commands",
    "positioning",
    "context_menu",
    "console",
    "stats",
    "ytdl_hook",
    "auto_profiles",
];

/// `MAX_CLIENT_NAME` (64) of mpv, less the room `mp_new_client` keeps for the number of a second
/// client of the same name (up to three digits) and the terminating zero.
const MAX_NAME: usize = 60;

/// The name mpv gives the script in `scripts\` whose entry is called `entry`, a file name or a
/// folder name (no path). A name that ends in a script extension ([`EXTENSIONS`], in any case)
/// is a file, any other a folder. A folder whose name ends in `.lua` is the one case this guesses
/// wrong; whoever looked at the disk uses [`file_script_name`] or [`folder_script_name`].
pub fn script_name(entry: &str) -> String {
    if extension(entry).is_some() {
        file_script_name(entry)
    } else {
        folder_script_name(entry)
    }
}

/// The name of the script in the file `file` (with its extension): `mp_load_script`'s
/// `script_name_from_filename`.
pub fn file_script_name(file: &str) -> String {
    let file = file.strip_prefix('@').unwrap_or(file);
    let stem = file.rfind('.').map_or(file, |dot| &file[..dot]);
    client_name(stem)
}

/// The name of the script in the folder `dir` (which has a `main.lua` or `main.js`).
pub fn folder_script_name(dir: &str) -> String {
    client_name(dir)
}

/// What `mp_new_client` makes of a name. The result is ASCII, so cutting it at a byte is cutting
/// it at a character.
fn client_name(name: &str) -> String {
    name.bytes()
        .take(MAX_NAME)
        .map(|byte| {
            if byte.is_ascii_alphanumeric() {
                char::from(byte)
            } else {
                '_'
            }
        })
        .collect()
}

/// The extension of `file` if it is one of [`EXTENSIONS`], in the case it is written in. mpv
/// compares the extension without regard to case.
pub fn extension(file: &str) -> Option<&str> {
    let (_, extension) = file.rsplit_once('.')?;
    EXTENSIONS
        .iter()
        .any(|known| extension.eq_ignore_ascii_case(known))
        .then_some(extension)
}

/// Whether a plugin is one of [`INCOMPATIBLE`]: by its `name` (the folder, or the file with or
/// without its extension) or by the `script_name` mpv knows it by, without regard to case.
pub fn is_incompatible(name: &str, script_name: &str) -> bool {
    let name = match extension(name) {
        Some(extension) => &name[..name.len() - extension.len() - 1],
        None => name,
    };
    INCOMPATIBLE
        .iter()
        .any(|known| name.eq_ignore_ascii_case(known) || script_name.eq_ignore_ascii_case(known))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_names_follow_mpvs_rule() {
        // A folder is named by the folder, a file by the file without its extension, and every
        // byte that is not a letter or a digit becomes an underscore.
        assert_eq!(script_name("sub-select"), "sub_select");
        assert_eq!(script_name("my-plugin.lua"), "my_plugin");
        assert_eq!(script_name("thumbfast"), "thumbfast");
        assert_eq!(script_name("thumbfast.lua"), "thumbfast");
        // UTF-8 bytes, two for each of these letters.
        assert_eq!(script_name("žluť.lua"), "__lu__");
        assert_eq!(script_name("Žluť kůň.lua"), "__lu___k____");
        assert_eq!(script_name("Žluť kůň"), "__lu___k____");
        // The case of a name is kept, the case of the extension does not matter.
        assert_eq!(script_name("Shout.LUA"), "Shout");
        assert_eq!(script_name("Mixed-Case.Js"), "Mixed_Case");
    }

    #[test]
    fn dots_and_at_signs_are_treated_as_mpv_treats_them() {
        // A file loses its last extension only; the dots before it become underscores.
        assert_eq!(script_name("my.plugin.lua"), "my_plugin");
        assert_eq!(script_name("a.b.js"), "a_b");
        // A folder is not cut at a dot: it has no extension.
        assert_eq!(script_name("dot.dir"), "dot_dir");
        assert_eq!(folder_script_name("dot.dir"), "dot_dir");
        // The one case the name alone cannot tell: a folder that ends like a file.
        assert_eq!(file_script_name("foo.lua"), "foo");
        assert_eq!(folder_script_name("foo.lua"), "foo_lua");
        // A leading @ is dropped from a file name (mpv's own scripts are @osc.lua, ...) and is an
        // underscore in a folder name.
        assert_eq!(script_name("@at.lua"), "at");
        assert_eq!(script_name("@dir"), "_dir");
        assert_eq!(folder_script_name("@dir"), "_dir");
        // Only the first one; the second is a character like another.
        assert_eq!(script_name("@@at.lua"), "_at");
    }

    #[test]
    fn a_long_name_is_cut_to_what_mpv_keeps() {
        let long = "x".repeat(70);
        assert_eq!(script_name(&format!("{long}.lua")), "x".repeat(60));
        assert_eq!(script_name(&long), "x".repeat(60));
        // Sixty bytes, not sixty characters: thirty two-byte letters are sixty underscores, and the
        // thirty-first is gone.
        assert_eq!(script_name(&"ž".repeat(31)), "_".repeat(60));
        // The cut comes after the extension is off.
        assert_eq!(
            script_name(&format!("{}.lua", "y".repeat(60))),
            "y".repeat(60)
        );
    }

    #[test]
    fn extensions_are_the_script_languages_in_any_case() {
        assert_eq!(extension("a.lua"), Some("lua"));
        assert_eq!(extension("a.b.JS"), Some("JS"));
        assert_eq!(extension("a.txt"), None);
        assert_eq!(extension("lua"), None);
        assert_eq!(extension("a.luac"), None);
    }

    #[test]
    fn uosc_and_modernz_are_incompatible() {
        assert!(is_incompatible("uosc", "uosc"));
        assert!(is_incompatible("ModernZ", "ModernZ"));
        assert!(is_incompatible("modernz.lua", "modernz"));
        assert!(is_incompatible("modernz.lua", ""));
        assert!(is_incompatible("UOSC.LUA", ""));
        // By the name mpv knows, too, whatever the entry is called.
        assert!(is_incompatible("my copy", "uosc"));

        assert!(!is_incompatible("thumbfast", "thumbfast"));
        assert!(!is_incompatible("sub-select", "sub_select"));
        assert!(!is_incompatible("uosc-extras", "uosc_extras"));
        assert!(!is_incompatible("not-modernz.lua", "not_modernz"));
    }
}
