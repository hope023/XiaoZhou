//! 最小可用的 stdio MCP 客户端：能连上 DBX 这类本地 MCP server，
//! 拉取工具列表并代理调用。协议：每行一个 JSON-RPC 2.0 消息。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

struct McpServer {
    stdin_tx: mpsc::Sender<String>,
    tools: std::sync::RwLock<Vec<Value>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    process: Mutex<Option<Child>>,
}

impl McpServer {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|_| "锁损坏")?.insert(id, tx);

        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.stdin_tx
            .send(message.to_string())
            .await
            .map_err(|_| "server 进程已退出".to_string())?;

        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("请求被取消".into()),
            Err(_) => {
                self.pending.lock().ok().and_then(|mut p| p.remove(&id));
                Err(format!("{method} 超时（30s）"))
            }
        }
    }
}

fn server_table() -> &'static Mutex<HashMap<String, Arc<McpServer>>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Arc<McpServer>>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mcp_config_path() -> PathBuf {
    super::tools::app_data_dir().join("mcp.json")
}

#[tauri::command]
pub fn mcp_load_config() -> Value {
    std::fs::read_to_string(mcp_config_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({ "mcpServers": {} }))
}

#[tauri::command]
pub fn mcp_save_config(config: Value) -> Result<(), String> {
    let dir = super::tools::app_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    std::fs::write(mcp_config_path(), serde_json::to_string_pretty(&config).unwrap_or_default())
        .map_err(|e| format!("写入失败：{e}"))
}

fn spawn_reader(
    stdout: tokio::process::ChildStdout,
    name: String,
    table: Arc<Mutex<HashMap<String, Arc<McpServer>>>>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(id) = message.get("id").and_then(Value::as_u64) else {
                continue; // 通知消息忽略
            };
            let Some(table_lock) = table.lock().ok() else { continue };
            let Some(server) = table_lock.get(&name) else { continue };
            if let Some(tx) = server.pending.lock().ok().and_then(|mut p| p.remove(&id)) {
                let result = match message.get("error") {
                    Some(err) => Err(format!("MCP 错误：{}", truncate_json(err))),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(result);
            }
        }
        // 进程退出：所有挂起请求报错，从表里摘除
        if let Ok(mut table_lock) = table.lock() {
            if let Some(server) = table_lock.remove(&name) {
                if let Ok(mut pending) = server.pending.lock() {
                    for (_, tx) in pending.drain() {
                        let _ = tx.send(Err("server 进程已退出".into()));
                    }
                }
            }
        }
    });
}

fn truncate_json(v: &Value) -> String {
    let text = v.to_string();
    if text.len() > 300 {
        format!("{}…", &text[..300])
    } else {
        text
    }
}

#[tauri::command]
pub async fn mcp_connect(name: String) -> Result<Vec<Value>, String> {
    let config = mcp_load_config();
    let Some(spec) = config.get("mcpServers").and_then(|s| s.get(&name)).cloned() else {
        return Err(format!("配置里没有叫「{name}」的 server"));
    };
    let command = spec
        .get("command")
        .and_then(Value::as_str)
        .ok_or("配置缺少 command")?
        .to_string();
    let args: Vec<String> = spec
        .get("args")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW
        cmd.creation_flags(0x0800_0000);
    }
    if let Some(env_obj) = spec.get("env").and_then(Value::as_object) {
        for (key, value) in env_obj {
            if let Some(v) = value.as_str() {
                cmd.env(key, v);
            }
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 {command} 失败：{e}"))?;
    let stdin = child.stdin.take().ok_or("拿不到 stdin")?;
    let stdout = child.stdout.take().ok_or("拿不到 stdout")?;

    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(line) = stdin_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    let server = Arc::new(McpServer {
        stdin_tx,
        tools: std::sync::RwLock::new(Vec::new()),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        process: Mutex::new(Some(child)),
    });

    // 先插表再启动 reader，否则 reader 拿到的是不含本 server 的旧表，
    // 响应会被静默丢弃导致 initialize 超时
    server_table()
        .lock()
        .map_err(|_| "锁损坏")?
        .insert(name.clone(), server.clone());
    let table = Arc::new(Mutex::new(
        server_table()
            .lock()
            .map_err(|_| "锁损坏")?
            .clone(),
    ));
    spawn_reader(stdout, name.clone(), table);

    // 握手：initialize → initialized 通知 → tools/list
    let init = server
        .request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "xiaozhou", "version": "0.1.0" }
            }),
        )
        .await?;
    let _ = init;
    let _ = server.stdin_tx.send(
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
    );

    let listing = server
        .request("tools/list", json!({}))
        .await
        .map_err(|e| format!("已连上但拉取工具列表失败：{e}"))?;
    let tools = listing
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Ok(entry) = server_table().lock() {
        if let Some(entry_server) = entry.get(&name) {
            if let Ok(mut tools_guard) = entry_server.tools.write() {
                *tools_guard = tools.clone();
            }
        }
    }

    Ok(tools)
}

#[tauri::command]
pub async fn mcp_disconnect(name: String) -> Result<(), String> {
    let server = server_table()
        .lock()
        .map_err(|_| "锁损坏")?
        .remove(&name);
    if let Some(server) = server {
        let mut child_opt = server
            .process
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        if let Some(mut child) = child_opt.take() {
            let _ = child.kill().await;
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

/// 给前端聚合所有已连接 server 的工具，转发给 LLM 用
#[tauri::command]
pub fn mcp_all_tools() -> Result<Vec<McpToolInfo>, String> {
    let table = server_table().lock().map_err(|_| "锁损坏")?;
    let mut out = Vec::new();
    for (server_name, server) in table.iter() {
        let Ok(tool_list) = server.tools.read() else { continue };
        for tool in tool_list.iter() {
            out.push(McpToolInfo {
                server: server_name.clone(),
                name: tool
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                input_schema: tool.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            });
        }
    }
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub name: String,
    pub connected: bool,
    pub tools: Vec<String>,
}

#[tauri::command]
pub fn mcp_status() -> Vec<McpStatus> {
    let table = match server_table().lock() {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    table
        .iter()
        .map(|(name, server)| McpStatus {
            name: name.clone(),
            connected: true,
            tools: server
                .tools
                .read()
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect()
}

#[tauri::command]
pub async fn mcp_call_tool(
    server: String,
    tool: String,
    args: Value,
) -> Result<super::tools::ToolOutcome, String> {
    let entry = {
        let table = server_table().lock().map_err(|_| "锁损坏")?;
        table.get(&server).cloned()
    };
    let Some(server_conn) = entry else {
        return Ok(super::tools::ToolOutcome::fail(format!(
            "MCP server「{server}」没有连接，先到设置里连接它"
        )));
    };

    let result = server_conn
        .request(
            "tools/call",
            json!({ "name": tool, "arguments": args }),
        )
        .await?;

    // MCP 工具结果：content 数组里的 text 片段拼接；isError 标记失败
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut text = String::new();
    if let Some(items) = result.get("content").and_then(Value::as_array) {
        for item in items {
            if item.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(t) = item.get("text").and_then(Value::as_str) {
                    text.push_str(t);
                    text.push('\n');
                }
            }
        }
    }
    if text.trim().is_empty() {
        text = truncate_json(&result);
    }
    Ok(if is_error {
        super::tools::ToolOutcome::fail(super::tools::clip(text, 12_000))
    } else {
        super::tools::ToolOutcome::ok(super::tools::clip(text, 12_000))
    })
}
