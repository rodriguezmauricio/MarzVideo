//! The AI step through the Claude Code CLI already installed and signed in on this PC (Mauricio's
//! subscription, no API key). Only the prompt text goes in: no tools, no MCP servers, no settings, no
//! saved session, started in an empty temp folder.

use serde::Serialize;
use serde_json::Value;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum AiError {
    NotInstalled,
    NotSignedIn,
    UsageLimit,
    Failed(String),
    Cancelled,
}

/// The running `claude` child, so `ai_cancel` can kill it.
#[derive(Default)]
pub struct AiRun(Mutex<Option<Child>>);

fn exe_names() -> &'static [&'static str] {
    if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] }
}

/// `MARZ_CLAUDE`, then PATH, then the default install folder (`~/.local/bin`).
pub fn find_claude_in(env_override: Option<&OsStr>, path_var: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = env_override.filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    if let Some(path) = path_var {
        for dir in std::env::split_paths(path) {
            for name in exe_names() {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    let home = home?;
    exe_names().iter().map(|n| home.join(".local").join("bin").join(n)).find(|p| p.is_file())
}

pub fn find_claude() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    find_claude_in(std::env::var_os("MARZ_CLAUDE").as_deref(), std::env::var_os("PATH").as_deref(), home.as_deref())
}

/// The CLI arguments. The schema is passed inline (the CLI takes JSON text).
pub fn claude_args(schema: &str, model: &str, effort: &str) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        schema,
        "--tools",
        "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--model",
        model,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if !effort.is_empty() {
        a.push("--effort".into());
        a.push(effort.into());
    }
    a
}

fn classify(text: &str) -> Option<AiError> {
    let t = text.to_ascii_lowercase();
    if t.contains("/login") || t.contains("not logged in") || t.contains("invalid api key") || t.contains("authentication") || t.contains("oauth token") {
        return Some(AiError::NotSignedIn);
    }
    if t.contains("usage limit") || t.contains("limit reached") || t.contains("rate limit") || t.contains("rate_limit") || t.contains("hour limit") {
        return Some(AiError::UsageLimit);
    }
    None
}

/// Reads the CLI's JSON answer: the structured result as JSON text, or why there is none.
pub fn parse_claude_output(stdout: &str, stderr: &str, code: i32) -> Result<String, AiError> {
    let parsed: Option<Value> = serde_json::from_str(stdout.trim()).ok();
    if let Some(v) = parsed {
        let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        let result_text = v.get("result").and_then(Value::as_str).unwrap_or("");
        if is_error {
            return Err(classify(result_text).or_else(|| classify(stderr)).unwrap_or_else(|| AiError::Failed(short(result_text))));
        }
        if let Some(s) = v.get("structured_output").filter(|s| s.is_object()) {
            return Ok(s.to_string());
        }
        // Older CLIs put the JSON in `result` as text.
        if let Ok(s) = serde_json::from_str::<Value>(result_text) {
            if s.is_object() {
                return Ok(s.to_string());
            }
        }
        return Err(AiError::Failed("Claude Code gave no structured answer".into()));
    }
    let both = format!("{stdout}\n{stderr}");
    Err(classify(&both).unwrap_or_else(|| AiError::Failed(short(if stderr.trim().is_empty() { stdout } else { stderr }).to_string() + &format!(" (exit {code})"))))
}

fn short(s: &str) -> String {
    s.trim().chars().take(300).collect()
}

fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// A fresh empty folder for the child to start in, so no project file is reachable from it.
fn empty_dir() -> Result<PathBuf, AiError> {
    let d = std::env::temp_dir().join(format!("marz-ai-{}-{}", std::process::id(), Instant::now().elapsed().as_nanos() ^ rand_seed()));
    std::fs::create_dir_all(&d).map_err(|e| AiError::Failed(e.to_string()))?;
    Ok(d)
}

fn rand_seed() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// Runs one `claude -p` call. Blocking; the Tauri command runs it off the main thread.
pub fn run_claude(run: &AiRun, claude: &Path, prompt: &str, schema: &str, model: &str, effort: &str) -> Result<String, AiError> {
    let dir = empty_dir()?;
    let mut cmd = command(claude);
    cmd.args(claude_args(schema, model, effort))
        .current_dir(&dir)
        // The subscription, never an API key that would bill per token.
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { AiError::NotInstalled } else { AiError::Failed(e.to_string()) })?;
    let mut stdin = child.stdin.take();
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let prompt_owned = prompt.to_string();
    let in_t = std::thread::spawn(move || {
        if let Some(i) = stdin.as_mut() {
            let _ = i.write_all(prompt_owned.as_bytes());
        }
        drop(stdin);
    });
    *run.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(child);

    let started = Instant::now();
    let code = loop {
        let mut guard = run.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(child) = guard.as_mut() else {
            // `ai_cancel` took and killed it.
            let _ = in_t.join();
            let _ = std::fs::remove_dir_all(&dir);
            return Err(AiError::Cancelled);
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                *guard = None;
                break status.code().unwrap_or(-1);
            }
            Ok(None) if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                *guard = None;
                let _ = std::fs::remove_dir_all(&dir);
                return Err(AiError::Failed("Claude Code took longer than 5 minutes".into()));
            }
            Ok(None) => {}
            Err(e) => {
                *guard = None;
                return Err(AiError::Failed(e.to_string()));
            }
        }
        drop(guard);
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = in_t.join();
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    parse_claude_output(&stdout, &stderr, code)
}

#[tauri::command(async)]
pub fn ai_edit_pass(run: State<'_, AiRun>, prompt: String, schema: String, model: String, effort: String) -> Result<String, AiError> {
    let claude = find_claude().ok_or(AiError::NotInstalled)?;
    run_claude(&run, &claude, &prompt, &schema, &model, &effort)
}

#[tauri::command]
pub fn ai_cancel(run: State<'_, AiRun>) {
    if let Some(mut child) = run.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_have_no_tools_and_no_session() {
        let a = claude_args("{\"type\":\"object\"}", "sonnet", "high");
        let pos = |flag: &str| a.iter().position(|x| x == flag).unwrap_or_else(|| panic!("missing {flag}"));
        assert_eq!(a[0], "-p");
        assert_eq!(a[pos("--tools") + 1], "");
        assert_eq!(a[pos("--setting-sources") + 1], "");
        assert_eq!(a[pos("--output-format") + 1], "json");
        assert_eq!(a[pos("--json-schema") + 1], "{\"type\":\"object\"}");
        assert_eq!(a[pos("--model") + 1], "sonnet");
        assert_eq!(a[pos("--effort") + 1], "high");
        assert!(a.contains(&"--no-session-persistence".to_string()));
        assert!(a.contains(&"--strict-mcp-config".to_string()));
        assert!(!claude_args("{}", "sonnet", "").contains(&"--effort".to_string()));
    }

    #[test]
    fn parses_structured_output_from_json_mode() {
        let out = r#"{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"mistakes":[],"contextFillers":["w3"],"zooms":[]},"usage":{"output_tokens":12}}"#;
        let v: Value = serde_json::from_str(&parse_claude_output(out, "", 0).unwrap()).unwrap();
        assert_eq!(v["contextFillers"][0], "w3");
    }

    #[test]
    fn reads_json_from_result_text_when_there_is_no_structured_output() {
        let out = r#"{"is_error":false,"result":"{\"mistakes\":[],\"contextFillers\":[],\"zooms\":[]}"}"#;
        assert!(parse_claude_output(out, "", 0).is_ok());
    }

    #[test]
    fn not_logged_in_maps_to_not_signed_in() {
        let out = r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#;
        assert_eq!(parse_claude_output(out, "", 1), Err(AiError::NotSignedIn));
        assert_eq!(parse_claude_output("", "Invalid API key · Please run /login", 1), Err(AiError::NotSignedIn));
    }

    #[test]
    fn usage_limit_maps_to_usage_limit() {
        let out = r#"{"is_error":true,"result":"Claude AI usage limit reached|1763600000"}"#;
        assert_eq!(parse_claude_output(out, "", 1), Err(AiError::UsageLimit));
        assert_eq!(parse_claude_output("", "5-hour limit reached ∙ resets 3pm", 1), Err(AiError::UsageLimit));
    }

    #[test]
    fn other_errors_keep_their_text() {
        assert!(matches!(parse_claude_output("garbage", "boom", 2), Err(AiError::Failed(s)) if s.contains("boom")));
        assert!(matches!(parse_claude_output(r#"{"is_error":false,"result":"hello"}"#, "", 0), Err(AiError::Failed(_))));
    }

    #[test]
    fn missing_binary_maps_to_not_installed() {
        let dir = std::env::temp_dir().join("marz-ai-test-empty");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(find_claude_in(None, Some(dir.as_os_str()), Some(&dir)), None);
        assert_eq!(find_claude_in(Some(OsStr::new("C:/nope/claude.exe")), None, None), None);
        let run = AiRun::default();
        assert_eq!(run_claude(&run, Path::new("C:/nope/claude-missing.exe"), "hi", "{}", "sonnet", ""), Err(AiError::NotInstalled));
    }

    #[test]
    fn finds_claude_on_path() {
        let dir = std::env::temp_dir().join("marz-ai-test-path");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(exe_names()[0]);
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(find_claude_in(None, Some(dir.as_os_str()), None), Some(exe.clone()));
        assert_eq!(find_claude_in(Some(exe.as_os_str()), None, None), Some(exe));
    }

    #[test]
    fn errors_serialize_as_kind_and_detail() {
        assert_eq!(serde_json::to_string(&AiError::NotSignedIn).unwrap(), r#"{"kind":"notSignedIn"}"#);
        assert_eq!(serde_json::to_string(&AiError::Failed("x".into())).unwrap(), r#"{"kind":"failed","detail":"x"}"#);
    }
}
