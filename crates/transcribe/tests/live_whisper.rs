//! Real Whisper on a speech WAV through the live chunker, as the recorder does it while recording.
//! Ignored: needs whisper.cpp and the models in `%APPDATA%/com.marz.recorder`, and a 48 kHz mono
//! 16-bit WAV in `MARZ_LIVE_TEST_WAV`. `MARZ_LIVE_TEST_OUT` gets the words as JSON.
//! Run: `cargo test -p marz-transcribe --test live_whisper -- --ignored --nocapture`

use marz_transcribe::live::{chunk_for_whisper, transcribe_chunk, ChunkPlanner, GrowingWav, LiveWhisper};
use marz_transcribe::models::{model_path, MAIN_MODEL, VAD_MODEL};
use marz_transcribe::run::append_words;
use std::path::PathBuf;
use std::time::Instant;

#[test]
#[ignore]
fn live_chunks_through_real_whisper() {
    let wav = PathBuf::from(std::env::var("MARZ_LIVE_TEST_WAV").expect("set MARZ_LIVE_TEST_WAV"));
    let data = PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.marz.recorder");
    let whisper = marz_transcribe::find_whisper(None, Some(&data)).expect("whisper-cli");
    let work = std::env::temp_dir().join(format!("marz-live-test-{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();
    let model = model_path(&data, &MAIN_MODEL);
    let vad = model_path(&data, &VAD_MODEL);
    let w = LiveWhisper { whisper: &whisper, model: &model, vad: Some(&vad), work: &work, prompt: "Pricing page. Refunds and cancellations. Data privacy. Export button." };

    let mut g = GrowingWav::new(&wav);
    let mut p = ChunkPlanner::new(48_000);
    let mut words = Vec::new();
    // Feed 2 s at a time, as the file would grow.
    loop {
        let pcm = g.read_new(96_000).unwrap();
        let end = pcm.is_empty();
        p.push(&pcm);
        while let Some(c) = p.next(end) {
            let Some(pcm16) = chunk_for_whisper(&c.pcm, 48_000) else {
                println!("chunk at {:.1} s: silence, skipped", c.start_us as f64 / 1e6);
                continue;
            };
            let t = Instant::now();
            let got = transcribe_chunk(&w, &pcm16, c.start_us, 0, &|| false).unwrap();
            println!(
                "chunk at {:.1} s ({:.1} s audio): {} words in {} ms: {}",
                c.start_us as f64 / 1e6,
                c.pcm.len() as f64 / 48_000.0,
                got.len(),
                t.elapsed().as_millis(),
                got.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
            );
            append_words(&mut words, got);
        }
        if end {
            break;
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    assert!(words.len() > 20, "Whisper found too few words: {}", words.len());
    if let Ok(out) = std::env::var("MARZ_LIVE_TEST_OUT") {
        let json: Vec<_> = words.iter().map(|w| serde_json::json!({ "text": w.text, "startUs": w.start_us, "endUs": w.end_us })).collect();
        std::fs::write(out, serde_json::to_string(&json).unwrap()).unwrap();
    }
}
