//! 命令执行的目录状态保持。
//!
//! Windows PowerShell 的交互 REPL 在管道 stdout 下会把输出写进 console API
//! （捕获不到），所以不能用交互会话。这里退而求其次做**目录保持**：
//! 记住上次执行后的工作目录，每条命令先 Set-Location 回去再执行，
//! 并从输出里解析新的目录。环境变量等其余状态不跨命令。

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

fn saved_cwd() -> &'static Mutex<Option<String>> {
    static CWD: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CWD.get_or_init(|| Mutex::new(None))
}

/// 执行一条命令；返回 (退出码, 输出, 是否被中断)
pub async fn run_with_cwd(
    root: &str,
    command: &str,
    timeout_secs: u64,
    cancel: Arc<AtomicBool>,
    sink: Option<tauri::ipc::Channel<crate::tools::ToolStreamEvent>>,
) -> (i32, String, bool) {
    let secs = timeout_secs.clamp(5, 300);
    let cwd = saved_cwd()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_else(|| root.replace('/', "\\"));

    let script = format!(
        "Set-Location -LiteralPath '{}'\n\
         {} \n\
         $xzCode = $LASTEXITCODE; if (-not $?) {{ $xzCode = 1 }}; if ($null -eq $xzCode) {{ $xzCode = 0 }}\n\
         Write-Output \"__XZ_CWD_$((Get-Location).Path)\"\n\
         Write-Output \"__XZ_END_$xzCode\"\n",
        cwd.replace('\'', "''"),
        command
    );

    let mut cmd = tokio::process::Command::new("powershell");
    cmd.arg("-NoProfile")
        .arg("-NoLogo")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(&script)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let started = std::time::Instant::now();
    let mut child = match cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(e) => return (1, format!("启动 PowerShell 失败：{e}"), false),
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // stdout / stderr 类型不同，各起一个 pump 汇到同一 channel
    fn pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
        stream: R,
        tx: tokio::sync::mpsc::UnboundedSender<String>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })
    }
    let mut readers = Vec::new();
    if let Some(stream) = stdout {
        readers.push(pump(stream, out_tx.clone()));
    }
    if let Some(stream) = stderr {
        readers.push(pump(stream, out_tx.clone()));
    }
    drop(out_tx);

    // 等待结束标记或超时
    let mut buffer = String::new();
    let mut new_cwd: Option<String> = None;
    let mut code: Option<i32> = None;
    let mut cancelled = false;
    let mut timed_out = false;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        match out_rx.try_recv() {
            Ok(line) => {
                if let Some(rest) = line.trim().strip_prefix("__XZ_CWD_") {
                    new_cwd = Some(rest.trim().to_string());
                    continue;
                }
                if let Some(rest) = line.trim().strip_prefix("__XZ_END_") {
                    code = rest.trim().parse::<i32>().ok();
                    // 结束标记之后可能还有残余输出，短暂再收一下
                    while let Ok(line) = out_rx.try_recv() {
                        if !line.trim().is_empty() {
                            buffer.push_str(&line);
                            buffer.push('\n');
                        }
                    }
                    break;
                }
                buffer.push_str(&line);
                buffer.push('\n');
                if let Some(sink) = &sink {
                    let _ = sink.send(crate::tools::ToolStreamEvent::Output { text: line });
                }
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
        }
    }

    if cancelled || timed_out {
        let _ = child.kill().await;
    }
    for reader in readers.drain(..) {
        let _ = reader.abort();
    }

    if let Some(path) = new_cwd {
        if let Ok(mut guard) = saved_cwd().lock() {
            *guard = Some(path);
        }
    }

    let mut text = String::new();
    if cancelled {
        text.push_str("已手动中断\n");
    } else if timed_out {
        text.push_str(&format!("命令超过 {secs}s 未结束，已强制终止\n"));
    } else {
        text.push_str(&format!("退出码 {}\n", code.unwrap_or(-1)));
    }
    let trimmed = buffer.trim_end();
    if trimmed.is_empty() {
        text.push_str("（无输出）\n");
    } else {
        text.push_str(trimmed);
        text.push('\n');
    }
    text.push_str("--- 工作目录跨命令保持（cd 有效）；环境变量如需保持请写在同一条命令里 ---\n");
    (if cancelled || timed_out { 1 } else { code.unwrap_or(-1) }, text, cancelled)
}

/// 供 tools.rs 调用的入口
pub async fn run_in_persistent_shell(
    root: &str,
    command: &str,
    timeout_secs: u64,
    cancel: Arc<AtomicBool>,
    sink: Option<tauri::ipc::Channel<crate::tools::ToolStreamEvent>>,
) -> (bool, String) {
    let (code, output, cancelled) = run_with_cwd(root, command, timeout_secs, cancel, sink).await;
    let _ = root;
    (code == 0 && !cancelled, output)
}
