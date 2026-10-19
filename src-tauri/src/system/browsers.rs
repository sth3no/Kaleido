//! The browsers whose cookies yt-dlp can read (plan decisions 13 and 19): which of them are on this
//! PC, and the `BROWSER[:PROFILE]` spec yt-dlp takes for each. The user picks one in the settings
//! (`playback.cookiesFromBrowser`); it goes to mpv's `ytdl_hook` and to Kaleido's own `yt-dlp -J`.
//!
//! A port of `src/lib/browsers.ts` of The Downloader (MIT, the same author), its Windows part. A
//! browser is on the PC when its data folder is there; yt-dlp knows seven of them by name (Firefox,
//! Edge, Chrome, Brave, Opera, Vivaldi, Chromium), and for the others Kaleido finds the profile
//! itself: the forks of Firefox (LibreWolf, Zen, Floorp) as `firefox:<profile folder>`, Arc as
//! `chromium:<its Default profile>`.
//!
//! Chromium-based browsers are listed with a warning ([`BrowserWarning::ChromiumCookies`], plan
//! decision 19): on Windows yt-dlp mostly cannot decrypt their cookies (App-Bound encryption of
//! Chrome 127 and newer, and a running browser keeps its cookie database locked) and the link then
//! fails as a whole. Firefox and its forks work, also while the browser runs.
//!
//! Nothing here starts a process or writes to the disk; the folders are only looked at, never the
//! cookies in them.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The browsers `--cookies-from-browser` of yt-dlp takes (its `SUPPORTED_BROWSERS`).
pub const YT_DLP_BROWSERS: [&str; 9] = [
    "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
];

/// The most characters a spec may have.
pub const SPEC_LIMIT: usize = 1024;

/// The cookie database of a Firefox profile, which a profile must have to be one.
const FIREFOX_COOKIES: &str = "cookies.sqlite";

/// A spec of the form yt-dlp takes and Kaleido passes on: `BROWSER` or `BROWSER:PROFILE`, where
/// `BROWSER` is one of [`YT_DLP_BROWSERS`] (in lower case, as the UI writes it) and `PROFILE`, when
/// there is a colon, is a name or a path that is not empty. No control character (a line break
/// would end the option in a file, a NUL the string), and at most [`SPEC_LIMIT`] characters. The
/// `+KEYRING` of yt-dlp's syntax is for Linux and is not accepted; everything after the first
/// colon is the profile as yt-dlp reads it, a `::CONTAINER` of Firefox's too.
pub fn is_spec(spec: &str) -> bool {
    if spec.chars().count() > SPEC_LIMIT || spec.chars().any(char::is_control) {
        return false;
    }
    let (browser, profile) = match spec.split_once(':') {
        Some((browser, profile)) => (browser, Some(profile)),
        None => (spec, None),
    };
    YT_DLP_BROWSERS.contains(&browser) && profile.is_none_or(|profile| !profile.is_empty())
}

/// The roots the browsers keep their data under: `%LOCALAPPDATA%` and `%APPDATA%`. They come from
/// the system (Tauri's paths), not from Kaleido's own folders; the tests use made-up ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roots {
    /// `%LOCALAPPDATA%`.
    pub local: PathBuf,
    /// `%APPDATA%`.
    pub roaming: PathBuf,
}

/// A browser on this PC that yt-dlp may take cookies from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    /// `firefox`, `edge`, `chrome`, `brave`, `opera`, `vivaldi`, `chromium`, `librewolf`, `zen`,
    /// `floorp` or `arc`.
    pub id: String,
    /// The name the user reads: `Firefox`, `Microsoft Edge`, `Google Chrome`, ...
    pub label: String,
    /// What is saved as `playback.cookiesFromBrowser` and handed to yt-dlp: the id for a browser
    /// yt-dlp knows, `firefox:<profile folder>` for a fork of Firefox, `chromium:<profile folder>`
    /// for Arc. **Empty** for a browser whose profile was not found ([`BrowserWarning::NoProfile`]):
    /// yt-dlp knows neither `zen` nor `floorp`, so there is nothing to save, and the UI must not
    /// offer to save an empty spec.
    pub spec: String,
    /// Why the browser is a poor choice, if it is.
    pub warning: Option<BrowserWarning>,
}

/// Why a [`Browser`] may not work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserWarning {
    /// A Chromium-based browser: yt-dlp mostly cannot read its cookies on Windows, and the link
    /// then fails (plan decision 19).
    ChromiumCookies,
    /// A browser yt-dlp does not know by name, and no profile with cookies was found for it (it
    /// was never opened, or has none with cookies yet): `spec` is empty.
    NoProfile,
}

/// Where a browser keeps its data.
#[derive(Clone, Copy)]
enum Root {
    Local,
    Roaming,
}

/// The format of a browser's profiles.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
    Firefox,
    Chromium,
}

/// How the spec of a browser is made.
#[derive(Clone, Copy)]
enum Spec {
    /// yt-dlp knows the browser: its id is the spec, and yt-dlp finds the profile.
    Named,
    /// yt-dlp does not know the browser: Kaleido finds a profile of its family.
    Profile,
}

struct Entry {
    id: &'static str,
    label: &'static str,
    root: Root,
    /// The data folder under the root: where the browser keeps its profiles. It is there once the
    /// browser is installed and was opened.
    folder: &'static [&'static str],
    family: Family,
    spec: Spec,
}

/// The browsers in the order the user sees them: Firefox first, as the one that works.
const ENTRIES: [Entry; 11] = [
    Entry {
        id: "firefox",
        label: "Firefox",
        root: Root::Roaming,
        folder: &["Mozilla", "Firefox", "Profiles"],
        family: Family::Firefox,
        spec: Spec::Named,
    },
    Entry {
        id: "edge",
        label: "Microsoft Edge",
        root: Root::Local,
        folder: &["Microsoft", "Edge", "User Data"],
        family: Family::Chromium,
        spec: Spec::Named,
    },
    Entry {
        id: "chrome",
        label: "Google Chrome",
        root: Root::Local,
        folder: &["Google", "Chrome", "User Data"],
        family: Family::Chromium,
        spec: Spec::Named,
    },
    Entry {
        id: "brave",
        label: "Brave",
        root: Root::Local,
        folder: &["BraveSoftware", "Brave-Browser", "User Data"],
        family: Family::Chromium,
        spec: Spec::Named,
    },
    Entry {
        id: "opera",
        label: "Opera",
        root: Root::Roaming,
        folder: &["Opera Software", "Opera Stable"],
        family: Family::Chromium,
        spec: Spec::Named,
    },
    Entry {
        id: "vivaldi",
        label: "Vivaldi",
        root: Root::Local,
        folder: &["Vivaldi", "User Data"],
        family: Family::Chromium,
        spec: Spec::Named,
    },
    Entry {
        id: "chromium",
        label: "Chromium",
        root: Root::Local,
        folder: &["Chromium", "User Data"],
        family: Family::Chromium,
        spec: Spec::Named,
    },
    Entry {
        id: "librewolf",
        label: "LibreWolf",
        root: Root::Roaming,
        folder: &["librewolf", "Profiles"],
        family: Family::Firefox,
        spec: Spec::Profile,
    },
    Entry {
        id: "zen",
        label: "Zen",
        root: Root::Roaming,
        folder: &["zen", "Profiles"],
        family: Family::Firefox,
        spec: Spec::Profile,
    },
    Entry {
        id: "floorp",
        label: "Floorp",
        root: Root::Roaming,
        folder: &["Floorp", "Profiles"],
        family: Family::Firefox,
        spec: Spec::Profile,
    },
    Entry {
        id: "arc",
        label: "Arc",
        root: Root::Local,
        folder: &["Arc", "User Data"],
        family: Family::Chromium,
        spec: Spec::Profile,
    },
];

/// The browsers installed under `roots` (their data folder is there), in the order of the
/// settings page: Firefox, Edge, Chrome, Brave, Opera, Vivaldi, Chromium, LibreWolf, Zen, Floorp,
/// Arc. Reads the folders' names and the times of a few files; blocks on the disk, so not for the
/// main thread.
pub fn detect(roots: &Roots) -> Vec<Browser> {
    ENTRIES
        .iter()
        .filter_map(|entry| entry.detect(roots))
        .collect()
}

impl Entry {
    fn detect(&self, roots: &Roots) -> Option<Browser> {
        let root = match self.root {
            Root::Local => &roots.local,
            Root::Roaming => &roots.roaming,
        };
        let data = self
            .folder
            .iter()
            .fold(root.clone(), |path, part| path.join(part));
        if !data.is_dir() {
            return None;
        }
        let chromium = (self.family == Family::Chromium).then_some(BrowserWarning::ChromiumCookies);
        let (spec, warning) = match self.spec {
            Spec::Named => (self.id.to_owned(), chromium),
            Spec::Profile => {
                let found = match self.family {
                    Family::Firefox => newest_firefox_profile(&data)
                        .map(|folder| format!("firefox:{}", folder.display())),
                    Family::Chromium => default_chromium_profile(&data)
                        .map(|folder| format!("chromium:{}", folder.display())),
                };
                match found {
                    Some(spec) => (spec, chromium),
                    None => (String::new(), Some(BrowserWarning::NoProfile)),
                }
            }
        };
        Some(Browser {
            id: self.id.to_owned(),
            label: self.label.to_owned(),
            spec,
            warning,
        })
    }
}

/// The profile of a Firefox-format browser that was used last: of the folders in `profiles`, the
/// one whose `cookies.sqlite` was written last. Only a folder with that file is a profile, so an
/// empty or never-launched one does not shadow a real one. Of equal times the first by name
/// wins, so the answer does not depend on the order the disk lists them in. `None` where there is
/// no such folder or `profiles` cannot be read.
///
/// `findFirefoxProfile` of The Downloader goes by the time of the folder itself; the time of the
/// cookie file is used here, because a folder's own time moves with every lock or temporary file
/// in it, and the cookie file is what yt-dlp reads.
fn newest_firefox_profile(profiles: &Path) -> Option<PathBuf> {
    fs::read_dir(profiles)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let folder = entry.path();
            let cookies = fs::metadata(folder.join(FIREFOX_COOKIES)).ok()?;
            if !cookies.is_file() {
                return None;
            }
            Some((cookies.modified().ok()?, folder))
        })
        .max_by(|(a_time, a_folder), (b_time, b_folder)| {
            // The later time is the greater; of equal times the first by name is.
            a_time.cmp(b_time).then_with(|| b_folder.cmp(a_folder))
        })
        .map(|(_, folder)| folder)
}

/// The default profile of a Chromium-format browser: `<user_data>\Default`, when its `Cookies`
/// (older Chromium) or `Network\Cookies` (newer) is there. `None` otherwise: the cookies may be in
/// a profile of another name, and Kaleido does not guess which.
fn default_chromium_profile(user_data: &Path) -> Option<PathBuf> {
    let profile = user_data.join("Default");
    let has_cookies =
        profile.join("Cookies").is_file() || profile.join("Network").join("Cookies").is_file();
    has_cookies.then_some(profile)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::*;

    /// Roots under a temporary folder, as `%LOCALAPPDATA%` and `%APPDATA%` would be. The user's
    /// real browser folders are never read.
    fn temp_roots() -> (tempfile::TempDir, Roots) {
        let tmp = tempfile::tempdir().unwrap();
        let roots = Roots {
            local: tmp.path().join("Local"),
            roaming: tmp.path().join("Roaming"),
        };
        fs::create_dir_all(&roots.local).unwrap();
        fs::create_dir_all(&roots.roaming).unwrap();
        (tmp, roots)
    }

    /// The folder `parts` under `root`, made.
    fn folder(root: &Path, parts: &[&str]) -> PathBuf {
        let path = parts
            .iter()
            .fold(root.to_path_buf(), |path, part| path.join(part));
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// A file `name` in `dir`, last written `age` ago.
    fn file(dir: &Path, name: &str, age: Duration) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, b"x").unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
        path
    }

    const HOUR: Duration = Duration::from_secs(3600);

    fn ids(browsers: &[Browser]) -> Vec<&str> {
        browsers.iter().map(|browser| browser.id.as_str()).collect()
    }

    fn find<'a>(browsers: &'a [Browser], id: &str) -> &'a Browser {
        browsers
            .iter()
            .find(|browser| browser.id == id)
            .unwrap_or_else(|| panic!("{id} is not listed: {browsers:?}"))
    }

    /// Where each browser keeps its data, written out here again and not read from `ENTRIES`.
    const DATA_FOLDERS: [(Root, &[&str]); 11] = [
        (Root::Roaming, &["Mozilla", "Firefox", "Profiles"]),
        (Root::Local, &["Microsoft", "Edge", "User Data"]),
        (Root::Local, &["Google", "Chrome", "User Data"]),
        (
            Root::Local,
            &["BraveSoftware", "Brave-Browser", "User Data"],
        ),
        (Root::Roaming, &["Opera Software", "Opera Stable"]),
        (Root::Local, &["Vivaldi", "User Data"]),
        (Root::Local, &["Chromium", "User Data"]),
        (Root::Roaming, &["librewolf", "Profiles"]),
        (Root::Roaming, &["zen", "Profiles"]),
        (Root::Roaming, &["Floorp", "Profiles"]),
        (Root::Local, &["Arc", "User Data"]),
    ];

    /// Every browser installed, none of them opened yet: only the data folders are there.
    fn install_all(roots: &Roots) {
        for (root, parts) in DATA_FOLDERS {
            match root {
                Root::Local => folder(&roots.local, parts),
                Root::Roaming => folder(&roots.roaming, parts),
            };
        }
    }

    #[test]
    fn installed_browsers_are_found_in_their_folders() {
        let (_tmp, roots) = temp_roots();
        // Nothing installed: nothing listed, whatever else the roots hold.
        folder(&roots.local, &["Microsoft", "Edge Beta"]);
        assert!(detect(&roots).is_empty());
        // Roots that are not there at all (a made-up profile) are no error.
        let missing = Roots {
            local: roots.local.join("none"),
            roaming: roots.roaming.join("none"),
        };
        assert!(detect(&missing).is_empty());

        folder(&roots.local, &["Microsoft", "Edge", "User Data"]);
        folder(&roots.roaming, &["Mozilla", "Firefox", "Profiles"]);
        let zen = folder(
            &roots.roaming,
            &["zen", "Profiles", "abc.Default (release)"],
        );
        file(&zen, "cookies.sqlite", HOUR);

        let found = detect(&roots);

        // In the order of the list, not the order they were made in.
        assert_eq!(ids(&found), ["firefox", "edge", "zen"]);
        assert_eq!(
            found,
            [
                Browser {
                    id: "firefox".to_owned(),
                    label: "Firefox".to_owned(),
                    spec: "firefox".to_owned(),
                    warning: None,
                },
                Browser {
                    id: "edge".to_owned(),
                    label: "Microsoft Edge".to_owned(),
                    spec: "edge".to_owned(),
                    warning: Some(BrowserWarning::ChromiumCookies),
                },
                Browser {
                    id: "zen".to_owned(),
                    label: "Zen".to_owned(),
                    spec: format!("firefox:{}", zen.display()),
                    warning: None,
                },
            ]
        );
        // What the picker saves is what the settings take.
        for browser in &found {
            assert!(is_spec(&browser.spec), "{browser:?}");
        }
    }

    /// Every browser in its own folder, with the labels and the order the settings page shows.
    #[test]
    fn every_browser_has_its_folder_its_label_and_its_place() {
        let (_tmp, roots) = temp_roots();
        install_all(&roots);

        let found = detect(&roots);

        assert_eq!(
            found
                .iter()
                .map(|browser| (browser.id.as_str(), browser.label.as_str()))
                .collect::<Vec<_>>(),
            [
                ("firefox", "Firefox"),
                ("edge", "Microsoft Edge"),
                ("chrome", "Google Chrome"),
                ("brave", "Brave"),
                ("opera", "Opera"),
                ("vivaldi", "Vivaldi"),
                ("chromium", "Chromium"),
                ("librewolf", "LibreWolf"),
                ("zen", "Zen"),
                ("floorp", "Floorp"),
                ("arc", "Arc"),
            ]
        );
        // The ones yt-dlp knows by name are named; the rest have no profile here.
        for browser in &found {
            let named = YT_DLP_BROWSERS.contains(&browser.id.as_str());
            assert_eq!(browser.spec == browser.id, named, "{browser:?}");
            assert_eq!(browser.spec.is_empty(), !named, "{browser:?}");
        }
    }

    #[test]
    fn the_newest_firefox_fork_profile_wins() {
        let (_tmp, roots) = temp_roots();
        let profiles = folder(&roots.roaming, &["Floorp", "Profiles"]);
        file(&profiles.join("old.default"), "cookies.sqlite", 5 * HOUR);
        let newest = file(
            &profiles.join("new.default-release"),
            "cookies.sqlite",
            HOUR,
        );
        file(&profiles.join("middle.default"), "cookies.sqlite", 3 * HOUR);
        // A profile never launched has no cookie file, and its folder is the newest of all.
        folder(&profiles, &["empty.default"]);
        file(&profiles.join("empty.default"), "prefs.js", Duration::ZERO);
        // A loose file is no profile, a cookie file that is a folder is none either.
        file(&profiles, "profiles.ini", Duration::ZERO);
        folder(&profiles, &["odd.default", "cookies.sqlite"]);

        let found = detect(&roots);

        let spec = &find(&found, "floorp").spec;
        assert_eq!(
            *spec,
            format!(
                "firefox:{}",
                newest.parent().expect("a profile folder").display()
            )
        );
        assert!(spec.ends_with("new.default-release"), "{spec}");
        assert_eq!(find(&found, "floorp").warning, None);

        // The answer follows the times, not the names: the later one is "z".
        let (_tmp, roots) = temp_roots();
        let profiles = folder(&roots.roaming, &["librewolf", "Profiles"]);
        let older = file(&profiles.join("a.default"), "cookies.sqlite", 9 * HOUR);
        let later = file(&profiles.join("z.default"), "cookies.sqlite", HOUR);
        let found = detect(&roots);
        assert!(find(&found, "librewolf").spec.ends_with("z.default"));

        // Of equal times the first by name, whatever order the disk lists them in.
        let same = fs::metadata(&later).unwrap().modified().unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&older)
            .unwrap()
            .set_modified(same)
            .unwrap();
        let found = detect(&roots);
        assert!(find(&found, "librewolf").spec.ends_with("a.default"));
    }

    #[test]
    fn a_fork_without_a_profile_says_so() {
        let (_tmp, roots) = temp_roots();
        // LibreWolf: the folder is there and empty. Zen: a profile that never wrote cookies.
        // Floorp: not installed at all.
        folder(&roots.roaming, &["librewolf", "Profiles"]);
        let zen = folder(&roots.roaming, &["zen", "Profiles", "x.default"]);
        file(&zen, "prefs.js", Duration::ZERO);

        let found = detect(&roots);

        assert_eq!(ids(&found), ["librewolf", "zen"]);
        for id in ["librewolf", "zen"] {
            let browser = find(&found, id);
            // Listed, so that the page can say why it cannot be chosen; nothing to save.
            assert_eq!(browser.spec, "", "{id}");
            assert_eq!(browser.warning, Some(BrowserWarning::NoProfile), "{id}");
            assert!(!is_spec(&browser.spec), "an empty spec is never saved");
        }
    }

    #[test]
    fn arc_needs_a_default_profile_with_cookies() {
        // `Default\Cookies` (older Chromium).
        let (_tmp, roots) = temp_roots();
        let data = folder(&roots.local, &["Arc", "User Data"]);
        file(&data.join("Default"), "Cookies", HOUR);
        let found = detect(&roots);
        let arc = find(&found, "arc");
        assert_eq!(
            arc.spec,
            format!("chromium:{}", data.join("Default").display())
        );
        assert_eq!(arc.warning, Some(BrowserWarning::ChromiumCookies));
        assert!(is_spec(&arc.spec));

        // `Default\Network\Cookies` (newer Chromium).
        let (_tmp, roots) = temp_roots();
        let data = folder(&roots.local, &["Arc", "User Data"]);
        file(&data.join("Default").join("Network"), "Cookies", HOUR);
        let found = detect(&roots);
        let arc = find(&found, "arc");
        assert_eq!(
            arc.spec,
            format!("chromium:{}", data.join("Default").display())
        );
        assert_eq!(arc.warning, Some(BrowserWarning::ChromiumCookies));

        // No cookies in Default, or cookies only in another profile: nothing to give yt-dlp.
        for (profile, name) in [("Default", "Preferences"), ("Profile 1", "Cookies")] {
            let (_tmp, roots) = temp_roots();
            let data = folder(&roots.local, &["Arc", "User Data"]);
            file(&data.join(profile), name, HOUR);
            let found = detect(&roots);
            let arc = find(&found, "arc");
            assert_eq!(arc.spec, "", "{profile}/{name}");
            assert_eq!(
                arc.warning,
                Some(BrowserWarning::NoProfile),
                "{profile}/{name}"
            );
        }
        // A folder named Cookies is no cookie file.
        let (_tmp, roots) = temp_roots();
        let data = folder(&roots.local, &["Arc", "User Data"]);
        folder(&data, &["Default", "Cookies"]);
        assert_eq!(
            find(&detect(&roots), "arc").warning,
            Some(BrowserWarning::NoProfile)
        );

        // Not installed: not listed.
        let (_tmp, roots) = temp_roots();
        assert!(detect(&roots).is_empty());
    }

    #[test]
    fn chromium_browsers_carry_the_warning() {
        let (_tmp, roots) = temp_roots();
        install_all(&roots);
        // Arc and LibreWolf have a profile; Zen and Floorp have none.
        file(
            &roots.local.join("Arc").join("User Data").join("Default"),
            "Cookies",
            HOUR,
        );
        let profile = roots
            .roaming
            .join("librewolf")
            .join("Profiles")
            .join("p.default");
        file(&profile, "cookies.sqlite", HOUR);

        let found = detect(&roots);

        assert_eq!(found.len(), 11);
        for id in [
            "edge", "chrome", "brave", "opera", "vivaldi", "chromium", "arc",
        ] {
            assert_eq!(
                find(&found, id).warning,
                Some(BrowserWarning::ChromiumCookies),
                "{id}"
            );
        }
        // Firefox and its forks work, also while the browser runs: no warning.
        for id in ["firefox", "librewolf"] {
            assert_eq!(find(&found, id).warning, None, "{id}");
        }
        for id in ["zen", "floorp"] {
            assert_eq!(
                find(&found, id).warning,
                Some(BrowserWarning::NoProfile),
                "{id}"
            );
        }
        // The page shows the warning as a word, camelCase on the wire.
        assert_eq!(
            serde_json::to_value(find(&found, "edge")).unwrap(),
            serde_json::json!({
                "id": "edge",
                "label": "Microsoft Edge",
                "spec": "edge",
                "warning": "chromiumCookies"
            })
        );
        assert_eq!(
            serde_json::to_value(BrowserWarning::NoProfile).unwrap(),
            serde_json::json!("noProfile")
        );
    }

    #[test]
    fn specs_are_browser_and_profile() {
        let long = |length: usize| format!("firefox:{}", "p".repeat(length - "firefox:".len()));
        let (longest, too_long) = (long(SPEC_LIMIT), long(SPEC_LIMIT + 1));
        for spec in [
            "firefox",
            "edge",
            "safari",
            "whale",
            "firefox:default-release",
            r"firefox:C:\Users\Jiří Novák\AppData\Roaming\zen\Profiles\abc.Default (release)",
            r"chromium:C:\Users\Jan\AppData\Local\Arc\User Data\Default",
            "firefox:a::b",
            longest.as_str(),
        ] {
            assert!(is_spec(spec), "{spec}");
        }
        for spec in [
            "",
            "netscape",
            "Firefox",
            " firefox",
            "firefox ",
            ":default",
            "firefox:",
            "edge\n",
            "edge:p\nrofile",
            "firefox:p\tq",
            "firefox:a\0b",
            "firefox\u{7f}",
            "chrome+gnomekeyring",
            "firefox+basictext:p",
            "zen",
            "firefox;edge",
            too_long.as_str(),
        ] {
            assert!(!is_spec(spec), "{spec:?}");
        }
        // A character is one character however many bytes it takes.
        assert!(is_spec(&format!("firefox:{}", "ž".repeat(SPEC_LIMIT - 8))));
        assert!(!is_spec(&format!("firefox:{}", "ž".repeat(SPEC_LIMIT - 7))));
    }
}
