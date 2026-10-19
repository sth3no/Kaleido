//! Why a link did not play (plan decisions 8, 12 and 19, spec 10.3): the class of a yt-dlp
//! failure, read from the lines mpv's `ytdl_hook` script logged while it handled the entry.
//!
//! `ytdl_hook` runs yt-dlp when a link is opened. When yt-dlp fails it logs yt-dlp's stderr, one
//! mpv log line per line of it (prefix `ytdl_hook`, level `error`), and then
//! `youtube-dl failed: <why>`. [`HookLog`] keeps the last of these lines of the entry that plays,
//! and [`classify`] says which of the [`StreamError`] classes the failure is: that decides what the
//! error card offers (update yt-dlp and try again, use the cookies of a browser, only an
//! explanation, or try again).
//!
//! The wording is yt-dlp's, which changes, and the short pieces below are matched anywhere in a
//! line (lowercase, a typographic apostrophe taken for the plain one): the extractors' own
//! `Private video` or `Sign in to confirm you're not a bot` come from the sites, and a piece that
//! stops matching leaves the failure unclassified (`None`: the UI says only that the link failed).
//! The one reliable sign of an extractor that is out of date is its closing request to report the
//! issue and to confirm the latest version: the failures yt-dlp expects (sign-in, region, network)
//! never have it.

use std::collections::VecDeque;

use serde::Serialize;

use super::load::{is_http, scheme};

/// The log prefix of mpv's `ytdl_hook` script, which is the name of the script.
pub const HOOK_PREFIX: &str = "ytdl_hook";

/// The most lines of `ytdl_hook` kept for an entry: the last ones decide, and a yt-dlp that is
/// verbose has nothing more to say to this.
pub const HOOK_LINES: usize = 20;

/// What was wrong with a link (the `streamError` of `player:end-file`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamError {
    /// yt-dlp does not understand the site any more: an extractor that is out of date. A newer
    /// yt-dlp may.
    Outdated,
    /// There is no yt-dlp to run: it is still being downloaded, or the download failed (plan
    /// decision 8). Same card as [`StreamError::Outdated`].
    Missing,
    /// The cookies of the browser the user chose cannot be read (plan decision 19: the Chromium
    /// browsers' app-bound encryption, or a browser that runs and locks its database).
    Cookies,
    /// The site wants the user signed in (also "confirm you are not a bot").
    SignIn,
    /// The video is for adults, and the site wants to know the user is one.
    AgeRestricted,
    /// Not available in the user's region.
    GeoBlocked,
    /// A private video.
    Private,
    /// Deleted, terminated, or never there.
    Removed,
    /// yt-dlp could not reach the site.
    Network,
}

impl StreamError {
    /// Whether a newer yt-dlp may mend it: the extractor is out of date, or there is no yt-dlp
    /// (spec 6.6: the check of yt-dlp that is made at every such failure).
    pub fn wants_new_yt_dlp(self) -> bool {
        matches!(self, StreamError::Outdated | StreamError::Missing)
    }
}

/// The classes in the order they are tried on one line: the most specific first. A line that says
/// both `Sign in to confirm your age` (age) and `Sign in to confirm` (sign-in) is the first; a
/// `Video unavailable` that gives its reason (region, private) is that reason, not just removed.
const ORDER: [StreamError; 9] = [
    StreamError::Missing,
    StreamError::Cookies,
    StreamError::AgeRestricted,
    StreamError::SignIn,
    StreamError::GeoBlocked,
    StreamError::Private,
    StreamError::Removed,
    StreamError::Network,
    StreamError::Outdated,
];

/// Whether `line` (already lowercase, see [`classify`]) is one of `class`.
fn says(class: StreamError, line: &str) -> bool {
    let any = |pieces: &[&str]| pieces.iter().any(|piece| line.contains(piece));
    match class {
        StreamError::Missing => any(&["youtube-dl failed: not found or not enough permissions"]),
        StreamError::Cookies => {
            any(&[
                "failed to decrypt with dpapi",
                "could not copy chrome cookie database",
                "cannot decrypt v10 cookies",
            ]) || (line.contains("cookies database") && line.contains("could not find"))
        }
        StreamError::AgeRestricted => any(&[
            "confirm your age",
            "age-restricted",
            "age restricted",
            "inappropriate for some users",
        ]),
        StreamError::SignIn => any(&[
            "sign in to confirm",
            "use --cookies-from-browser or --cookies",
            "only available for registered users",
            "login required",
            "captcha",
            "your ip is likely being blocked",
            "rate-limited by youtube",
            "members-only",
        ]),
        StreamError::GeoBlocked => any(&[
            "geo restriction",
            "not available from your location",
            "not made this video available in your country",
            "not available in your country",
        ]),
        StreamError::Private => any(&["private video", "this video is private"]),
        StreamError::Removed => any(&[
            "video unavailable",
            "has been removed",
            "has been terminated",
            "no longer available",
            "http error 404",
            "drm protected",
        ]),
        // A server that answered with an error is not a network that failed: 404 is `Removed`
        // above, 403 is `Outdated` below, and any other 4xx or 5xx is nothing we know.
        StreamError::Network => {
            !any(&["http error 4", "http error 5"])
                && any(&[
                    "unable to download webpage",
                    "unable to download api page",
                    "getaddrinfo failed",
                    "errno 11001",
                    "failed to resolve",
                    "max retries exceeded",
                    "timed out",
                    "connection reset",
                    "10054",
                    "connection aborted",
                    "remote end closed connection",
                    "network is unreachable",
                ])
        }
        StreamError::Outdated => any(&[
            "please report this issue on",
            "confirm you are on the latest version",
            "unable to extract",
            "failed to extract any player response",
            "cannot identify player",
            "requested format is not available",
            "no video formats found",
            "http error 403",
        ]),
    }
}

/// The class of one line, if it is one.
fn classify_line(line: &str) -> Option<StreamError> {
    let line = line.to_lowercase().replace('\u{2019}', "'");
    ORDER.into_iter().find(|&class| says(class, &line))
}

/// The class of the failure the `lines` of `ytdl_hook` (oldest first) tell, if any: the last line
/// that is one of the classes decides. yt-dlp's own words come before `youtube-dl failed:
/// unexpected error occurred`, which is one of none, so they decide.
pub fn classify(lines: &[&str]) -> Option<StreamError> {
    lines.iter().rev().find_map(|line| classify_line(line))
}

/// Whether `filename`, as mpv's `playlist` has it, is an http(s) link: the entries `ytdl_hook`
/// runs yt-dlp for. A file on a disk never has a stream error.
pub fn is_link(filename: &str) -> bool {
    scheme(filename).is_some_and(is_http)
}

/// The last lines of `ytdl_hook` for the entry that plays now.
#[derive(Debug, Default)]
pub struct HookLog {
    lines: VecDeque<String>,
}

impl HookLog {
    /// A message of mpv's log (a warning or worse, the caller has seen to that): kept when it is
    /// `ytdl_hook`'s, one line at a time, the oldest dropping out beyond [`HOOK_LINES`].
    pub fn note(&mut self, prefix: &str, text: &str) {
        if prefix != HOOK_PREFIX {
            return;
        }
        for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
            if self.lines.len() == HOOK_LINES {
                self.lines.pop_front();
            }
            self.lines.push_back(line.to_owned());
        }
    }

    /// A new entry starts, or the one that played has loaded: what was logged is not about the
    /// next failure.
    pub fn clear(&mut self) {
        self.lines.clear();
    }

    /// [`classify`] for the lines kept.
    pub fn class(&self) -> Option<StreamError> {
        let lines: Vec<&str> = self.lines.iter().map(String::as_str).collect();
        classify(&lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every piece of the list of yt-dlp's messages (plan, "Zprávy yt-dlp") in a line the way
    /// yt-dlp writes it, the ones of the plan's examples word for word.
    #[test]
    fn classify_real_yt_dlp_messages() {
        use StreamError::*;
        let cases: &[(&str, StreamError)] = &[
            // Missing: ytdl_hook's own line, when no yt-dlp could be run.
            (
                "youtube-dl failed: not found or not enough permissions",
                Missing,
            ),
            // Cookies of the browser (plan decision 19).
            (
                "ERROR: Failed to decrypt with DPAPI. See https://github.com/yt-dlp/yt-dlp/issues/10927 for more info",
                Cookies,
            ),
            (
                "ERROR: Could not copy Chrome cookie database. See  https://github.com/yt-dlp/yt-dlp/issues/7271  for more info",
                Cookies,
            ),
            (
                r"ERROR: could not find firefox cookies database in C:\Users\Jan\AppData\Roaming\Mozilla\Firefox\Profiles",
                Cookies,
            ),
            ("ERROR: Cannot decrypt v10 cookies: no key found", Cookies),
            // Age.
            (
                "ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.",
                AgeRestricted,
            ),
            (
                "ERROR: [youtube] abc: This video is age-restricted and only available on YouTube",
                AgeRestricted,
            ),
            (
                "ERROR: [generic] abc: This content is age restricted",
                AgeRestricted,
            ),
            (
                "ERROR: [youtube] abc: This video may be inappropriate for some users",
                AgeRestricted,
            ),
            // Sign in.
            (
                "ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.",
                SignIn,
            ),
            (
                "ERROR: [instagram] abc: This content is only available for registered users who follow this account",
                SignIn,
            ),
            ("ERROR: [instagram] abc: Login required", SignIn),
            (
                "ERROR: [generic] abc: Please solve the CAPTCHA to continue",
                SignIn,
            ),
            (
                "ERROR: [youtube] abc: Your IP is likely being blocked by Youtube. Try again later",
                SignIn,
            ),
            (
                "ERROR: [youtube] abc: This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour",
                SignIn,
            ),
            (
                "ERROR: [youtube] abc: Join this channel to get access to members-only content like this video",
                SignIn,
            ),
            // Region.
            (
                "Video unavailable. The uploader has not made this video available in your country",
                GeoBlocked,
            ),
            (
                "ERROR: [tver] abc: Access blocked by geo restriction",
                GeoBlocked,
            ),
            (
                "ERROR: [vimeo] abc: This video is not available from your location",
                GeoBlocked,
            ),
            (
                "ERROR: [dailymotion] abc: This video is not available in your country",
                GeoBlocked,
            ),
            // Private.
            (
                "ERROR: [youtube] abc: Private video. Sign in if you’ve been granted access to this video",
                Private,
            ),
            ("ERROR: [vimeo] abc: This video is private", Private),
            (
                "ERROR: [youtube] abc: Video unavailable. This video is private",
                Private,
            ),
            // Removed.
            ("ERROR: [youtube] abc: Video unavailable", Removed),
            (
                "ERROR: [youtube] abc: This video has been removed for violating YouTube's Terms of Service",
                Removed,
            ),
            (
                "ERROR: [youtube] abc: This account has been terminated for a violation of YouTube's policy",
                Removed,
            ),
            (
                "ERROR: [vimeo] abc: This video is no longer available",
                Removed,
            ),
            (
                "ERROR: [generic] abc: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)",
                Removed,
            ),
            ("ERROR: [youtube] abc: This video is DRM protected", Removed),
            // Network.
            (
                "ERROR: [youtube] x: Unable to download API page: [Errno 11001] getaddrinfo failed (caused by TransportError('[Errno 11001] getaddrinfo failed'))",
                Network,
            ),
            (
                "ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed> (caused by URLError(gaierror(11001, 'getaddrinfo failed')))",
                Network,
            ),
            (
                "ERROR: [generic] abc: Unable to download webpage: EOF occurred in violation of protocol",
                Network,
            ),
            (
                "ERROR: [generic] abc: [Errno 11001] No such host is known",
                Network,
            ),
            ("ERROR: [generic] abc: getaddrinfo failed", Network),
            (
                "ERROR: [generic] abc: Failed to resolve 'example.com'",
                Network,
            ),
            (
                "ERROR: [generic] abc: HTTPSConnectionPool(host='example.com', port=443): Max retries exceeded with url: /v",
                Network,
            ),
            (
                "ERROR: [generic] abc: The read operation timed out",
                Network,
            ),
            ("ERROR: [generic] abc: Connection reset by peer", Network),
            (
                "ERROR: [generic] abc: [WinError 10054] An existing connection was forcibly closed by the remote host",
                Network,
            ),
            ("ERROR: [generic] abc: Connection aborted.", Network),
            (
                "ERROR: [generic] abc: Remote end closed connection without response",
                Network,
            ),
            (
                "ERROR: [generic] abc: [Errno 101] Network is unreachable",
                Network,
            ),
            // Outdated.
            (
                "ERROR: [youtube] abc: Unable to extract uploader id; please report this issue on https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using yt-dlp -U",
                Outdated,
            ),
            (
                "ERROR: [vimeo] abc: Cannot parse data; please report this issue on https://github.com/yt-dlp/yt-dlp/issues?q=",
                Outdated,
            ),
            (
                "ERROR: [generic] abc: Something changed. Confirm you are on the latest version using yt-dlp -U",
                Outdated,
            ),
            (
                "ERROR: [youtube] abc: Unable to extract initial data",
                Outdated,
            ),
            (
                "ERROR: [youtube] abc: Failed to extract any player response",
                Outdated,
            ),
            (
                "ERROR: [youtube] abc: Cannot identify player 1a2b3c4d",
                Outdated,
            ),
            (
                "ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats",
                Outdated,
            ),
            ("ERROR: [generic] abc: No video formats found!", Outdated),
            (
                "ERROR: [generic] abc: unable to download video data: HTTP Error 403: Forbidden",
                Outdated,
            ),
        ];
        for &(line, expected) in cases {
            assert_eq!(classify(&[line]), Some(expected), "{line}");
        }
    }

    /// The first class that fits a line decides, in the order of the plan: the most specific
    /// first.
    #[test]
    fn classes_are_tried_in_order_within_a_line() {
        use StreamError::*;
        for (line, expected) in [
            (
                "Sign in to confirm your age. This video may be inappropriate for some users.",
                AgeRestricted,
            ),
            (
                "ERROR: Failed to decrypt with DPAPI; use --cookies-from-browser or --cookies",
                Cookies,
            ),
            (
                "Video unavailable. The uploader has not made this video available in your country",
                GeoBlocked,
            ),
            ("Video unavailable. This video is private", Private),
            (
                "Unable to download API page: timed out; please report this issue on https://github.com/yt-dlp/yt-dlp/issues",
                Network,
            ),
        ] {
            assert_eq!(classify(&[line]), Some(expected), "{line}");
        }
    }

    /// An answer of the server is not a network failure: 404 is a video that is gone, 403 a site
    /// that changed, and the rest is nothing we know.
    #[test]
    fn a_http_error_is_never_a_network_failure() {
        for (line, expected) in [
            (
                "ERROR: [generic] abc: Unable to download webpage: HTTP Error 404: Not Found",
                Some(StreamError::Removed),
            ),
            (
                "ERROR: [generic] abc: Unable to download webpage: HTTP Error 403: Forbidden",
                Some(StreamError::Outdated),
            ),
            (
                "ERROR: [generic] abc: Unable to download webpage: HTTP Error 503: Service Unavailable",
                None,
            ),
            (
                "ERROR: [generic] abc: Unable to download webpage: HTTP Error 429: Too Many Requests",
                None,
            ),
        ] {
            assert_eq!(classify(&[line]), expected, "{line}");
        }
    }

    #[test]
    fn the_last_matching_line_decides() {
        let removed = "ERROR: [youtube] abc: Video unavailable";
        let sign_in = "ERROR: [youtube] abc: Sign in to confirm you’re not a bot";
        // yt-dlp's stderr, then ytdl_hook's own closing line, which is one of none.
        let closing = "youtube-dl failed: unexpected error occurred";
        assert_eq!(
            classify(&[removed, sign_in, closing]),
            Some(StreamError::SignIn)
        );
        assert_eq!(
            classify(&[sign_in, removed, closing]),
            Some(StreamError::Removed)
        );
        assert_eq!(
            classify(&[
                "ERROR: [youtube] abc: Private video. Sign in if you’ve been granted access to this video",
                closing
            ]),
            Some(StreamError::Private)
        );
        // The last line that is one of the classes, not the highest class: a missing yt-dlp is the
        // first of the classes, and this line is a later one.
        assert_eq!(
            classify(&[
                "youtube-dl failed: not found or not enough permissions",
                removed
            ]),
            Some(StreamError::Removed)
        );
    }

    #[test]
    fn unrelated_lines_classify_as_nothing() {
        assert_eq!(classify(&[]), None);
        for line in [
            "youtube-dl failed: unexpected error occurred",
            "youtube-dl failed: failed to parse JSON data: Expecting value: line 1 column 1 (char 0)",
            "ERROR: [youtube] abc: Premieres in 3 hours",
            "ERROR: Unsupported URL: https://example.com/watch",
            "WARNING: [youtube] abc: nsig extraction failed: some formats may be missing",
            "",
        ] {
            assert_eq!(classify(&[line]), None, "{line}");
        }
        assert_eq!(
            classify(&[
                "ERROR: Unsupported URL: https://example.com/watch",
                "youtube-dl failed: unexpected error occurred"
            ]),
            None
        );
    }

    #[test]
    fn only_a_new_yt_dlp_mends_an_outdated_or_missing_one() {
        use StreamError::*;
        for class in [Outdated, Missing] {
            assert!(class.wants_new_yt_dlp(), "{class:?}");
        }
        for class in [
            Cookies,
            SignIn,
            AgeRestricted,
            GeoBlocked,
            Private,
            Removed,
            Network,
        ] {
            assert!(!class.wants_new_yt_dlp(), "{class:?}");
        }
    }

    #[test]
    fn the_names_the_ui_gets() {
        use StreamError::*;
        for (class, name) in [
            (Outdated, "outdated"),
            (Missing, "missing"),
            (Cookies, "cookies"),
            (SignIn, "signIn"),
            (AgeRestricted, "ageRestricted"),
            (GeoBlocked, "geoBlocked"),
            (Private, "private"),
            (Removed, "removed"),
            (Network, "network"),
        ] {
            assert_eq!(serde_json::to_value(class).unwrap(), name);
        }
    }

    #[test]
    fn links_are_http_and_https_in_any_case() {
        for link in [
            "https://www.youtube.com/watch?v=abc",
            "http://example.com/a.mp4",
            "HTTPS://example.com/a",
            "Http://example.com/a",
        ] {
            assert!(is_link(link), "{link}");
        }
        for file in [
            r"C:\Videa\a.mkv",
            r"\\server\share\a.mkv",
            "ftp://example.com/a",
            "edl://a",
            "file:///C:/a.mkv",
            "",
        ] {
            assert!(!is_link(file), "{file}");
        }
    }

    /// Only `ytdl_hook` speaks for yt-dlp, and a message of several lines is its lines.
    #[test]
    fn the_hook_log_keeps_the_lines_of_ytdl_hook() {
        let mut log = HookLog::default();
        log.note("ffmpeg", "ERROR: Private video");
        log.note("cplayer", "ERROR: Private video");
        assert_eq!(log.class(), None);

        log.note(HOOK_PREFIX, "ERROR: [youtube] abc: Private video");
        assert_eq!(log.class(), Some(StreamError::Private));

        log.clear();
        assert_eq!(log.class(), None);

        // Split in lines: the last one decides (taken whole, the first class in the order would).
        log.note(
            HOOK_PREFIX,
            "youtube-dl failed: not found or not enough permissions\r\n\r\nERROR: Video unavailable\n",
        );
        assert_eq!(log.class(), Some(StreamError::Removed));
    }

    #[test]
    fn the_hook_log_keeps_the_last_twenty_lines() {
        let filler = |log: &mut HookLog, count: usize| {
            for index in 0..count {
                log.note(HOOK_PREFIX, &format!("WARNING: nothing to see ({index})"));
            }
        };
        let mut log = HookLog::default();
        log.note(HOOK_PREFIX, "ERROR: [youtube] abc: Private video");
        filler(&mut log, HOOK_LINES - 1);
        assert_eq!(log.class(), Some(StreamError::Private), "the 20th line");

        filler(&mut log, 1);
        assert_eq!(log.class(), None, "the 21st pushed the first out");
        assert_eq!(log.lines.len(), HOOK_LINES);

        // The lines that matter come last, and the oldest of the rest are the ones to go.
        log.note(HOOK_PREFIX, "ERROR: [youtube] abc: Video unavailable");
        assert_eq!(log.class(), Some(StreamError::Removed));
        assert_eq!(log.lines.len(), HOOK_LINES);
    }
}
