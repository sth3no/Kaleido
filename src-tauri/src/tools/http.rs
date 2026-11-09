//! The downloads of the tools (spec 6.6), behind [`Fetch`] so that the tests never go to the
//! network. [`Web`] is the real one: plain GETs with ureq over native-tls (schannel and the
//! system's root certificates), a limit on the size of every body, and redirects followed by hand,
//! so that every address on the way, the first one too, is on a host of the allow-list: a release
//! download from GitHub is two redirects (to the release's tag, then to the asset's storage).

use std::fmt;
use std::io::{self, Read};
use std::time::{Duration, Instant};

use ureq::http::header::LOCATION;
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
use ureq::{Agent, Body};
use url::Url;

/// The hosts a download from GitHub Releases may go through. Checked on 2026-10-19 by reading the
/// redirects (HEAD requests, nothing downloaded) of `releases/latest/download/SHA2-256SUMS` of
/// yt-dlp/yt-dlp and yt-dlp/yt-dlp-nightly-builds and of Deno's
/// `deno-x86_64-pc-windows-msvc.zip.sha256sum`: `github.com/<repo>/releases/latest/download/<asset>`
/// → `github.com/<repo>/releases/download/<tag>/<asset>` →
/// `release-assets.githubusercontent.com/github-production-release-asset/…`.
/// `objects.githubusercontent.com` is where GitHub sent the assets before
/// release-assets.githubusercontent.com; it stays on the list in case some of them go there again.
pub const ALLOWED_HOSTS: [&str; 3] = [
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];

/// How long a connection (and its TLS handshake) may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a small download (a checksum list) may take, redirects included.
pub const SMALL_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a large download (a tool) may take, redirects included, while the tool's checks have
/// not failed ([`large_timeout`]).
pub const LARGE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// The most a large download may take, however often the tool's checks failed before.
pub const LARGE_TIMEOUT_MAX: Duration = Duration::from_secs(80 * 60);
/// A download whose limit is at most this is a small one.
const SMALL_LIMIT: u64 = 1024 * 1024;
/// The redirects one download may follow; GitHub's take two.
const MAX_REDIRECTS: usize = 5;
/// What Kaleido says it is to the server.
const USER_AGENT: &str = concat!("Kaleido/", env!("CARGO_PKG_VERSION"));

/// Gets files from the network.
pub trait Fetch: Send + Sync {
    /// The body of a GET of `url`, of at most `limit` bytes: a longer one is
    /// [`FetchError::TooLarge`], however much of it came. The whole download, redirects included,
    /// may take [`SMALL_TIMEOUT`] for a small `limit` (a checksum list) and [`LARGE_TIMEOUT`]
    /// otherwise.
    fn get(&self, url: &str, limit: u64) -> Result<Vec<u8>, FetchError> {
        self.get_within(url, limit, default_timeout(limit))
    }

    /// [`get`](Fetch::get), the whole download taking at most `timeout`, redirects included.
    fn get_within(&self, url: &str, limit: u64, timeout: Duration) -> Result<Vec<u8>, FetchError>;
}

/// How long a download of at most `limit` bytes may take unless it is given a time of its own.
fn default_timeout(limit: u64) -> Duration {
    if limit <= SMALL_LIMIT {
        SMALL_TIMEOUT
    } else {
        LARGE_TIMEOUT
    }
}

/// How long the large download of a tool may take after `failures` checks of it failed in a row
/// (final review minor 5): [`LARGE_TIMEOUT`], doubled for each failure, at most
/// [`LARGE_TIMEOUT_MAX`]: 10, 20, 40, then 80 minutes. A line too slow for a tool in 10 minutes
/// (below about 70 KB/s for Deno's zip) gets more time at the next try, instead of being cut off
/// at the same point again after every backoff. Checksum lists keep their small time.
pub fn large_timeout(failures: u32) -> Duration {
    // Three doublings reach the most; more change nothing (and cannot overflow the shift).
    LARGE_TIMEOUT
        .saturating_mul(1 << failures.min(3))
        .min(LARGE_TIMEOUT_MAX)
}

/// Why a download did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The server could not be reached, or the connection broke or took too long.
    Offline,
    /// The server answered with this status instead of the file (403, 404, 5xx, a redirect
    /// without a `Location`).
    Status(u16),
    /// The body is longer than the limit.
    TooLarge,
    /// An address on the way is on this host, which is not on the allow-list.
    Host(String),
    /// Anything else: an address that is not one, a scheme other than https, too many redirects,
    /// TLS.
    Other(String),
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::Offline => f.write_str("the server cannot be reached"),
            FetchError::Status(status) => write!(f, "the server answered {status}"),
            FetchError::TooLarge => f.write_str("the file is larger than it may be"),
            FetchError::Host(host) => write!(f, "{host} is not a host the downloads may use"),
            FetchError::Other(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for FetchError {}

/// Downloads over HTTP(S) from the hosts it allows (see the module).
pub struct Web {
    agent: Agent,
    /// Lowercase.
    hosts: Vec<String>,
    https_only: bool,
}

impl Web {
    /// For GitHub Releases: only https, only [`ALLOWED_HOSTS`]; through a proxy only when the
    /// environment names one (`HTTPS_PROXY` and the like, as ureq reads them), not Windows' own
    /// proxy setting.
    pub fn github() -> Web {
        Web::new(&ALLOWED_HOSTS, true)
    }

    /// For a server on this machine (the tests): only `hosts`, plain http allowed, no proxy.
    pub fn with_hosts(hosts: &[&str]) -> Web {
        Web::new(hosts, false)
    }

    fn new(hosts: &[&str], https_only: bool) -> Web {
        let tls = TlsConfig::builder()
            .provider(TlsProvider::NativeTls)
            // The roots native-tls loads itself: the system's (schannel).
            .root_certs(RootCerts::PlatformVerifier)
            .build();
        let mut config = Agent::config_builder()
            // Followed by hand, so that every hop is checked.
            .max_redirects(0)
            // A 4xx or 5xx is a `Status`, read from the response.
            .http_status_as_error(false)
            .https_only(https_only)
            .user_agent(USER_AGENT)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .tls_config(tls);
        if !https_only {
            config = config.proxy(None);
        }
        Web {
            agent: config.build().into(),
            hosts: hosts.iter().map(|host| host.to_ascii_lowercase()).collect(),
            https_only,
        }
    }

    /// Whether a download may go to `url`.
    fn allow(&self, url: &Url) -> Result<(), FetchError> {
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        if !self.hosts.contains(&host) {
            return Err(FetchError::Host(host));
        }
        match url.scheme() {
            "https" => Ok(()),
            "http" if !self.https_only => Ok(()),
            scheme => Err(FetchError::Other(format!(
                "{scheme}: not a scheme the downloads may use"
            ))),
        }
    }
}

impl Fetch for Web {
    fn get_within(&self, url: &str, limit: u64, timeout: Duration) -> Result<Vec<u8>, FetchError> {
        let deadline = Instant::now() + timeout;
        let mut url = Url::parse(url)
            .map_err(|error| FetchError::Other(format!("not an address: {error}")))?;
        for _ in 0..=MAX_REDIRECTS {
            self.allow(&url)?;
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(FetchError::Offline);
            }
            let response = self
                .agent
                .get(url.as_str())
                .config()
                .timeout_global(Some(left))
                .build()
                .call()
                .map_err(classify)?;
            let status = response.status().as_u16();
            match status {
                200..=299 => return read_body(response.into_body(), limit),
                301 | 302 | 303 | 307 | 308 => {
                    let location = response
                        .headers()
                        .get(LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .ok_or(FetchError::Status(status))?;
                    url = url.join(location).map_err(|error| {
                        FetchError::Other(format!("a redirect to no address: {error}"))
                    })?;
                }
                _ => return Err(FetchError::Status(status)),
            }
        }
        Err(FetchError::Other("too many redirects".to_owned()))
    }
}

/// At most `limit` bytes of `body`, or [`FetchError::TooLarge`]: told by its length when it has
/// one, before anything is read.
fn read_body(body: Body, limit: u64) -> Result<Vec<u8>, FetchError> {
    let length = body.content_length();
    if length.is_some_and(|length| length > limit) {
        return Err(FetchError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(
        length
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0),
    );
    // One byte more than may come tells a body that is too long from one that is just long
    // enough.
    let most = limit.saturating_add(1);
    body.into_with_config()
        .limit(most)
        .reader()
        .take(most)
        .read_to_end(&mut bytes)
        .map_err(classify_io)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(FetchError::TooLarge);
    }
    Ok(bytes)
}

fn classify(error: ureq::Error) -> FetchError {
    match error {
        ureq::Error::StatusCode(status) => FetchError::Status(status),
        ureq::Error::HostNotFound
        | ureq::Error::ConnectionFailed
        | ureq::Error::Timeout(_)
        | ureq::Error::ConnectProxyFailed(_) => FetchError::Offline,
        ureq::Error::BodyExceedsLimit(_) => FetchError::TooLarge,
        ureq::Error::Io(error) => classify_io(error),
        other => FetchError::Other(other.to_string()),
    }
}

/// An error of reading a body: ureq's own errors (a timeout) come wrapped in it.
fn classify_io(error: io::Error) -> FetchError {
    if error
        .get_ref()
        .is_some_and(|inner| inner.is::<ureq::Error>())
    {
        return match error
            .into_inner()
            .map(|inner| inner.downcast::<ureq::Error>())
        {
            Some(Ok(inner)) => classify(*inner),
            _ => FetchError::Other("the download broke off".to_owned()),
        };
    }
    match error.kind() {
        io::ErrorKind::TimedOut
        | io::ErrorKind::ConnectionRefused
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::NotConnected
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::UnexpectedEof
        | io::ErrorKind::HostUnreachable
        | io::ErrorKind::NetworkUnreachable
        | io::ErrorKind::NetworkDown
        | io::ErrorKind::AddrNotAvailable => FetchError::Offline,
        _ => FetchError::Other(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    use super::*;

    /// The path of the HTTP request on `stream`, read up to the end of its headers.
    fn request_path(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut chunk = [0u8; 1024];
        while !request.windows(4).any(|end| end == b"\r\n\r\n") && request.len() < 16 * 1024 {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => request.extend_from_slice(&chunk[..read]),
            }
        }
        String::from_utf8_lossy(&request)
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_owned()
    }

    fn ok(body: &str, sized: bool) -> String {
        let length = if sized {
            format!("Content-Length: {}\r\n", body.len())
        } else {
            String::new()
        };
        format!("HTTP/1.1 200 OK\r\n{length}Connection: close\r\n\r\n{body}")
    }

    fn redirect(to: &str) -> String {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    /// A tiny HTTP/1.1 server on 127.0.0.1 that answers by the path, one connection at a time,
    /// as long as the tests run. Returns its port.
    fn serve() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let response = match request_path(&mut stream).as_str() {
                    "/body" => ok("hello", true),
                    "/away" => redirect(&format!("http://localhost:{port}/x")),
                    "/hop" => redirect("/body"),
                    "/loop" => redirect("/loop"),
                    "/no-location" => {
                        "HTTP/1.1 302 Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_owned()
                    }
                    "/big" => ok(&"x".repeat(100), true),
                    "/big-unsized" => ok(&"x".repeat(100), false),
                    "/exact" => ok(&"x".repeat(10), false),
                    _ => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_owned(),
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        port
    }

    /// Final review minor 5: a tool's download gets twice the time after each failed check, up
    /// to 80 minutes; a checksum list keeps its 30 seconds. Needs nothing.
    #[test]
    fn the_large_timeout_grows_with_the_failures() {
        let minutes = |count: u64| Duration::from_secs(count * 60);
        assert_eq!(large_timeout(0), minutes(10));
        assert_eq!(large_timeout(1), minutes(20));
        assert_eq!(large_timeout(2), minutes(40));
        assert_eq!(large_timeout(3), minutes(80));
        for failures in [4, 5, 31, 32, u32::MAX] {
            assert_eq!(large_timeout(failures), LARGE_TIMEOUT_MAX, "{failures}");
        }
        assert_eq!(LARGE_TIMEOUT_MAX, minutes(80));
        // What a download is given when nobody says: by its limit, as before.
        assert_eq!(default_timeout(SMALL_LIMIT), SMALL_TIMEOUT);
        assert_eq!(default_timeout(64 * 1024), SMALL_TIMEOUT);
        assert_eq!(default_timeout(SMALL_LIMIT + 1), LARGE_TIMEOUT);
        assert_eq!(large_timeout(0), LARGE_TIMEOUT);
    }

    /// The big test pass found every https download panicking in ureq 3.4.2: its
    /// `native-tls-no-default` brought native-tls in without the connector ("provider is
    /// NativeTls but feature is not enabled"). A server that speaks no TLS must be an error, not
    /// a panic. Needs only the loopback interface.
    #[test]
    fn https_goes_through_native_tls() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            // Plain text where the handshake should be, and the connection is closed.
            for mut stream in listener.incoming().flatten() {
                let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
            }
        });
        let web = Web::with_hosts(&["127.0.0.1"]);
        let fetched = web.get(&format!("https://127.0.0.1:{port}/x"), 1024);
        assert!(fetched.is_err(), "{fetched:?}");
    }

    /// Review focus 3. Needs only the loopback interface: the server is in the test.
    #[test]
    fn a_redirect_to_another_host_is_refused() {
        let port = serve();
        let web = Web::with_hosts(&["127.0.0.1"]);
        let at = |path: &str| format!("http://127.0.0.1:{port}{path}");

        // The same machine under another name is another host: refused, never asked.
        assert_eq!(
            web.get(&at("/away"), 1024),
            Err(FetchError::Host("localhost".to_owned()))
        );
        // Without a redirect, the body; through one to an allowed host, the body at its end.
        assert_eq!(web.get(&at("/body"), 1024), Ok(b"hello".to_vec()));
        assert_eq!(web.get(&at("/hop"), 1024), Ok(b"hello".to_vec()));
        // Longer than the limit, with a length or without; exactly the limit is fine.
        assert_eq!(web.get(&at("/big"), 10), Err(FetchError::TooLarge));
        assert_eq!(web.get(&at("/big-unsized"), 10), Err(FetchError::TooLarge));
        assert_eq!(web.get(&at("/exact"), 10), Ok(b"x".repeat(10)));
        // Answers that are not the file.
        assert_eq!(web.get(&at("/missing"), 1024), Err(FetchError::Status(404)));
        assert_eq!(
            web.get(&at("/no-location"), 1024),
            Err(FetchError::Status(302))
        );
        assert!(matches!(
            web.get(&at("/loop"), 1024),
            Err(FetchError::Other(_))
        ));
        // The first address is checked too, before anything is sent.
        assert_eq!(
            Web::with_hosts(&["example.com"]).get(&at("/body"), 1024),
            Err(FetchError::Host("127.0.0.1".to_owned()))
        );

        // GitHub's: its hosts only, https only; refused before any connection is made.
        let github = Web::github();
        assert_eq!(
            github.get("https://example.com/yt-dlp.exe", 1024),
            Err(FetchError::Host("example.com".to_owned()))
        );
        assert_eq!(
            github.get(&at("/body"), 1024),
            Err(FetchError::Host("127.0.0.1".to_owned()))
        );
        assert!(matches!(
            github.get(
                "http://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS",
                1024
            ),
            Err(FetchError::Other(_))
        ));
        assert!(matches!(
            github.get("not an address", 1024),
            Err(FetchError::Other(_))
        ));
    }
}
