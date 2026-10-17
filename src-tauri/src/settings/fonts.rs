//! The font families installed on Windows, through DirectWrite: what the subtitle font setting
//! offers and accepts (`sub-font`).

use std::collections::BTreeSet;
use std::sync::OnceLock;

use windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection,
};
use windows::core::{BOOL, w};

/// The system's font families as libass finds them: the English name where a family has one,
/// without duplicates, sorted. Read once and kept; a failed read is tried again next time.
pub fn system_fonts() -> &'static [String] {
    static FONTS: OnceLock<Vec<String>> = OnceLock::new();
    if let Some(fonts) = FONTS.get() {
        return fonts;
    }
    match font_families() {
        Ok(fonts) => FONTS.get_or_init(|| fonts),
        Err(error) => {
            tracing::error!("cannot list the system fonts: {error}");
            &[]
        }
    }
}

fn font_families() -> windows::core::Result<Vec<String>> {
    // SAFETY: DirectWrite calls on the interfaces it returned; the out pointer is a local.
    let collection = unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
        let mut collection = None;
        factory.GetSystemFontCollection(&mut collection, false)?;
        collection
    };
    let Some(collection) = collection else {
        return Ok(Vec::new());
    };
    // SAFETY: as above.
    let count = unsafe { collection.GetFontFamilyCount() };
    let mut families = BTreeSet::new();
    for index in 0..count {
        match family_name(&collection, index) {
            Ok(name) if !name.is_empty() => {
                families.insert(name);
            }
            Ok(_) => {}
            Err(error) => tracing::warn!("font family {index} has no name: {error}"),
        }
    }
    let mut families: Vec<String> = families.into_iter().collect();
    families.sort_by_cached_key(|name| name.to_lowercase());
    Ok(families)
}

/// The family's en-us name, else its first.
fn family_name(collection: &IDWriteFontCollection, index: u32) -> windows::core::Result<String> {
    // SAFETY: DirectWrite calls on the interfaces it returned; the buffer holds the string's
    // length plus its terminating NUL, as GetString needs.
    unsafe {
        let names = collection.GetFontFamily(index)?.GetFamilyNames()?;
        let mut at = 0;
        let mut exists = BOOL::default();
        names.FindLocaleName(w!("en-us"), &mut at, &mut exists)?;
        if !exists.as_bool() {
            at = 0;
        }
        let length = names.GetStringLength(at)? as usize;
        let mut buffer = vec![0u16; length + 1];
        names.GetString(at, &mut buffer)?;
        Ok(String::from_utf16_lossy(&buffer[..length]))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::system_fonts;

    /// DirectWrite needs no window; every Windows has Segoe UI.
    #[test]
    fn system_fonts_are_sorted_unique_and_include_segoe_ui() {
        let fonts = system_fonts();
        assert!(fonts.iter().any(|font| font == "Segoe UI"), "{fonts:?}");
        let mut sorted = fonts.to_vec();
        sorted.sort_by_cached_key(|name| name.to_lowercase());
        assert_eq!(fonts, sorted.as_slice());
        let unique: BTreeSet<&String> = fonts.iter().collect();
        assert_eq!(unique.len(), fonts.len());
        assert!(std::ptr::eq(fonts, system_fonts()), "read once");
    }
}
