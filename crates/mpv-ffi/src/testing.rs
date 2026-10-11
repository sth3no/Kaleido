//! Helpers for tests in this workspace: generated media that needs no codec.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

/// Writes an uncompressed YUV4MPEG2 clip: `frames` frames at 30 fps with a luma ramp.
pub fn write_y4m(path: &Path, width: usize, height: usize, frames: usize) -> std::io::Result<()> {
    assert!(
        width.is_multiple_of(2) && height.is_multiple_of(2),
        "4:2:0 needs even dimensions"
    );
    let mut out = BufWriter::new(File::create(path)?);
    writeln!(out, "YUV4MPEG2 W{width} H{height} F30:1 Ip A1:1 C420jpeg")?;
    let luma = width * height;
    for i in 0..frames {
        out.write_all(b"FRAME\n")?;
        out.write_all(&vec![(i * 4 % 256) as u8; luma])?;
        out.write_all(&vec![128u8; luma / 2])?;
    }
    out.flush()
}
