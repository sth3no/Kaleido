use crate::args::Invocation;

/// thumbfast's raw BGRA is displayed in an sRGB canvas, without color metadata.
/// Normalize its known HDR conversion only for raw thumbnail encoding jobs.
/// Leave upstream thumbfast/libmpv and unrelated CLI filter graphs untouched.
pub fn prepare(invocation: &mut Invocation) {
    let has = |key, value| {
        invocation
            .options
            .iter()
            .any(|(k, v)| k == key && v == value)
    };
    if !has("ovc", "rawvideo") || !has("of", "image2") {
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

fn srgb_filter(filter: &str) -> Option<String> {
    const HDR: &str = "zscale=transfer=linear,format=gbrpf32le,tonemap=";
    let (before, rest) = filter.split_once(HDR)?;
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
        "{before}lavfi=[{HDR}{algorithm}:desat=0,zscale=transfer=iec61966-2-1:primaries=bt709,{after}]"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::parse_args;

    const HDR: &str = "zscale=transfer=linear,format=gbrpf32le,tonemap=mobius,zscale=transfer=bt709,scale=200:112,format=bgra";

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
}
