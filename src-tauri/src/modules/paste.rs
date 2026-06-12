//! Materialize a pasted (clipboard) image to a local temp file so it can be
//! handed to the same upload/insert path a dropped file uses. The frontend
//! reads the clipboard image as a blob and sends it here base64-encoded; the
//! image already arrives encoded (PNG/JPEG/…), so we just decode and write the
//! bytes verbatim — no re-encoding.

use std::io::Write;

use base64::Engine;

/// Keep only an alphanumeric extension (lowercased, capped), defaulting to
/// `png`. The clipboard mime is attacker-irrelevant here, but a clean suffix
/// keeps the temp filename — and the remote upload name derived from it — sane.
fn sanitize_ext(ext: &str) -> String {
    let cleaned: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    if cleaned.is_empty() {
        "png".to_string()
    } else {
        cleaned
    }
}

/// Decode `data_b64` and write it to a fresh file under `$TMPDIR/termul-pastes/`
/// with the given (sanitized) extension. Returns the absolute local path. The
/// file is persisted (not auto-deleted) so a local paste can reference it and an
/// SSH paste can scp it; the OS reaps the temp dir over time.
#[tauri::command]
pub async fn materialize_paste_image(data_b64: String, ext: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("invalid image data: {e}"))?;
    if bytes.is_empty() {
        return Err("empty image".to_string());
    }

    let dir = std::env::temp_dir().join("termul-pastes");
    std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;

    let suffix = format!(".{}", sanitize_ext(&ext));
    let mut tmp = tempfile::Builder::new()
        .prefix("paste-")
        .suffix(&suffix)
        .tempfile_in(&dir)
        .map_err(|e| format!("temp file: {e}"))?;
    tmp.as_file_mut()
        .write_all(&bytes)
        .map_err(|e| format!("write image: {e}"))?;
    // Persist past the NamedTempFile guard so the path stays valid for the caller.
    let (_file, path) = tmp.keep().map_err(|e| format!("keep temp file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::sanitize_ext;

    #[test]
    fn keeps_clean_extensions() {
        assert_eq!(sanitize_ext("png"), "png");
        assert_eq!(sanitize_ext("JPEG"), "jpeg");
        assert_eq!(sanitize_ext("webp"), "webp");
    }

    #[test]
    fn strips_junk_and_defaults() {
        assert_eq!(sanitize_ext("p.n/g"), "png");
        assert_eq!(sanitize_ext(""), "png");
        assert_eq!(sanitize_ext("../../etc"), "etc");
        assert_eq!(sanitize_ext("!@#$"), "png");
    }
}
