//! The swappable AI provider (design `docs/superpowers/specs/2026-11-19-ai-provider-design.md`).
//! The editor's AI pass and the live checklist both ask through `ask`: Claude Code (`claude -p`, the
//! default, unchanged), the Anthropic API (raw HTTP, key in Credential Manager), a local OpenAI
//! compatible server, or Off. Only the prompt text goes out, never video, audio or file paths.

use crate::ai::{self, AiError, AiRun};
use crate::secret::{self, Secret};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tauri::AppHandle;

pub const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2026-10-21";
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// The models Settings offers for the AI pass; the first is the default.
pub const ANTHROPIC_MODELS: [&str; 2] = ["claude-opus-5-5", "claude-sonnet-5-5"];
/// The live checklist ask: a few lines of text, small and quick.
pub const ANTHROPIC_CHECKLIST_MODEL: &str = "claude-haiku-5-5";
pub const LOCAL_DEFAULT_URL: &str = "http://localhost:11434";
const MAX_TOKENS: u32 = 32_000;
/// Same limit as a Claude Code run.
const TIMEOUT: Duration = Duration::from_secs(300);
const TEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    #[default]
    ClaudeCode,
    Anthropic,
    Local,
    Off,
}

/// `settings.json` `ai`. No key here: the key is in Credential Manager.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConfig {
    pub provider: ProviderKind,
    pub anthropic_model: String,
    pub local_url: String,
    pub local_model: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        AiConfig { provider: ProviderKind::ClaudeCode, anthropic_model: ANTHROPIC_MODELS[0].into(), local_url: LOCAL_DEFAULT_URL.into(), local_model: String::new() }
    }
}

impl AiConfig {
    /// Unknown models and empty addresses fall back to the defaults.
    pub fn cleaned(mut self) -> AiConfig {
        if !ANTHROPIC_MODELS.contains(&self.anthropic_model.as_str()) {
            self.anthropic_model = ANTHROPIC_MODELS[0].into();
        }
        self.local_url = self.local_url.trim().trim_end_matches('/').to_string();
        if self.local_url.is_empty() {
            self.local_url = LOCAL_DEFAULT_URL.into();
        }
        self.local_model = self.local_model.trim().to_string();
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Purpose {
    /// The editor's AI pass after Stop.
    Edit,
    /// The rate-limited ask while recording.
    Checklist,
}

/// What came back, and from whom (recorded in `edits.ai.provider` and `model`).
#[derive(Serialize, Debug, PartialEq)]
pub struct Answer {
    pub text: String,
    pub provider: String,
    pub model: String,
}

// ---------- HTTP ----------

pub struct Reply {
    pub status: u16,
    pub body: String,
}

/// One request; any HTTP status is a reply, only a transport failure is an Err.
pub fn http(url: &str, headers: &[(&str, &str)], body: Option<&str>, timeout: Duration) -> Result<Reply, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(timeout)).http_status_as_error(false).build().into();
    let result = match body {
        Some(b) => {
            let mut r = agent.post(url);
            for (k, v) in headers {
                r = r.header(*k, *v);
            }
            r.content_type("application/json").send(b)
        }
        None => {
            let mut r = agent.get(url);
            for (k, v) in headers {
                r = r.header(*k, *v);
            }
            r.call()
        }
    };
    let mut resp = result.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok(Reply { status, body })
}

/// Runs `f` on its own thread so `ai_cancel` can stop waiting for it (the request finishes in the
/// background and its answer is dropped).
fn cancellable<T: Send + 'static>(run: &AiRun, f: impl FnOnce() -> T + Send + 'static) -> Result<T, AiError> {
    let flag = Arc::new(AtomicBool::new(false));
    *run.http_cancel.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(flag.clone());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    let out = loop {
        if flag.load(Ordering::SeqCst) {
            break Err(AiError::Cancelled);
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(v) => break Ok(v),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err(AiError::Failed("The AI request stopped".into())),
        }
    };
    *run.http_cancel.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    out
}

fn short(s: &str) -> String {
    s.trim().chars().take(300).collect()
}

/// The JSON object in a model's text: code fences and text around it are dropped.
pub fn json_object_in(text: &str) -> Option<String> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return v.is_object().then(|| v.to_string());
    }
    let (start, end) = (t.find('{')?, t.rfind('}')?);
    let v: Value = serde_json::from_str(t.get(start..=end)?).ok()?;
    v.is_object().then(|| v.to_string())
}

// ---------- Anthropic API ----------

pub fn anthropic_model(cfg: &AiConfig, purpose: Purpose) -> String {
    match purpose {
        Purpose::Edit => cfg.clone().cleaned().anthropic_model,
        Purpose::Checklist => ANTHROPIC_CHECKLIST_MODEL.into(),
    }
}

fn anthropic_effort(purpose: Purpose) -> &'static str {
    match purpose {
        Purpose::Edit => "high",
        Purpose::Checklist => "low",
    }
}

/// Haiku has no server-side fallback; Opus and Sonnet re-run a safety decline on a fallback model.
fn has_fallback(model: &str) -> bool {
    !model.contains("haiku")
}

pub fn anthropic_body(model: &str, effort: &str, prompt: &str, schema: &Value) -> Value {
    let mut b = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": [{ "role": "user", "content": prompt }],
        "output_config": { "format": { "type": "json_schema", "schema": schema }, "effort": effort },
    });
    if has_fallback(model) {
        b["fallbacks"] = json!("default");
    }
    b
}

fn anthropic_headers<'a>(key: &'a Secret, model: &str) -> Vec<(&'static str, &'a str)> {
    let mut h = vec![("x-api-key", key.expose()), ("anthropic-version", API_VERSION)];
    if has_fallback(model) {
        h.push(("anthropic-beta", FALLBACK_BETA));
    }
    h
}

fn api_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| short(body))
}

/// The structured answer of a Messages reply, or why there is none.
pub fn parse_anthropic(status: u16, body: &str) -> Result<String, AiError> {
    if status != 200 {
        let msg = api_message(body);
        return Err(match status {
            401 | 403 => AiError::BadKey,
            429 | 529 => AiError::UsageLimit,
            _ if msg.to_ascii_lowercase().contains("credit balance") => AiError::UsageLimit,
            _ => AiError::Failed(format!("Anthropic API {status}: {}", short(&msg))),
        });
    }
    let v: Value = serde_json::from_str(body).map_err(|_| AiError::Failed("The Anthropic API answered with invalid JSON".into()))?;
    match v.get("stop_reason").and_then(Value::as_str) {
        Some("refusal") => return Err(AiError::Failed("Claude declined this request".into())),
        Some("max_tokens") => return Err(AiError::Failed("The answer was cut off".into())),
        _ => {}
    }
    let text = v
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| blocks.iter().rev().find(|b| b.get("type").and_then(Value::as_str) == Some("text")))
        .and_then(|b| b.get("text").and_then(Value::as_str))
        .unwrap_or("");
    json_object_in(text).ok_or_else(|| AiError::Failed("The Anthropic API gave no structured answer".into()))
}

pub fn ask_anthropic_at(base: &str, key: &Secret, model: &str, effort: &str, prompt: &str, schema: &str) -> Result<String, AiError> {
    let schema: Value = serde_json::from_str(schema).map_err(|e| AiError::Failed(format!("bad schema: {e}")))?;
    let body = anthropic_body(model, effort, prompt, &schema).to_string();
    let reply = http(&format!("{base}/v1/messages"), &anthropic_headers(key, model), Some(&body), TIMEOUT).map_err(|e| AiError::Failed(format!("Could not reach the Anthropic API: {}", short(&e))))?;
    parse_anthropic(reply.status, &reply.body)
}

/// Checks the key and the model without spending anything (the Models API is free).
pub fn test_anthropic_at(base: &str, key: &Secret, model: &str) -> TestResult {
    let h = [("x-api-key", key.expose()), ("anthropic-version", API_VERSION)];
    match http(&format!("{base}/v1/models/{model}"), &h, None, TEST_TIMEOUT) {
        Err(e) => TestResult::fail(format!("Could not reach the Anthropic API. {}", short(&e))),
        Ok(r) if r.status == 200 => TestResult::ok(format!("Connected. {model} is ready.")),
        Ok(r) if r.status == 401 || r.status == 403 => TestResult::fail("The key was refused. Check it and save it again."),
        Ok(r) if r.status == 404 => TestResult::fail(format!("The key works, but {model} was not found.")),
        Ok(r) => TestResult::fail(format!("The Anthropic API answered {}: {}", r.status, short(&api_message(&r.body)))),
    }
}

// ---------- Local (OpenAI compatible) ----------

/// `http://localhost:11434` gives `http://localhost:11434/v1`; an address ending in `/v1` stays.
pub fn local_base(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    if u.ends_with("/v1") { u.to_string() } else { format!("{u}/v1") }
}

pub fn openai_body(model: &str, prompt: &str, schema: &Value) -> Value {
    json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": format!("Answer only with one JSON object that matches this JSON Schema, with no other text:\n{schema}") },
            { "role": "user", "content": prompt },
        ],
        "response_format": { "type": "json_schema", "json_schema": { "name": "answer", "strict": true, "schema": schema } },
    })
}

pub fn parse_openai(status: u16, body: &str, model: &str) -> Result<String, AiError> {
    if status != 200 {
        let msg = api_message(body);
        if status == 404 || msg.to_ascii_lowercase().contains("not found") {
            return Err(AiError::Failed(format!("The local AI has no model named {model}")));
        }
        return Err(AiError::Failed(format!("The local AI answered {status}: {}", short(&msg))));
    }
    let v: Value = serde_json::from_str(body).map_err(|_| AiError::Failed("The local AI answered with invalid JSON".into()))?;
    let text = v.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or("");
    json_object_in(text).ok_or_else(|| AiError::Failed("The local AI gave no JSON answer".into()))
}

pub fn ask_local_at(url: &str, model: &str, prompt: &str, schema: &str) -> Result<String, AiError> {
    if model.trim().is_empty() {
        return Err(AiError::Failed("No local model name is set in Settings".into()));
    }
    let schema: Value = serde_json::from_str(schema).map_err(|e| AiError::Failed(format!("bad schema: {e}")))?;
    let body = openai_body(model, prompt, &schema).to_string();
    let reply = http(&format!("{}/chat/completions", local_base(url)), &[], Some(&body), TIMEOUT).map_err(|e| AiError::Unreachable(short(&e)))?;
    parse_openai(reply.status, &reply.body, model)
}

pub fn test_local_at(url: &str, model: &str) -> TestResult {
    let r = match http(&format!("{}/models", local_base(url)), &[], None, TEST_TIMEOUT) {
        Err(_) => return TestResult::fail(format!("Nothing answered at {url}. Start the local AI or check the address.")),
        Ok(r) => r,
    };
    if r.status != 200 {
        return TestResult::fail(format!("{url} answered {}. It may not be an OpenAI compatible server.", r.status));
    }
    let ids: Vec<String> = serde_json::from_str::<Value>(&r.body)
        .ok()
        .and_then(|v| v.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let list = if ids.is_empty() { "none".to_string() } else { ids.iter().take(6).cloned().collect::<Vec<_>>().join(", ") };
    let model = model.trim();
    if model.is_empty() {
        return TestResult::fail(format!("Connected. Type a model name. Found: {list}."));
    }
    // Ollama lists "llama3.1:latest" for "llama3.1".
    if ids.iter().any(|id| id == model || id.strip_suffix(":latest") == Some(model)) {
        TestResult::ok(format!("Connected. {model} is ready."))
    } else {
        TestResult::fail(format!("Connected, but there is no model named {model}. Found: {list}."))
    }
}

// ---------- The one entry point ----------

/// Ask the provider in `cfg`. `claude_model` and `claude_effort` are the Claude Code settings.
pub fn ask(run: &AiRun, cfg: &AiConfig, purpose: Purpose, prompt: &str, schema: &str, claude_model: &str, claude_effort: &str) -> Result<Answer, AiError> {
    let cfg = cfg.clone().cleaned();
    match cfg.provider {
        ProviderKind::Off => Err(AiError::Off),
        ProviderKind::ClaudeCode => {
            let claude = ai::find_claude().ok_or(AiError::NotInstalled)?;
            let text = ai::run_claude(run, &claude, prompt, schema, claude_model, claude_effort)?;
            Ok(Answer { text, provider: "claude-code".into(), model: claude_model.into() })
        }
        ProviderKind::Anthropic => {
            let key = secret::load().ok_or(AiError::NoKey)?;
            let model = anthropic_model(&cfg, purpose);
            let (p, s, m) = (prompt.to_string(), schema.to_string(), model.clone());
            let effort = anthropic_effort(purpose);
            let text = cancellable(run, move || ask_anthropic_at(ANTHROPIC_BASE, &key, &m, effort, &p, &s))??;
            Ok(Answer { text, provider: "anthropic".into(), model })
        }
        ProviderKind::Local => {
            let (u, m, p, s) = (cfg.local_url.clone(), cfg.local_model.clone(), prompt.to_string(), schema.to_string());
            let text = cancellable(run, move || ask_local_at(&u, &m, &p, &s))??;
            Ok(Answer { text, provider: "local".into(), model: cfg.local_model })
        }
    }
}

// ---------- Settings commands ----------

pub fn config(app: &AppHandle) -> AiConfig {
    crate::settings::load(app).ai.unwrap_or_default().cleaned()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub text: String,
}

impl TestResult {
    fn ok(t: impl Into<String>) -> Self {
        TestResult { ok: true, text: t.into() }
    }
    fn fail(t: impl Into<String>) -> Self {
        TestResult { ok: false, text: t.into() }
    }
}

/// What Settings shows. Never the key: only whether one is saved and its last 4 characters.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    #[serde(flatten)]
    config: AiConfig,
    key_saved: bool,
    key_last4: Option<String>,
    claude: Option<String>,
}

fn view(app: &AppHandle) -> ProviderView {
    let key = secret::load();
    ProviderView {
        config: config(app),
        key_saved: key.is_some(),
        key_last4: key.map(|k| k.last4()),
        claude: ai::find_claude().map(|p| p.to_string_lossy().into_owned()),
    }
}

#[tauri::command(async)]
pub fn ai_provider_get(app: AppHandle) -> ProviderView {
    view(&app)
}

#[tauri::command(async)]
pub fn ai_provider_set(app: AppHandle, config: AiConfig) -> Result<ProviderView, String> {
    let c = config.cleaned();
    if !(c.local_url.starts_with("http://") || c.local_url.starts_with("https://")) {
        return Err("The address starts with http:// or https://.".into());
    }
    crate::settings::update(&app, |s| s.ai = Some(c))?;
    Ok(view(&app))
}

#[tauri::command(async)]
pub fn ai_key_save(app: AppHandle, key: String) -> Result<ProviderView, String> {
    let k = Secret::new(&key).ok_or_else(|| "Paste the key first.".to_string())?;
    drop(key);
    secret::save(&k)?;
    Ok(view(&app))
}

#[tauri::command(async)]
pub fn ai_key_remove(app: AppHandle) -> Result<ProviderView, String> {
    secret::delete()?;
    Ok(view(&app))
}

/// Test the saved provider. Claude Code: found on this PC (a real call would spend his quota).
#[tauri::command(async)]
pub fn ai_provider_test(app: AppHandle) -> TestResult {
    let cfg = config(&app);
    match cfg.provider {
        ProviderKind::Off => TestResult::ok("AI is off. Nothing is sent."),
        ProviderKind::ClaudeCode => match ai::find_claude() {
            Some(_) => TestResult::ok("Claude Code is installed. It uses your Claude subscription."),
            None => TestResult::fail("Claude Code is not installed. Install it and sign in."),
        },
        ProviderKind::Anthropic => match secret::load() {
            None => TestResult::fail("No key saved yet."),
            Some(k) => test_anthropic_at(ANTHROPIC_BASE, &k, &cfg.anthropic_model),
        },
        ProviderKind::Local => test_local_at(&cfg.local_url, &cfg.local_model),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    /// A one-shot HTTP server on 127.0.0.1: answers `status` with `body` and hands back the request.
    fn mock(status: u16, body: &str) -> (String, JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let body = body.to_string();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                head.push_str(&line);
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let mut b = vec![0u8; len];
            r.read_exact(&mut b).unwrap();
            let resp = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            s.write_all(resp.as_bytes()).unwrap();
            head + &String::from_utf8(b).unwrap()
        });
        (base, h)
    }

    /// Nothing listens here (bound, then dropped).
    fn dead_port() -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let a = l.local_addr().unwrap();
        drop(l);
        format!("http://{a}")
    }

    const SCHEMA: &str = r#"{"type":"object","properties":{"covered":{"type":"array","items":{"type":"string"}}},"required":["covered"],"additionalProperties":false}"#;

    fn key() -> Secret {
        Secret::new("sk-ant-test-0000-abcd").unwrap()
    }

    #[test]
    fn config_defaults_and_cleaning() {
        let c: AiConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c, AiConfig::default());
        assert_eq!(c.provider, ProviderKind::ClaudeCode);
        let c: AiConfig = serde_json::from_str(r#"{"provider":"local","anthropicModel":"gpt-9","localUrl":" http://box:8080/ ","localModel":" qwen "}"#).unwrap();
        let c = c.cleaned();
        assert_eq!(c.provider, ProviderKind::Local);
        assert_eq!(c.anthropic_model, "claude-opus-5-5");
        assert_eq!(c.local_url, "http://box:8080");
        assert_eq!(c.local_model, "qwen");
        assert_eq!(serde_json::to_value(ProviderKind::ClaudeCode).unwrap(), "claude-code");
        assert_eq!(serde_json::to_value(&c).unwrap()["localUrl"], "http://box:8080");
    }

    #[test]
    fn anthropic_request_has_structured_output_effort_and_fallback() {
        let (base, req) = mock(200, r#"{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"{\"covered\":[\"c1\"]}"}],"stop_reason":"end_turn"}"#);
        let out = ask_anthropic_at(&base, &key(), "claude-opus-5-5", "high", "the prompt", SCHEMA).unwrap();
        assert_eq!(out, r#"{"covered":["c1"]}"#);
        let raw = req.join().unwrap();
        let low = raw.to_ascii_lowercase();
        assert!(raw.starts_with("POST /v1/messages "), "{raw}");
        assert!(low.contains("x-api-key: sk-ant-test-0000-abcd"));
        assert!(low.contains("anthropic-version: 2026-10-21"));
        assert!(low.contains("anthropic-beta: server-side-fallback-2026-07-01"));
        let body: Value = serde_json::from_str(&raw[raw.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert_eq!(body["output_config"]["format"]["schema"]["required"][0], "covered");
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["messages"][0]["content"], "the prompt");
        assert!(body.get("temperature").is_none());
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn haiku_checklist_ask_has_no_fallback() {
        let b = anthropic_body(ANTHROPIC_CHECKLIST_MODEL, "low", "p", &json!({}));
        assert!(b.get("fallbacks").is_none());
        assert!(!anthropic_headers(&key(), ANTHROPIC_CHECKLIST_MODEL).iter().any(|(h, _)| *h == "anthropic-beta"));
        let c = AiConfig { anthropic_model: "claude-sonnet-5-5".into(), ..Default::default() };
        assert_eq!(anthropic_model(&c, Purpose::Edit), "claude-sonnet-5-5");
        assert_eq!(anthropic_model(&c, Purpose::Checklist), "claude-haiku-5-5");
    }

    #[test]
    fn anthropic_errors_map_to_kinds() {
        assert_eq!(parse_anthropic(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#), Err(AiError::BadKey));
        assert_eq!(parse_anthropic(429, "{}"), Err(AiError::UsageLimit));
        assert_eq!(parse_anthropic(529, "{}"), Err(AiError::UsageLimit));
        assert_eq!(parse_anthropic(400, r#"{"error":{"message":"Your credit balance is too low"}}"#), Err(AiError::UsageLimit));
        assert!(matches!(parse_anthropic(500, r#"{"error":{"message":"boom"}}"#), Err(AiError::Failed(s)) if s.contains("boom")));
        assert!(matches!(parse_anthropic(200, r#"{"content":[],"stop_reason":"refusal"}"#), Err(AiError::Failed(s)) if s.contains("declined")));
        assert!(matches!(parse_anthropic(200, r#"{"content":[{"type":"text","text":"{\"a\""}],"stop_reason":"max_tokens"}"#), Err(AiError::Failed(s)) if s.contains("cut off")));
        assert!(matches!(parse_anthropic(200, r#"{"content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn"}"#), Err(AiError::Failed(_))));
    }

    #[test]
    fn error_texts_never_hold_the_key() {
        let (base, req) = mock(500, r#"{"error":{"message":"internal"}}"#);
        let e = ask_anthropic_at(&base, &key(), "claude-opus-5-5", "high", "p", SCHEMA).unwrap_err();
        req.join().unwrap();
        assert!(!format!("{e:?}").contains("sk-ant"));
        let e = ask_anthropic_at(&dead_port(), &key(), "claude-opus-5-5", "high", "p", SCHEMA).unwrap_err();
        assert!(!format!("{e:?}").contains("sk-ant"));
    }

    #[test]
    fn anthropic_test_uses_the_free_models_endpoint() {
        let (base, req) = mock(200, r#"{"id":"claude-opus-5-5","type":"model"}"#);
        let r = test_anthropic_at(&base, &key(), "claude-opus-5-5");
        assert!(r.ok, "{r:?}");
        assert!(req.join().unwrap().starts_with("GET /v1/models/claude-opus-5-5 "));
        let (base, req) = mock(401, "{}");
        assert!(!test_anthropic_at(&base, &key(), "claude-opus-5-5").ok);
        req.join().unwrap();
        assert!(!test_anthropic_at(&dead_port(), &key(), "claude-opus-5-5").ok);
    }

    #[test]
    fn local_request_and_answer() {
        let (base, req) = mock(200, r#"{"choices":[{"message":{"role":"assistant","content":"```json\n{\"covered\":[]}\n```"}}]}"#);
        let out = ask_local_at(&base, "llama3.1", "the prompt", SCHEMA).unwrap();
        assert_eq!(out, r#"{"covered":[]}"#);
        let raw = req.join().unwrap();
        assert!(raw.starts_with("POST /v1/chat/completions "), "{raw}");
        assert!(!raw.to_ascii_lowercase().contains("x-api-key"));
        let body: Value = serde_json::from_str(&raw[raw.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["model"], "llama3.1");
        assert_eq!(body["stream"], false);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["schema"]["required"][0], "covered");
        assert_eq!(body["messages"][1]["content"], "the prompt");
    }

    #[test]
    fn local_failures() {
        assert!(matches!(ask_local_at(&dead_port(), "m", "p", SCHEMA), Err(AiError::Unreachable(_))));
        assert!(matches!(ask_local_at("http://127.0.0.1:1", "  ", "p", SCHEMA), Err(AiError::Failed(s)) if s.contains("model name")));
        assert!(matches!(parse_openai(404, r#"{"error":{"message":"model 'x' not found"}}"#, "x"), Err(AiError::Failed(s)) if s.contains("no model named x")));
        assert!(matches!(parse_openai(200, r#"{"choices":[{"message":{"content":"sorry"}}]}"#, "x"), Err(AiError::Failed(_))));
    }

    #[test]
    fn local_base_adds_v1_once() {
        assert_eq!(local_base("http://localhost:11434"), "http://localhost:11434/v1");
        assert_eq!(local_base("http://localhost:1234/v1/"), "http://localhost:1234/v1");
    }

    #[test]
    fn local_test_lists_models() {
        let list = r#"{"object":"list","data":[{"id":"llama3.1:latest"},{"id":"qwen2.5:7b"}]}"#;
        let (base, req) = mock(200, list);
        assert!(test_local_at(&base, "llama3.1").ok);
        assert!(req.join().unwrap().starts_with("GET /v1/models "));
        let (base, req) = mock(200, list);
        let r = test_local_at(&base, "mistral");
        req.join().unwrap();
        assert!(!r.ok && r.text.contains("qwen2.5:7b"), "{r:?}");
        assert!(!test_local_at(&dead_port(), "m").ok);
    }

    #[test]
    fn json_object_in_text() {
        assert_eq!(json_object_in("{\"a\":1}").as_deref(), Some("{\"a\":1}"));
        assert_eq!(json_object_in("Here:\n```json\n{\"a\":1}\n```").as_deref(), Some("{\"a\":1}"));
        assert_eq!(json_object_in("[1]"), None);
        assert_eq!(json_object_in("nope"), None);
    }

    #[test]
    fn off_asks_nobody_and_cancel_stops_waiting() {
        let run = AiRun::default();
        let off = AiConfig { provider: ProviderKind::Off, ..Default::default() };
        assert_eq!(ask(&run, &off, Purpose::Edit, "p", SCHEMA, "sonnet", "high"), Err(AiError::Off));
        let run = Arc::new(AiRun::default());
        let r2 = run.clone();
        let t = std::thread::spawn(move || cancellable(&r2, || std::thread::sleep(Duration::from_secs(5))));
        std::thread::sleep(Duration::from_millis(300));
        ai::cancel_run(&run);
        assert_eq!(t.join().unwrap(), Err(AiError::Cancelled));
    }
}
