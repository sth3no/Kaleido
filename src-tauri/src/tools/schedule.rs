//! When a tool is checked again (spec 6.6, 10.7): yt-dlp every day and Deno every week
//! ([`ToolId::interval`](super::ToolId::interval)), and after a failure not before the backoff is
//! over: 1 minute, 5 minutes, 30 minutes, then every 2 hours. The functions take the time as a
//! parameter, so they are tested without a clock.

use time::{Duration, OffsetDateTime};

use super::store::{ToolRecord, parse_time};

/// The waits after the first, second, third and fourth failure in a row, in seconds; every later
/// one waits as long as the last (spec 10.7).
pub const BACKOFF_S: [i64; 4] = [60, 300, 1800, 7200];

/// When the next check is due, seen at `now`; `None` when it is due now. The later of:
/// - the end of the backoff after a failure ([`retry_at`]);
/// - `interval` after the last check, or after the install when there was no check yet; only
///   for an installed tool.
///
/// So no record, or a record of a tool that was never installed and is not backing off, is due
/// at once. A time that cannot be read, or one in the future (the clock was set back), does not
/// hold a check back, so that a tool is never left unchecked for longer than it should be.
pub fn next_due(
    record: Option<&ToolRecord>,
    now: OffsetDateTime,
    interval: Duration,
) -> Option<OffsetDateTime> {
    let record = record?;
    let retry = retry_at(Some(record), now);
    let last = if record.is_installed() {
        record
            .checked_at
            .as_deref()
            .and_then(parse_time)
            .or_else(|| parse_time(&record.installed_at))
    } else {
        None
    };
    let regular = last
        .filter(|last| *last <= now)
        .map(|last| last + interval)
        .filter(|at| *at > now);
    match (retry, regular) {
        (Some(retry), Some(regular)) => Some(retry.max(regular)),
        (retry, regular) => retry.or(regular),
    }
}

/// Whether a check is due at `now`: [`next_due`] is now.
pub fn due(record: Option<&ToolRecord>, now: OffsetDateTime, interval: Duration) -> bool {
    next_due(record, now, interval).is_none()
}

/// The record's `next_try` while it is still to come at `now`, i.e. while it backs off after a
/// failure. One further away than the longest backoff (the clock was set back) is not waited for,
/// and neither is one that cannot be read.
pub fn retry_at(record: Option<&ToolRecord>, now: OffsetDateTime) -> Option<OffsetDateTime> {
    let next = record
        .and_then(|record| record.next_try.as_deref())
        .and_then(parse_time)?;
    let longest = Duration::seconds(BACKOFF_S[BACKOFF_S.len() - 1]);
    (now < next && next <= now + longest).then_some(next)
}

/// Whether the record backs off after a failure at `now` ([`retry_at`]).
pub fn backing_off(record: Option<&ToolRecord>, now: OffsetDateTime) -> bool {
    retry_at(record, now).is_some()
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
            vanished: 0,
            exe_sha256: None,
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

        // When it is due, for a scheduler to wait for.
        assert_eq!(next_due(None, now, day), None);
        let record = installed("2026-10-01T00:00:00Z", Some("2026-10-18T12:01:00Z"));
        assert_eq!(
            next_due(Some(&record), now, day),
            Some(at("2026-10-19T12:01:00Z"))
        );
        assert_eq!(
            next_due(Some(&record), now, week),
            Some(at("2026-10-25T12:01:00Z"))
        );

        // After a failure: the later of the backoff and the interval. A check that failed long
        // after the last good one is tried again once the backoff is over.
        let mut failed = installed("2026-10-01T00:00:00Z", Some("2026-10-18T06:00:00Z"));
        failed.failures = 1;
        failed.next_try = Some("2026-10-19T12:01:00Z".to_owned());
        assert!(!due(Some(&failed), now, day));
        assert!(backing_off(Some(&failed), now));
        assert_eq!(
            next_due(Some(&failed), now, day),
            Some(at("2026-10-19T12:01:00Z"))
        );
        assert!(due(Some(&failed), at("2026-10-19T12:01:00Z"), day));
        // A forced check that failed an hour after a good one: that one's interval is later.
        let mut recent = failed.clone();
        recent.checked_at = Some("2026-10-19T11:00:00Z".to_owned());
        assert_eq!(
            next_due(Some(&recent), now, day),
            Some(at("2026-10-20T11:00:00Z"))
        );
        assert!(!due(Some(&recent), at("2026-10-19T12:01:00Z"), day));
        // A tool that was never installed: the failed download waits for the backoff only.
        let mut missing = ToolRecord::not_installed();
        missing.failures = 3;
        missing.next_try = Some("2026-10-19T12:30:00Z".to_owned());
        assert!(!due(Some(&missing), now, week));
        assert_eq!(
            next_due(Some(&missing), now, week),
            Some(at("2026-10-19T12:30:00Z"))
        );
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
