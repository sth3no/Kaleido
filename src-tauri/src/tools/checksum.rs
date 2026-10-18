//! The checksums the tools are verified with (spec 6.6): the SHA-256 of what was downloaded, and
//! the one the release publishes for it, read from yt-dlp's `SHA2-256SUMS` or Deno's
//! `<asset>.sha256sum`. Every checksum comes out as lowercase hex, so that two of them compare as
//! strings.

use sha2::{Digest, Sha256};

/// The length of a SHA-256 in hex.
const HEX_LEN: usize = 64;

/// The SHA-256 of `bytes` as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The checksum of `asset` in a `sha256sum` list such as yt-dlp's `SHA2-256SUMS`: lines of
/// `<64 hex><space><space or *><name>` (text or binary mode), the name exactly `asset`. Other
/// names, empty lines and lines of another form are skipped, and a CR before the line end is
/// fine. `None` when no line names `asset`, or when two lines give it different checksums.
pub fn from_sums(text: &str, asset: &str) -> Option<String> {
    let mut found: Option<String> = None;
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some((hex, rest)) = split_hex(line) else {
            continue;
        };
        let name = rest.strip_prefix("  ").or_else(|| rest.strip_prefix(" *"));
        if name != Some(asset) {
            continue;
        }
        let hex = hex.to_ascii_lowercase();
        if found.as_ref().is_some_and(|earlier| *earlier != hex) {
            return None;
        }
        found = Some(hex);
    }
    found
}

/// The checksum in a file that holds one, such as Deno's `<asset>.sha256sum`, which is the output
/// of PowerShell's `Get-FileHash` (a blank first line, CRLF, `Hash      : <64 uppercase hex>`).
/// What the regular expression `Hash\s*:\s*([0-9A-Fa-f]{64})` would find, as long as the hex is
/// not followed by more hex; failing that, a line that starts with 64 hex digits and a space or
/// ends there (the `sha256sum` form, should the release change to it). Lowercase.
pub fn first_hex(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(at) = rest.find("Hash") {
        let after = rest[at + "Hash".len()..].trim_start();
        if let Some(value) = after.strip_prefix(':')
            && let Some((hex, _)) = split_hex(value.trim_start())
        {
            return Some(hex.to_ascii_lowercase());
        }
        rest = &rest[at + "Hash".len()..];
    }
    text.lines().find_map(|line| {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let (hex, rest) = split_hex(line)?;
        (rest.is_empty() || rest.starts_with(' ')).then(|| hex.to_ascii_lowercase())
    })
}

/// `text` split after its first 64 characters when they are hex digits and the next one is not.
fn split_hex(text: &str) -> Option<(&str, &str)> {
    let hex = text.get(..HEX_LEN)?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let rest = &text[HEX_LEN..];
    if rest.bytes().next().is_some_and(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some((hex, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a";
    const B: &str = "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6";

    #[test]
    fn sha256_is_lowercase_hex() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex(b"").len(), 64);
    }

    /// The forms of the checksum files of the releases, as they were on 2026-10-19 (yt-dlp
    /// 2026.08.19's `SHA2-256SUMS`, Deno v2.9.7's `deno-x86_64-pc-windows-msvc.zip.sha256sum`).
    #[test]
    fn sums_files_are_read_exactly() {
        // yt-dlp: LF, two spaces, many assets, the one wanted among them.
        let sums = format!(
            "{B}  yt-dlp\n{A}  yt-dlp.exe\n\
             072aad4f2a7604e92155f61a275a4752dc64046c8f6d90df3710525d94cd37c1  yt-dlp.tar.gz\n\
             a8f91bd41452506bc81ebd2f369b186fea0ee7075413ba00cef9fd346a0a5d0c  yt-dlp_x86.exe\n"
        );
        assert_eq!(from_sums(&sums, "yt-dlp.exe").as_deref(), Some(A));
        assert_eq!(from_sums(&sums, "yt-dlp").as_deref(), Some(B));
        // Names are whole and exact: no prefix, no other case, no path.
        assert_eq!(from_sums(&sums, "yt-dlp.ex"), None);
        assert_eq!(from_sums(&sums, "YT-DLP.EXE"), None);
        assert_eq!(from_sums(&sums, "dist/yt-dlp.exe"), None);
        assert_eq!(from_sums(&sums, "yt-dlp_arm64.exe"), None);
        // Binary mode, CRLF, uppercase hex, blank lines and noise.
        let binary = format!(
            "\r\n# comment\r\n{}  other.exe\r\n{} *yt-dlp.exe\r\n\r\n",
            B,
            A.to_uppercase()
        );
        assert_eq!(from_sums(&binary, "yt-dlp.exe").as_deref(), Some(A));
        // One space only, a tab, a short or a long checksum: not the form.
        for line in [
            format!("{A} yt-dlp.exe"),
            format!("{A}\tyt-dlp.exe"),
            format!("{}  yt-dlp.exe", &A[..63]),
            format!("{A}0  yt-dlp.exe"),
            format!("{}g  yt-dlp.exe", &A[..63]),
            format!(" {A}  yt-dlp.exe"),
            format!("{A}  yt-dlp.exe "),
        ] {
            assert_eq!(from_sums(&line, "yt-dlp.exe"), None, "{line:?}");
        }
        // Empty, and two different checksums for the asset.
        assert_eq!(from_sums("", "yt-dlp.exe"), None);
        assert_eq!(from_sums("\n\n", "yt-dlp.exe"), None);
        let twice = format!("{A}  yt-dlp.exe\n{B}  yt-dlp.exe\n");
        assert_eq!(from_sums(&twice, "yt-dlp.exe"), None);
        let same_twice = format!("{A}  yt-dlp.exe\n{A} *yt-dlp.exe\n");
        assert_eq!(from_sums(&same_twice, "yt-dlp.exe").as_deref(), Some(A));

        // Deno: Get-FileHash's output, byte for byte as v2.9.7 has it.
        let deno = "\r\nAlgorithm : SHA256\r\n\
                    Hash      : A0C3101B4158D1DFB7D6A78A7BF0F3DE80C96BB423C152BEEC8BEB22786F2238\r\n\
                    Path      : C:\\a\\deno\\deno\\target\\release\\deno-x86_64-pc-windows-msvc.zip\r\n\r\n";
        assert_eq!(
            first_hex(deno).as_deref(),
            Some("a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238")
        );
        // Any spacing around the colon, LF only.
        assert_eq!(first_hex(&format!("Hash:{A}\n")).as_deref(), Some(A));
        assert_eq!(first_hex(&format!("Hash \t:  {A}")).as_deref(), Some(A));
        // A word before it that ends in "Hash", and a "Hash" without a checksum first.
        assert_eq!(
            first_hex(&format!("NoHash : nothing\nHash : {A}\n")).as_deref(),
            Some(A)
        );
        // The sha256sum form, should Deno change to it.
        assert_eq!(
            first_hex(&format!("{A}  deno-x86_64-pc-windows-msvc.zip\n")).as_deref(),
            Some(A)
        );
        assert_eq!(first_hex(&format!("{A}\n")).as_deref(), Some(A));
        // Nothing that is 64 hex digits.
        for text in [
            "",
            "\r\n\r\n",
            "Algorithm : SHA256\r\nHash      : \r\n",
            &format!("Hash : {}\r\n", &A[..63]),
            &format!("Hash : {A}ff\r\n"),
            &format!("Path : C:\\{A}.zip\r\n"),
        ] {
            assert_eq!(first_hex(text), None, "{text:?}");
        }
    }
}
