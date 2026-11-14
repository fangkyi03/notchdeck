//! Quick translation through any OpenAI-compatible chat API
//! (DeepSeek, Kimi, Qwen, SiliconFlow, Volcano Ark, OpenAI, or custom).

use serde_json::{json, Value};
use std::time::Duration;

pub const SECRET_ID: &str = "translate";

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// `target`: "auto" (Chinese ⇄ English), "zh", "en", "ja", …
pub fn translate(cfg: &Value, text: &str, target: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("没有要翻译的内容".into());
    }
    let t = cfg.get("translate").cloned().unwrap_or(Value::Null);
    let base = t.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").trim_end_matches('/').to_string();
    let model = t.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if base.is_empty() || model.is_empty() {
        return Err("请先在 设置 › 翻译 中选择服务并填写模型".into());
    }
    if !base.starts_with("https://") && !base.starts_with("http://localhost") && !base.starts_with("http://127.0.0.1") {
        return Err("接口地址需要使用 HTTPS".into());
    }
    let key = crate::usage::secret_get(SECRET_ID).ok_or("请先在 设置 › 翻译 中填写 API Key")?;
    let lang = match target {
        "auto" => if has_cjk(text) { "English" } else { "简体中文" },
        "zh" => "简体中文",
        "en" => "English",
        "ja" => "日本語",
        "ko" => "한국어",
        other => other,
    };
    let body = json!({
        "model": model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": format!("You are a professional translator. Translate the user's text into {lang}. Keep the original formatting, code and proper nouns. Output only the translation, without explanations or quotes.") },
            { "role": "user", "content": text }
        ]
    });
    let resp = crate::net::agent(Duration::from_secs(60))
        .post(&format!("{base}/chat/completions"))
        .set("Authorization", &format!("Bearer {key}"))
        .send_json(body);
    let v: Value = match resp {
        Ok(r) => r.into_json().map_err(|_| "返回格式不对".to_string())?,
        Err(ureq::Error::Status(code, r)) => {
            let b: Value = r.into_json().unwrap_or(Value::Null);
            let msg = b.pointer("/error/message").and_then(|x| x.as_str()).unwrap_or("");
            return Err(format!("翻译服务返回 HTTP {code} {msg}").trim().to_string());
        }
        Err(e) => return Err(format!("网络错误：{e}")),
    };
    v.pointer("/choices/0/message/content").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).ok_or_else(|| "返回中没有译文".into())
}
