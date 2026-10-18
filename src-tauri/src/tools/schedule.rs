//! When a tool is checked again (spec 6.6, 10.7): yt-dlp every day and Deno every week
//! ([`ToolId::interval`](super::ToolId::interval)), and after a failure not before the backoff is
//! over: 1 minute, 5 minutes, 30 minutes, then every 2 hours. The functions take the time as a
//! parameter, so they are tested without a clock.

use time::{Duration, OffsetDateTime};

use super::store::{ToolRecord, parse_time};

/// The waits after the first, second, third and fourth failure in a row, in seconds; every later
/// one waits as long as the last (spec 10.7).
pub const BACKOFF_S: [i64; 4] = [60, 300, 1800, 7200];

/// Whether a check is due at `now`:
/// - no record: at once (nothing was installed or tried);
/// - after a failure, the backoff decides ([`backing_off`]), not the interval;
/// - otherwise when `interval` has passed since the last check, or since the install when there
///   was no check yet; a record that was never installed is due at once.
///
/// A time that cannot be read, or one in the future (the clock was set back), makes the check
/// due, so that a tool is never left unchecked for longer than it should be.
pub fn due(record: Option<&ToolRecord>, now: OffsetDateTime, interval: Duration) -> bool {
    let Some(record) = record else {
        return true;
    };
    if record.next_try.is_some() {
        return !backing_off(Some(record), now);
    }
    if !record.is_installed() {
        return true;
    }
    let last = record
        .checked_at
        .as_deref()
        .and_then(parse_time)
        .or_else(|| parse_time(&record.installed_at));
    match last {
        Some(last) if last <= now => last + interval <= now,
        _ => true,
    }
}

/// Whether the record is waiting after a failure at `now`: its `next_try` is still to come. A
/// `next_try` further away than the longest backoff (the clock was set back) is not waited for,
/// and neither is one that cannot be read.
pub fn backing_off(record: Option<&ToolRecord>, now: OffsetDateTime) -> bool {
    let Some(next) = record
        .and_then(|record| record.next_try.as_deref())
        .and_then(parse_time)
    else {
        return false;
    };
    let longest = Duration::seconds(BACKOFF_S[BACKOFF_S.len() - 1]);
    now < next && next <= now + longest
}

/// The failures in a row once one more check failed at `now`, and when the next may run.
pub fn after_failure(record: Option<&ToolRecord>, now: OffsetDateTime) -> (u32, OffsetDateTime) {
    let failures = record.map_or(0, |record| record.failures).saturating_add(1);
    let step = usize::try_from(failures - 1)
        .unwrap_or(usize::MAX)
        .min(BACKOFF_S.len() - 1);
    (failures, now + Duration::seconds(BACKOFF_S[step]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::ToolId;
    use crate::tools::store::stamp;

    fn at(text: &str) -> OffsetDateTime {
        parse_time(text).unwrap()
    }

    fn installed(at: &str, checked: Option<&str>) -> ToolRecord {
        ToolRecord {
            version: Some("1".to_owned()),
            sha256: "ab".repeat(32),
            channel: None,
            installed_at: at.to_owned(),
            checked_at: checked.map(str::to_owned),
            failures: 0,
            next_try: None,
        }
    }

    #[test]
    fn due_follows_the_daily_and_weekly_intervals() {
        let day = ToolId::YtDlp.interval();
        let week = ToolId::Deno.interval();
        assert_eq!(day, Duration::hours(24));
        assert_eq!(week, Duration::days(7));
        let now = at("2026-10-19T12:00:00Z");

        // Nothing there: at once, for both.
        assert!(due(None, now, day));
        assert!(due(None, now, week));
        assert!(due(Some(&ToolRecord::not_installed()), now, day));

        // Checked 23 h 59 min ago: not yet for yt-dlp; 24 h ago: due.
        let record = installed("2026-10-01T00:00:00Z", Some("2026-10-18T12:01:00Z"));
        assert!(!due(Some(&record), now, day));
        let record = installed("2026-10-01T00:00:00Z", Some("2026-10-18T12:00:00Z"));
        assert!(due(Some(&record), now, day));
        // The same check is far from a week old for Deno.
        assert!(!due(Some(&record), now, week));
        let record = installed("2026-10-01T00:00:00Z", Some("2026-10-12T12:00:01Z"));
        assert!(!due(Some(&record), now, week));
        let record = installed("2026-10-01T00:00:00Z", Some("2026-10-12T12:00:00Z"));
        assert!(due(Some(&record), now, week));
        // Never checked: counted from the install.
        assert!(!due(
            Some(&installed("2026-10-19T00:00:00Z", None)),
            now,
            day
        ));
        assert!(due(
            Some(&installed("2026-10-18T00:00:00Z", None)),
            now,
            day
        ));

        // After a failure, the backoff decides and the interval does not.
        let mut failed = installed("2026-10-01T00:00:00Z", Some("2026-10-19T11:00:00Z"));
        failed.failures = 1;
        failed.next_try = Some("2026-10-19T12:01:00Z".to_owned());
        assert!(!due(Some(&failed), now, day));
        assert!(backing_off(Some(&failed), now));
        assert!(due(Some(&failed), at("2026-10-19T12:01:00Z"), day));
        // Also for a tool that was never installed: the failed download waits too.
        let mut missing = ToolRecord::not_installed();
        missing.failures = 3;
        missing.next_try = Some("2026-10-19T12:30:00Z".to_owned());
        assert!(!due(Some(&missing), now, week));
        assert!(due(Some(&missing), at("2026-10-19T12:30:00Z"), week));

        // A clock set back, and times that cannot be read: due.
        let ahead = installed("2026-10-01T00:00:00Z", Some("2027-01-01T00:00:00Z"));
        assert!(due(Some(&ahead), now, week));
        let mut far = failed.clone();
        far.next_try = Some("2026-10-20T12:00:00Z".to_owned());
        assert!(due(Some(&far), now, day));
        let garbled = installed("then", Some("later"));
        assert!(due(Some(&garbled), now, week));
        let mut garbled_next = failed;
        garbled_next.next_try = Some("soon".to_owned());
        assert!(due(Some(&garbled_next), now, day));
    }

    #[test]
    fn failures_back_off_by_the_spec() {
        let now = at("2026-10-19T12:00:00Z");
        assert_eq!(after_failure(None, now), (1, at("2026-10-19T12:01:00Z")));
        let mut record = installed("2026-10-01T00:00:00Z", None);
        for (failures, wait) in [
            (1, 60),
            (2, 300),
            (3, 1800),
            (4, 7200),
            (5, 7200),
            (9, 7200),
        ] {
            record.failures = failures - 1;
            let (count, next) = after_failure(Some(&record), now);
            assert_eq!(count, failures);
            assert_eq!(next - now, Duration::seconds(wait), "failure {failures}");
            assert_eq!(stamp(next), stamp(now + Duration::seconds(wait)));
        }
        record.failures = u32::MAX;
        assert_eq!(
            after_failure(Some(&record), now),
            (u32::MAX, now + Duration::seconds(7200))
        );
    }
}
