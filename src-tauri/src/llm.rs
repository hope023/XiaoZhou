use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;

/// 流式事件：通过 Channel 专属推送给发起本次请求的调用方，
/// 避免并发会话时事件串台。
///
/// 注意 `rename_all_fields`：只写 `rename_all` 只会重命名 variant 名，
/// variant 内部的 `tool_calls` / `finish_reason` 仍是下划线，前端会读不到。
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LlmEvent {
    /// 正文增量
    Delta { text: String },
    /// 思考内容增量（reasoning_content，DeepSeek R1 / GLM 等推理模型）
    Reasoning { text: String },
    /// 本轮结束，带上完整正文与累积后的工具调用
    Done {
        content: String,
        reasoning: Option<String>,
        tool_calls: Vec<Value>,
        finish_reason: Option<String>,
        usage: Option<Value>,
    },
    Error { message: String },
}

fn truncate(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push_str("…");
    }
    out
}

/// 把用户填的 baseUrl 补全成 chat/completions 端点。
/// 支持：.../chat/completions、.../v1、.../api/paas/v4、https://api.deepseek.com
fn endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return String::new();
    }
    if base.ends_with("/chat/completions") {
        return base.to_string();
    }

    // 末段是版本号（v1 / v4 / v1beta 这类）说明 baseUrl 自带了版本路径，
    // 智谱的 /api/paas/v4 就是这种，不能再补 /v1
    let last = base.rsplit('/').next().unwrap_or("");
    let mut chars = last.chars();
    let starts_with_v = matches!(chars.next(), Some('v') | Some('V'));
    let rest: String = chars.collect();
    let looks_like_version =
        starts_with_v && rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false);

    if looks_like_version {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn new_tool_slot() -> Value {
    json!({ "id": "", "type": "function", "function": { "name": "", "arguments": "" } })
}

fn merge_tool_call(slots: &mut Vec<Value>, tc: &Value) {
    let idx = tc.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
    while slots.len() <= idx {
        slots.push(new_tool_slot());
    }
    let slot = &mut slots[idx];

    if let Some(id) = tc.get("id").and_then(Value::as_str) {
        if !id.is_empty() {
            slot["id"] = json!(id);
        }
    }
    if let Some(func) = tc.get("function") {
        if let Some(name) = func.get("name").and_then(Value::as_str) {
            if !name.is_empty() {
                slot["function"]["name"] = json!(name);
            }
        }
        if let Some(args) = func.get("arguments").and_then(Value::as_str) {
            let merged = format!(
                "{}{}",
                slot["function"]["arguments"].as_str().unwrap_or(""),
                args
            );
            slot["function"]["arguments"] = json!(merged);
        }
    }
}

#[tauri::command]
pub async fn llm_stream(
    on_event: Channel<LlmEvent>,
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<Value>,
    tools: Option<Vec<Value>>,
    temperature: Option<f64>,
) -> Result<(), String> {
    let url = endpoint(&base_url);
    if url.is_empty() {
        return Err("还没有配置接口地址（Base URL）".into());
    }
    if model.trim().is_empty() {
        return Err("还没有配置模型名称".into());
    }

    let mut body = json!({
        "model": model.trim(),
        "messages": messages,
        "stream": true,
        "temperature": temperature.unwrap_or(0.7),
    });
    if let Some(list) = tools {
        if !list.is_empty() {
            body["tools"] = json!(list);
            body["tool_choice"] = json!("auto");
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");
    let key = api_key.trim();
    if !key.is_empty() {
        request = request.header("Authorization", format!("Bearer {key}"));
    }

    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败（{url}）：{e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        // 404 常见原因是接口地址拼错，这里直接把实际请求的 URL 摊给用户看
        let detail = if text.trim().is_empty() {
            match status.as_u16() {
                401 | 403 => "密钥无效或没有权限，检查一下 API Key".to_string(),
                404 => format!("路径不存在，实际请求的是 {url}，检查接口地址要不要带 /v1 或 /v4"),
                429 => "请求太频繁或额度用完了，等一会儿再试".to_string(),
                _ => format!("响应为空，实际请求的是 {url}"),
            }
        } else {
            truncate(&text, 600)
        };
        let message = format!("接口返回 {}：{}", status.as_u16(), detail);
        let _ = on_event.send(LlmEvent::Error {
            message: message.clone(),
        });
        return Err(message);
    }

    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("event-stream"))
        .unwrap_or(false);

    // 有些兼容网关会忽略 stream:true，直接返回完整 JSON —— 兜底解析
    if !is_sse {
        let text = response.text().await.unwrap_or_default();
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|_| format!("响应无法解析：{}", truncate(&text, 500)))?;
        if let Some(err) = parsed.get("error") {
            let message = format!("接口报错：{}", truncate(&err.to_string(), 500));
            let _ = on_event.send(LlmEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
        let choice = parsed
            .get("choices")
            .and_then(|c| c.get(0))
            .cloned()
            .unwrap_or(Value::Null);
        let message = choice.get("message").cloned().unwrap_or(Value::Null);
        let content = message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let reasoning = message
            .get("reasoning_content")
            .and_then(Value::as_str)
            .map(str::to_string);
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let finish_reason = choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .map(str::to_string);
        if !content.is_empty() {
            let _ = on_event.send(LlmEvent::Delta {
                text: content.clone(),
            });
        }
        let _ = on_event.send(LlmEvent::Done {
            content,
            reasoning,
            tool_calls,
            finish_reason,
            usage: parsed.get("usage").cloned(),
        });
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut content = String::new();
    let mut reasoning: Option<String> = None;
    let mut tool_slots: Vec<Value> = Vec::new();
    let mut finish_reason: Option<String> = None;
    let mut usage: Option<Value> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let message = format!("读取流失败：{e}");
                let _ = on_event.send(LlmEvent::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // 按行切割 SSE
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim_end_matches('\r').to_string();
            buffer.drain(..=pos);

            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                finish_reason.get_or_insert_with(|| "stop".to_string());
                break;
            }
            let Ok(value) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(err) = value.get("error") {
                if !err.is_null() {
                    let message = format!("接口报错：{}", truncate(&err.to_string(), 500));
                    let _ = on_event.send(LlmEvent::Error {
                        message: message.clone(),
                    });
                    return Err(message);
                }
            }
            if let Some(u) = value.get("usage") {
                if !u.is_null() {
                    usage = Some(u.clone());
                }
            }
            let Some(choice) = value.get("choices").and_then(|c| c.get(0)) else {
                continue;
            };
            if let Some(fr) = choice.get("finish_reason").and_then(Value::as_str) {
                if !fr.is_empty() {
                    finish_reason = Some(fr.to_string());
                }
            }
            let Some(delta) = choice.get("delta") else {
                continue;
            };
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    content.push_str(text);
                    let _ = on_event.send(LlmEvent::Delta {
                        text: text.to_string(),
                    });
                }
            }
            if let Some(text) = delta.get("reasoning_content").and_then(Value::as_str) {
                if !text.is_empty() {
                    reasoning
                        .get_or_insert_with(String::new)
                        .push_str(text);
                    let _ = on_event.send(LlmEvent::Reasoning {
                        text: text.to_string(),
                    });
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for tc in calls {
                    merge_tool_call(&mut tool_slots, tc);
                }
            }
        }
    }

    // 丢掉空壳（没有 name 的槽位）
    tool_slots.retain(|slot| {
        slot["function"]["name"]
            .as_str()
            .map(|n| !n.is_empty())
            .unwrap_or(false)
    });

    let _ = on_event.send(LlmEvent::Done {
        content,
        reasoning,
        tool_calls: tool_slots,
        finish_reason,
        usage,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::endpoint;

    #[test]
    fn builds_endpoint_for_common_providers() {
        // 只填域名：补 /v1
        assert_eq!(
            endpoint("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        // 已经带 /v1：不重复补
        assert_eq!(
            endpoint("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        // 智谱：版本段是 /v4，不能再补 /v1
        assert_eq!(
            endpoint("https://open.bigmodel.cn/api/paas/v4"),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        // 通义千问兼容模式
        assert_eq!(
            endpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
        // 已经是完整端点：原样返回
        assert_eq!(
            endpoint("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
        // 本地 llama.cpp
        assert_eq!(
            endpoint("http://127.0.0.1:8080"),
            "http://127.0.0.1:8080/v1/chat/completions"
        );
        // 前后空白与结尾斜杠
        assert_eq!(
            endpoint("  https://api.deepseek.com/  "),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(endpoint(""), "");
    }
}
