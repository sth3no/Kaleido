use mpv_ffi::{Mpv, PropertyKind};

use crate::args::Invocation;

/// `reply_userdata` of the `vf` observation: `Event::PropertyChange { id: VF_WATCH, .. }`.
pub const VF_WATCH: u64 = 1;

/// The start of thumbfast's HDR conversion, up to the tone-mapping algorithm.
const HDR_HEAD: &str = "zscale=transfer=linear,format=gbrpf32le,tonemap=";

/// Whether this process renders thumbfast's raw BGRA frames: `ovc=rawvideo` into an `image2` muxer.
pub fn is_raw_image_job(invocation: &Invocation) -> bool {
    let has = |key, value| {
        invocation
            .options
            .iter()
            .any(|(k, v)| k == key && v == value)
    };
    has("ovc", "rawvideo") && has("of", "image2")
}

/// thumbfast's raw BGRA is displayed in an sRGB canvas, without color metadata.
/// Normalize its known HDR conversion only for raw thumbnail encoding jobs.
/// Leave upstream thumbfast/libmpv and unrelated CLI filter graphs untouched.
pub fn prepare(invocation: &mut Invocation) {
    if !is_raw_image_job(invocation) {
        return;
    }
    for (name, value) in &mut invocation.options {
        if name == "vf"
            && let Some(normalized) = srgb_filter(value)
        {
            *value = normalized;
        }
    }
}

/// Starts watching `vf` on a raw image job (and only on one). thumbfast swaps its filter chain
/// at run time with `vf set …` (flips, crop), which the rewrite in `prepare` never sees; the
/// change arrives as `Event::PropertyChange { id: VF_WATCH, .. }`, the current chain first.
pub fn watch_vf(mpv: &Mpv, invocation: &Invocation) -> mpv_ffi::Result<()> {
    if is_raw_image_job(invocation) {
        mpv.observe(VF_WATCH, "vf", PropertyKind::String)?;
    }
    Ok(())
}

/// Handles one report of the `vf` property: sets the rewritten chain when `rewrite_vf` has one
/// and returns whether it did. The rewritten chain is reported next, in a spelling that
/// `rewrite_vf` leaves alone, so this settles after one round.
pub fn rewrite_runtime_vf(mpv: &Mpv, observed: &str) -> mpv_ffi::Result<bool> {
    let Some(rewritten) = rewrite_vf(observed) else {
        return Ok(false);
    };
    // A newer chain may already be queued behind this report. It gets its own report, and
    // writing this older one back now would replace it.
    if mpv.get_string("vf")? != observed {
        return Ok(false);
    }
    mpv.set_property("vf", &rewritten)?;
    Ok(true)
}

/// `srgb_filter` for a chain taken from the running core. thumbfast writes the chain as
/// `format=gbrpf32le,tonemap=mobius,…`, but mpv reports a filter list in its own spelling
/// (`format=fmt=gbrpf32le,tonemap=%2%@0=mobius,…`, see `vf_list`), so that is read too. A chain
/// that was already rewritten matches neither and gives `None`.
pub fn rewrite_vf(current: &str) -> Option<String> {
    srgb_filter(current).or_else(|| rewrite_listed(current))
}

fn srgb_filter(filter: &str) -> Option<String> {
    let (before, rest) = filter.split_once(HDR_HEAD)?;
    let (algorithm, after) = rest.split_once(",zscale=transfer=bt709,")?;
    if !matches!(
        algorithm,
        "none" | "clip" | "linear" | "gamma" | "reinhard" | "hable" | "mobius"
    ) {
        return None;
    }
    Some(format!(
        // One AVFilter graph keeps float RGB and color metadata between stages.
        // Separate mpv filters insert conversions that shift red/blue hues.
        "{before}lavfi=[{HDR_HEAD}{algorithm}:desat=0,zscale=transfer=iec61966-2-1:primaries=bt709,{after}]"
    ))
}

/// Filters thumbfast puts behind its HDR conversion, the only ones that may move into the graph.
const GRAPH_TAIL: [&str; 3] = ["scale", "pad", "format"];

/// `rewrite_vf` for a chain in mpv's spelling: reads the list, finds the HDR conversion and
/// hands `srgb_filter` the same chain in thumbfast's spelling. Anything it cannot read back
/// exactly gives `None`: an untouched chain only costs the thumbnail its color fix.
fn rewrite_listed(listing: &str) -> Option<String> {
    let filters = vf_list::parse(listing)?;
    let (at, algorithm) =
        (0..filters.len()).find_map(|i| hdr_algorithm(&filters[i..]).map(|a| (i, a)))?;
    // The algorithm ends up inside the graph text; only a plain name may.
    if !algorithm.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    let (head, tail) = (&filters[..at], &filters[at + 4..]);
    if tail.is_empty() || tail.iter().any(|f| !GRAPH_TAIL.contains(&f.name.as_str())) {
        return None;
    }
    let mut chain = String::new();
    for filter in head {
        chain.push_str(&filter.spelled()?);
        chain.push(',');
    }
    chain.push_str(&format!("{HDR_HEAD}{algorithm},zscale=transfer=bt709,"));
    let tail = tail
        .iter()
        .map(vf_list::Filter::spelled)
        .collect::<Option<Vec<_>>>()?;
    chain.push_str(&tail.join(","));
    srgb_filter(&chain)
}

/// The tone-mapping algorithm when `chain` starts with exactly thumbfast's HDR conversion.
fn hdr_algorithm(chain: &[vf_list::Filter]) -> Option<&str> {
    let [to_linear, to_float, tonemap, to_bt709, ..] = chain else {
        return None;
    };
    let is = |filter: &vf_list::Filter, name: &str, key: &str, value: &str| {
        filter.sole_arg(name) == Some((key, value))
    };
    if !(is(to_linear, "zscale", "transfer", "linear")
        && is(to_float, "format", "fmt", "gbrpf32le")
        && is(to_bt709, "zscale", "transfer", "bt709"))
    {
        return None;
    }
    match tonemap.sole_arg("tonemap")? {
        ("@0" | "tonemap", algorithm) => Some(algorithm),
        _ => None,
    }
}

/// mpv's own text for a filter list, what the `vf` property reports (as read from mpv's
/// `print_obj_settings_list`; the tests with a real libmpv check it against the build in use).
mod vf_list {
    /// One filter: `name`, or `name=key=value:key=value`. A key or value that is not plain
    /// letters, digits, `_` and `-` is written `%<bytes>%<text>`, and an argument given
    /// without a name is listed under `@0`, `@1`, ...
    pub struct Filter {
        pub name: String,
        pub args: Vec<(String, String)>,
    }

    /// The filters of `text`, or `None` when it is not a plain list (labels, disabled filters,
    /// damaged escapes, trailing text).
    pub fn parse(text: &str) -> Option<Vec<Filter>> {
        let mut filters = Vec::new();
        let mut rest = text;
        loop {
            let (filter, tail) = parse_filter(rest)?;
            filters.push(filter);
            if tail.is_empty() {
                return Some(filters);
            }
            rest = tail.strip_prefix(',')?;
        }
    }

    fn parse_filter(text: &str) -> Option<(Filter, &str)> {
        let end = text.find(['=', ',']).unwrap_or(text.len());
        let name = &text[..end];
        // `@label:name` and `!name` are not something thumbfast sends.
        if name.is_empty() || name.starts_with(['@', '!']) {
            return None;
        }
        let mut args = Vec::new();
        let mut rest = &text[end..];
        if let Some(first) = rest.strip_prefix('=') {
            rest = first;
            loop {
                let (key, tail) = param(rest)?;
                let (value, tail) = param(tail.strip_prefix('=')?)?;
                args.push((key, value));
                match tail.strip_prefix(':') {
                    Some(next) => rest = next,
                    None => {
                        rest = tail;
                        break;
                    }
                }
            }
        }
        Some((
            Filter {
                name: name.to_owned(),
                args,
            },
            rest,
        ))
    }

    fn param(text: &str) -> Option<(String, &str)> {
        if let Some(escaped) = text.strip_prefix('%') {
            let (len, rest) = escaped.split_once('%')?;
            let len: usize = len.parse().ok()?;
            let value = rest.get(..len)?;
            return Some((value.to_owned(), &rest[value.len()..]));
        }
        let end = text.find([',', ':', '=']).unwrap_or(text.len());
        Some((text[..end].to_owned(), &text[end..]))
    }

    impl Filter {
        /// The only argument as (key, value) when the filter is called `name` and has just one.
        pub fn sole_arg(&self, name: &str) -> Option<(&str, &str)> {
            match self.args.as_slice() {
                [(key, value)] if self.name == name => Some((key.as_str(), value.as_str())),
                _ => None,
            }
        }

        /// The filter as thumbfast writes it, which is also what libavfilter reads inside a
        /// `lavfi=[…]` graph (unnamed arguments bare, mpv's `format` argument unnamed). `None`
        /// when it takes anything that would need quoting there.
        pub fn spelled(&self) -> Option<String> {
            let plain = |s: &str| {
                s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_-.+*/@".contains(c))
            };
            if self.name.is_empty() || !plain(&self.name) {
                return None;
            }
            if self.args.is_empty() {
                return Some(self.name.clone());
            }
            let mut args = Vec::new();
            let mut named = false;
            for (index, (key, value)) in self.args.iter().enumerate() {
                if key.is_empty() || !plain(key) || !plain(value) {
                    return None;
                }
                if let Some(position) = key.strip_prefix('@') {
                    // Unnamed arguments come first and in order, or libavfilter misreads them.
                    if named || position != index.to_string() {
                        return None;
                    }
                    args.push(value.clone());
                } else if self.name == "format" {
                    // mpv's own filter, not libavfilter's: `fmt` exists only in mpv's spelling.
                    if key != "fmt" || self.args.len() != 1 {
                        return None;
                    }
                    args.push(value.clone());
                } else {
                    named = true;
                    args.push(format!("{key}={value}"));
                }
            }
            Some(format!("{}={}", self.name, args.join(":")))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use mpv_ffi::{EndFileReason, Event, PropertyValue, load_api, locate_libmpv};

    use super::*;
    use crate::args::parse_args;

    const HDR: &str = "zscale=transfer=linear,format=gbrpf32le,tonemap=mobius,zscale=transfer=bt709,scale=200:112,format=bgra";

    /// The chain thumbfast's `vf set` carries for a square-pixel BT.2020 video (`vf_string`).
    const RUNTIME: &str = "zscale=transfer=linear,format=gbrpf32le,tonemap=mobius,zscale=transfer=bt709,scale=w=200:h=112:force_original_aspect_ratio=decrease,pad=w=200:h=112:x=-1:y=-1,format=bgra";
    /// `RUNTIME` the way mpv's `vf` property should list it, as read from mpv's `print_obj_settings_list`.
    /// Not seen from a running libmpv yet: `a_vf_set_at_runtime_gets_the_same_lavfi_graph` checks it.
    const LISTED: &str = "zscale=transfer=linear,format=fmt=gbrpf32le,tonemap=%2%@0=mobius,zscale=transfer=bt709,scale=w=200:h=112:force_original_aspect_ratio=decrease,pad=w=200:h=112:x=-1:y=-1,format=fmt=bgra";
    /// What both rewrite to.
    const GRAPH: &str = "lavfi=[zscale=transfer=linear,format=gbrpf32le,tonemap=mobius:desat=0,zscale=transfer=iec61966-2-1:primaries=bt709,scale=w=200:h=112:force_original_aspect_ratio=decrease,pad=w=200:h=112:x=-1:y=-1,format=bgra]";

    #[test]
    fn preserves_crop_and_size_while_converting_hdr_for_canvas() {
        let normalized = srgb_filter(&format!("crop=100:80,{HDR}")).unwrap();
        assert!(normalized.starts_with("crop=100:80,lavfi=[zscale=transfer=linear"));
        assert!(normalized.contains("tonemap=mobius:desat=0"));
        assert!(normalized.contains("transfer=iec61966-2-1:primaries=bt709"));
        assert!(normalized.ends_with("scale=200:112,format=bgra]"));
    }

    #[test]
    fn leaves_sdr_and_custom_tonemapping_unchanged() {
        assert!(srgb_filter("scale=200:112,format=bgra").is_none());
        assert!(srgb_filter(&HDR.replace("tonemap=mobius", "tonemap=mobius:desat=1")).is_none());
    }

    #[test]
    fn changes_only_raw_image_encoder_jobs() {
        for encoder in ["libx264", "rawvideo"] {
            let args = [format!("--vf={HDR}"), format!("--ovc={encoder}")];
            let mut job = parse_args(args);
            prepare(&mut job);
            assert_eq!(job.options[0].1, HDR);
        }
        let mut job = parse_args([
            format!("--vf={HDR}"),
            "--ovc=rawvideo".into(),
            "--of=image2".into(),
        ]);
        prepare(&mut job);
        assert_ne!(job.options[0].1, HDR);
    }

    #[test]
    fn only_rawvideo_into_image2_is_a_raw_image_job() {
        assert!(is_raw_image_job(&raw_image_job()));
        for args in [
            &["--ovc=libx264", "--of=image2"][..],
            &["--ovc=rawvideo", "--of=mp4"],
            &["--ovc=rawvideo"],
            &["--of=image2"],
            &[],
        ] {
            let job = parse_args(args.iter().map(|a| a.to_string()));
            assert!(!is_raw_image_job(&job), "{args:?}");
        }
    }

    #[test]
    fn a_chain_sent_at_run_time_is_rewritten_like_the_one_at_start() {
        assert_eq!(rewrite_vf(RUNTIME).as_deref(), Some(GRAPH));
        let flipped = format!("lavfi-crop=w=100:h=80:x=10:y=20,hflip=,{RUNTIME}");
        assert_eq!(
            rewrite_vf(&flipped).unwrap(),
            format!("lavfi-crop=w=100:h=80:x=10:y=20,hflip=,{GRAPH}")
        );
    }

    #[test]
    fn the_chain_as_mpv_lists_it_gives_the_same_graph() {
        assert_eq!(rewrite_vf(LISTED).as_deref(), Some(GRAPH));
        let flipped = format!("lavfi-crop=w=100:h=80:x=10:y=20,hflip,{LISTED}");
        assert_eq!(
            rewrite_vf(&flipped).unwrap(),
            format!("lavfi-crop=w=100:h=80:x=10:y=20,hflip,{GRAPH}")
        );
        // Escaped text is read back, whatever mpv decides to escape.
        let escaped = LISTED.replace("w=200:h=112:force", "w=%3%200:h=112:force");
        assert_eq!(rewrite_vf(&escaped).as_deref(), Some(GRAPH));
    }

    #[test]
    fn a_rewritten_chain_is_not_rewritten_again() {
        assert_eq!(rewrite_vf(GRAPH), None);
        // The way mpv lists a lavfi filter: its graph is one escaped value.
        let graph = GRAPH
            .strip_prefix("lavfi=[")
            .unwrap()
            .strip_suffix(']')
            .unwrap();
        let listed = format!("lavfi=graph=%{}%{graph}", graph.len());
        assert_eq!(rewrite_vf(&listed), None);
        let after_crop = format!("lavfi-crop=w=100:h=80:x=10:y=20,{listed}");
        assert_eq!(rewrite_vf(&after_crop), None);
    }

    #[test]
    fn other_chains_are_left_alone_in_both_spellings() {
        for chain in [
            "",
            "scale=200:112,format=bgra",
            "scale=w=200:h=112,format=fmt=bgra",
            "hflip",
            // A tone-mapping setting thumbfast does not send.
            "zscale=transfer=linear,format=fmt=gbrpf32le,tonemap=%2%@0=mobius:desat=1,zscale=transfer=bt709,format=fmt=bgra",
        ] {
            assert_eq!(rewrite_vf(chain), None, "{chain}");
        }
    }

    #[test]
    fn a_listing_that_cannot_be_read_back_exactly_is_left_alone() {
        let tail = |extra: &str| LISTED.replace("pad=", &format!("{extra}pad="));
        for chain in [
            // damaged escape, label, disabled filter
            LISTED.replace("%2%@0=mobius", "%999%@0=mobius"),
            format!("@hdr:{LISTED}"),
            format!("!{LISTED}"),
            // nothing behind the conversion, or something that is not thumbfast's
            LISTED.split(",scale=").next().unwrap().to_owned(),
            format!("{LISTED},drawtext=text=hi"),
            tail("drawtext=text=hi,"),
            // mpv's `format` with more than the pixel format cannot go into a graph
            LISTED.replace("format=fmt=bgra", "format=fmt=bgra:colormatrix=bt.709"),
            // an argument that needs quoting inside a graph
            LISTED.replace("x=-1", "x=%3%a:b"),
            // trailing text after a filter
            format!("{LISTED}=x"),
        ] {
            assert_eq!(rewrite_vf(&chain), None, "{chain}");
        }
    }

    // The tests below need a real libmpv (vendor/libmpv, or $KALEIDO_LIBMPV) and no network.

    const SENTINEL: u64 = 99;

    fn raw_image_job() -> Invocation {
        parse_args(["--ovc=rawvideo", "--of=image2", "--ofopts=update=1"].map(String::from))
    }

    /// A core set up like the one thumbfast spawns: no outputs, paused, waiting for work.
    fn core_for(job: &Invocation) -> Mpv {
        let mpv = Mpv::create(load_api(&locate_libmpv()).unwrap()).unwrap();
        for (name, value) in [
            ("vo", "null"),
            ("ao", "null"),
            ("config", "no"),
            ("terminal", "no"),
            ("idle", "yes"),
            ("pause", "yes"),
        ] {
            mpv.set_option(name, value).unwrap();
        }
        for (name, value) in &job.options {
            mpv.set_option(name, value).unwrap();
        }
        mpv.initialize().unwrap();
        mpv
    }

    /// The next report of `vf` that `wanted` accepts, as main's event loop would receive it.
    fn next_vf_report(mpv: &Mpv, wanted: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Event::PropertyChange {
                id: VF_WATCH,
                value: PropertyValue::String(vf),
                ..
            } = mpv.wait_event(0.1)
                && wanted(&vf)
            {
                return vf;
            }
        }
        panic!("mpv never reported a vf change that was asked for");
    }

    #[test]
    fn a_vf_set_at_runtime_gets_the_same_lavfi_graph() {
        let job = raw_image_job();
        let mpv = core_for(&job);
        watch_vf(&mpv, &job).unwrap();

        // What thumbfast does when it flips the video: the whole chain again, as text.
        mpv.command(&["vf", "set", RUNTIME]).unwrap();
        let reported = next_vf_report(&mpv, |vf| vf.contains("tonemap"));
        // Run with `-- --nocapture` to read how this libmpv spells the chain it was given.
        eprintln!("vf as mpv reports it: {reported}");
        assert!(
            rewrite_vf(&reported).is_some(),
            "rewrite_vf does not know mpv's spelling of the chain: {reported}"
        );

        assert!(rewrite_runtime_vf(&mpv, &reported).unwrap());
        let rewritten = mpv.get_string("vf").unwrap();
        eprintln!("vf after the rewrite: {rewritten}");
        assert!(rewritten.contains("lavfi"), "{rewritten}");
        assert!(rewritten.contains("desat=0"), "{rewritten}");

        // No loop: the change this caused reports the graph, which is left alone.
        let echoed = next_vf_report(&mpv, |vf| vf.contains("desat=0"));
        assert!(!rewrite_runtime_vf(&mpv, &echoed).unwrap());
        assert_eq!(mpv.get_string("vf").unwrap(), rewritten);
    }

    #[test]
    fn other_runtime_filters_stay() {
        let job = raw_image_job();
        let mpv = core_for(&job);
        watch_vf(&mpv, &job).unwrap();

        mpv.command(&["vf", "set", "scale=200:112,format=bgra"])
            .unwrap();
        let reported = next_vf_report(&mpv, |vf| vf.contains("bgra"));
        assert!(!rewrite_runtime_vf(&mpv, &reported).unwrap());
        assert_eq!(mpv.get_string("vf").unwrap(), reported);
    }

    #[test]
    fn a_stale_report_does_not_overwrite_a_newer_chain() {
        let job = raw_image_job();
        let mpv = core_for(&job);
        watch_vf(&mpv, &job).unwrap();

        mpv.command(&["vf", "set", RUNTIME]).unwrap();
        let reported = next_vf_report(&mpv, |vf| vf.contains("tonemap"));
        // thumbfast sent another chain before the first report was handled.
        mpv.command(&["vf", "set", "hflip"]).unwrap();
        assert!(!rewrite_runtime_vf(&mpv, &reported).unwrap());
        let now = mpv.get_string("vf").unwrap();
        assert!(now.contains("hflip"), "{now}");
        assert!(!now.contains("tonemap") && !now.contains("lavfi"), "{now}");
    }

    /// The rewritten chain must be one libavfilter accepts, not only one that looks right.
    #[test]
    fn the_chain_rewritten_at_runtime_still_renders_frames() {
        let dir = tempfile::tempdir().unwrap();
        let clip = dir.path().join("clip.y4m");
        mpv_ffi::testing::write_y4m(&clip, 64, 36, 30).unwrap();
        let job = raw_image_job();
        let mpv = core_for(&job);
        watch_vf(&mpv, &job).unwrap();

        // `setparams` tags the clip as HDR so that the conversion has HDR to convert.
        let chain = "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,\
            zscale=transfer=linear,format=gbrpf32le,tonemap=mobius,zscale=transfer=bt709,\
            scale=w=32:h=18:force_original_aspect_ratio=decrease,pad=w=32:h=18:x=-1:y=-1,format=bgra";
        mpv.command(&["vf", "set", chain]).unwrap();
        let reported = next_vf_report(&mpv, |vf| vf.contains("tonemap"));
        assert!(rewrite_runtime_vf(&mpv, &reported).unwrap(), "{reported}");

        mpv.command(&["loadfile", clip.to_str().unwrap()]).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let width = loop {
            if let Ok(width) = mpv.get_i64("video-out-params/w") {
                break width;
            }
            if let Event::EndFile { reason, .. } = mpv.wait_event(0.1)
                && reason != EndFileReason::Stop
            {
                panic!("playback ended before a frame came out: {reason:?}");
            }
            assert!(
                Instant::now() < deadline,
                "no frame came out of {}",
                mpv.get_string("vf").unwrap_or_default()
            );
        };
        assert_eq!(width, 32);
    }

    /// Whether a `vf` report arrives among the first events after `watch_vf`. Observed
    /// properties report right away, in the order they were registered, so the one registered
    /// last tells that every earlier report has been seen (plus a short wait for stragglers).
    fn vf_is_watched(mpv: &Mpv, job: &Invocation) -> bool {
        watch_vf(mpv, job).unwrap();
        mpv.observe(SENTINEL, "pause", PropertyKind::Flag).unwrap();
        let mut watched = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match mpv.wait_event(0.1) {
                Event::PropertyChange { id: VF_WATCH, .. } => watched = true,
                Event::PropertyChange { id: SENTINEL, .. } => {
                    let settled = Instant::now() + Duration::from_millis(300);
                    while Instant::now() < settled {
                        if let Event::PropertyChange { id: VF_WATCH, .. } = mpv.wait_event(0.05) {
                            watched = true;
                        }
                    }
                    return watched;
                }
                _ => {}
            }
        }
        panic!("mpv never reported the sentinel property");
    }

    #[test]
    fn jobs_that_are_not_raw_images_do_not_watch_vf() {
        let not_raw = [
            parse_args(["--ovc=libx264", "--of=image2"].map(String::from)),
            parse_args(["--ovc=rawvideo", "--of=mp4"].map(String::from)),
            parse_args(["--idle"].map(String::from)),
        ];
        for job in &not_raw {
            assert!(
                !vf_is_watched(&core_for(job), job),
                "{:?} watches vf",
                job.options
            );
        }
        // The same check does see the observation when there is one.
        let job = raw_image_job();
        assert!(vf_is_watched(&core_for(&job), &job));
    }
}
