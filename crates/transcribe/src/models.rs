//! Whisper and VAD model files: names, sizes, download URLs and where they live. Nothing here
//! downloads; the shell runs `curl.exe` with [`download_args`] after the user confirms the size.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// One model file with its exact size (a file of any other size is incomplete or wrong).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelFile {
    pub name: &'static str,
    pub bytes: u64,
    pub url: &'static str,
}

/// The default Whisper model (GPU, measured in the AI spike).
pub const MAIN_MODEL: ModelFile = ModelFile {
    name: "ggml-large-v3-turbo-q5_0.bin",
    bytes: 574_041_195,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
};

/// The Silero VAD model; transcription needs it (no VAD means invented words over silence).
pub const VAD_MODEL: ModelFile = ModelFile {
    name: "ggml-silero-v5.1.2.bin",
    bytes: 885_098,
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
};

/// The smaller CPU model.
pub const SMALL_MODEL: ModelFile = ModelFile {
    name: "ggml-small.bin",
    bytes: 487_601_967,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
};

/// What transcription needs, in download order.
pub const REQUIRED_MODELS: [ModelFile; 2] = [MAIN_MODEL, VAD_MODEL];

/// `{ present, name, bytes }` for the UI. `bytes` is the total download size of [`REQUIRED_MODELS`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelStatus {
    pub present: bool,
    pub name: String,
    pub bytes: u64,
}

/// `<app_data>/models`.
pub fn model_dir(app_data: &Path) -> PathBuf {
    app_data.join("models")
}

/// `<app_data>/models/<name>`.
pub fn model_path(app_data: &Path, m: &ModelFile) -> PathBuf {
    model_dir(app_data).join(m.name)
}

/// True when the model file exists with exactly the right size.
pub fn model_ok(app_data: &Path, m: &ModelFile) -> bool {
    std::fs::metadata(model_path(app_data, m)).map(|md| md.is_file() && md.len() == m.bytes).unwrap_or(false)
}

/// Present only when the main model and the VAD model both exist with the right size.
pub fn model_status(app_data: &Path) -> ModelStatus {
    ModelStatus {
        present: REQUIRED_MODELS.iter().all(|m| model_ok(app_data, m)),
        name: MAIN_MODEL.name.to_string(),
        bytes: REQUIRED_MODELS.iter().map(|m| m.bytes).sum(),
    }
}

/// Arguments for Windows `curl.exe` to fetch `url` into `dest_tmp`. The caller checks the size
/// and renames the file into place.
pub fn download_args(url: &str, dest_tmp: &Path) -> Vec<String> {
    vec!["-L".into(), "--fail".into(), "-o".into(), dest_tmp.display().to_string(), url.to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_needs_both_models_at_the_right_size() {
        let app = std::env::temp_dir().join(format!("marz-models-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&app);
        std::fs::create_dir_all(model_dir(&app)).unwrap();
        let st = model_status(&app);
        assert!(!st.present);
        assert_eq!(st.name, "ggml-large-v3-turbo-q5_0.bin");
        assert_eq!(st.bytes, 574_041_195 + 885_098);

        // Sparse-size files: set_len does not write the bytes.
        let set = |m: &ModelFile, len: u64| {
            let f = std::fs::File::create(model_path(&app, m)).unwrap();
            f.set_len(len).unwrap();
        };
        set(&MAIN_MODEL, MAIN_MODEL.bytes);
        assert!(!model_status(&app).present, "VAD missing");
        set(&VAD_MODEL, VAD_MODEL.bytes - 1);
        assert!(!model_status(&app).present, "VAD truncated");
        set(&VAD_MODEL, VAD_MODEL.bytes);
        assert!(model_status(&app).present);
        let _ = std::fs::remove_dir_all(&app);
    }

    #[test]
    fn urls_and_curl_args() {
        assert!(MAIN_MODEL.url.ends_with(MAIN_MODEL.name));
        assert!(SMALL_MODEL.url.ends_with(SMALL_MODEL.name));
        assert!(VAD_MODEL.url.starts_with("https://huggingface.co/ggml-org/whisper-vad/"));
        let a = download_args(MAIN_MODEL.url, Path::new("x.tmp"));
        assert_eq!(a, vec!["-L", "--fail", "-o", "x.tmp", MAIN_MODEL.url]);
    }
}
