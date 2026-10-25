use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_SEARCH_FILE_BYTES: u64 = 256 * 1024;
const MAX_OUTPUT_CHARS: usize = 12_000;

/// 搜索时跳过的目录，避免扫进依赖和构建产物
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    ".parcel-cache",
    ".svelte-kit",
    ".output",
    ".xiaozhou",
    "__pycache__",
    ".venv",
    "venv",
    "coverage",
    "cache",
    "cache_data",
    "code cache",
    "gpucache",
    "ebwebview",
    "crashpad",
];

const STATE_DIR: &str = ".xiaozhou";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    ok: bool,
    output: String,
}

/// 工具执行过程中的增量事件（目前只有命令输出）
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ToolStreamEvent {
    Output { text: String },
}

/// 正在运行的命令，用于中断
static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancel_table() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn cancel_tool(run_id: String) {
    if let Ok(table) = cancel_table().lock() {
        if let Some(flag) = table.get(&run_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

impl ToolOutcome {
    pub fn ok(output: impl Into<String>) -> Self {
        Self {
            ok: true,
            output: output.into(),
        }
    }
    pub fn fail(output: impl Into<String>) -> Self {
        Self {
            ok: false,
            output: output.into(),
        }
    }
}

pub fn clip(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}\n…（输出过长已截断，共 {} 字符）", s.chars().count())
}

pub fn home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "C:\\".to_string())
}

#[tauri::command]
pub fn default_workspace() -> String {
    home_dir()
}

/// 设置页用它判断用户填的目录是否有效
#[tauri::command]
pub fn dir_exists(path: String) -> bool {
    !path.trim().is_empty() && Path::new(path.trim()).is_dir()
}

/// 规范化路径；对不存在的路径，规范化它最近的已存在祖先再拼接。
fn canonical_ish(path: &Path) -> std::io::Result<PathBuf> {
    if path.exists() {
        return path.canonicalize();
    }
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "无效路径",
        )),
    };
    let base = canonical_ish(parent)?;
    Ok(match path.file_name() {
        Some(name) => base.join(name),
        None => base,
    })
}

fn root_of(root: &str) -> Result<PathBuf, String> {
    if root.trim().is_empty() {
        return Err("还没有设置工作目录".into());
    }
    let path = PathBuf::from(root);
    if !path.is_dir() {
        return Err(format!("工作目录不可用：{root}"));
    }
    path.canonicalize()
        .map_err(|e| format!("工作目录无法访问：{e}"))
}

/// 所有文件操作都收口在这里：解析出的绝对路径必须落在工作目录之内。
fn resolve(root: &str, raw: &str) -> Result<PathBuf, String> {
    let root_canon = root_of(root)?;
    let trimmed = raw.trim();
    let candidate = if trimmed.is_empty() || trimmed == "." || trimmed == "./" {
        root_canon.clone()
    } else if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        root_canon.join(trimmed)
    };

    let target = canonical_ish(&candidate).map_err(|e| format!("路径解析失败：{e}"))?;
    if !target.starts_with(&root_canon) {
        return Err(format!(
            "{} 不在工作目录 {} 之内，已拒绝",
            trimmed,
            pretty(&root_canon)
        ));
    }
    Ok(target)
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Windows 的 canonicalize 会带上 `\\?\` 前缀，显示给用户时去掉
fn pretty(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    text
}

/* ---------------- 改动快照与撤销 ---------------- */

#[derive(Serialize, Deserialize)]
struct ChangeRecord {
    ts: u64,
    /// 相对工作目录的路径
    path: String,
    /// 备份文件名，空表示改之前文件不存在
    backup: String,
    existed: bool,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn state_dir(root: &Path) -> PathBuf {
    root.join(STATE_DIR)
}

fn change_log(root: &Path) -> PathBuf {
    state_dir(root).join("changes.jsonl")
}

/// 改动前把原文件存一份，返回记录（失败则返回 None，不阻断主流程）
fn snapshot(root: &Path, path: &Path) -> Option<ChangeRecord> {
    let rel = path.strip_prefix(root).ok()?.to_string_lossy().to_string();
    let ts = now_millis();

    if !path.exists() {
        return Some(ChangeRecord {
            ts,
            path: rel,
            backup: String::new(),
            existed: false,
        });
    }

    let dir = state_dir(root).join("backups");
    std::fs::create_dir_all(&dir).ok()?;
    let name = format!("{ts}.bak");
    std::fs::copy(path, dir.join(&name)).ok()?;
    Some(ChangeRecord {
        ts,
        path: rel,
        backup: name,
        existed: true,
    })
}

fn record_change(root: &Path, record: &ChangeRecord) {
    let log = change_log(root);
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(record) {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn tool_undo_last(root: &str) -> Result<ToolOutcome, String> {
    let root_canon = root_of(root)?;
    let log = change_log(&root_canon);
    let text = std::fs::read_to_string(&log).unwrap_or_default();
    let mut lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let last = match lines.pop() {
        Some(line) => line,
        None => return Ok(ToolOutcome::fail("没有可撤销的改动了")),
    };
    let record: ChangeRecord =
        serde_json::from_str(last).map_err(|e| format!("撤销记录损坏：{e}"))?;

    let target = root_canon.join(&record.path);
    if record.existed {
        let backup = state_dir(&root_canon).join("backups").join(&record.backup);
        if !backup.is_file() {
            return Ok(ToolOutcome::fail(format!(
                "找不到 {} 的备份文件，无法撤销",
                record.path
            )));
        }
        std::fs::copy(&backup, &target).map_err(|e| format!("恢复失败：{e}"))?;
    } else if target.is_file() {
        std::fs::remove_file(&target).map_err(|e| format!("删除失败：{e}"))?;
    }

    // 去掉已消费的记录，再撤销时不会重复作用于同一处
    let rest = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    let _ = std::fs::write(&log, rest);

    let remaining = change_log(&root_canon)
        .exists()
        .then(|| std::fs::read_to_string(change_log(&root_canon)).unwrap_or_default())
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0);

    Ok(ToolOutcome::ok(format!(
        "已撤销对 {} 的改动（{}）。还可撤销 {} 步",
        record.path,
        if record.existed { "恢复原内容" } else { "删除新建的文件" },
        remaining
    )))
}

/* ---------------- 危险命令 ---------------- */

fn dangerous_reason(command: &str) -> Option<String> {
    let lower = command.to_lowercase();
    let rules: &[(&str, &str)] = &[
        (r"rm\s+-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(/|~|\*|[a-z]:[\\/]?\s*$)", "递归删除根目录"),
        (r"\bformat\s+[a-z]:", "格式化磁盘"),
        (r"\bdiskpart\b", "磁盘分区操作"),
        (r"\bmkfs(\.|\b)", "格式化文件系统"),
        (r#"remove-item[^\n]*-recurse[^\n]*-force[^\n]*['"]?[a-z]:[\\/]?['"]?\s*$"#, "递归强删磁盘根目录"),
        (r"\bshutdown\b", "关机或重启"),
        (r"\bbcdedit\b", "修改启动配置"),
        (r"del\s+/[sf][^\n]*[a-z]:[\\/]?\s*$", "批量删除磁盘根目录"),
        (r"\brd\s+/s\b", "递归删除目录"),
        (r"reg\s+delete\s+hklm", "删除系统注册表项"),
    ];
    for (pattern, reason) in rules {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(&lower) {
                return Some((*reason).to_string());
            }
        }
    }
    None
}

/* ---------------- 工具实现 ---------------- */

fn tool_list_dir(root: &str, args: &Value) -> Result<ToolOutcome, String> {
    let rel = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let dir = resolve(root, rel)?;
    if !dir.is_dir() {
        return Ok(ToolOutcome::fail(format!(
            "{} 不是目录",
            pretty(&dir)
        )));
    }

    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    let reader = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败：{e}"))?;
    for item in reader.flatten() {
        let meta = item.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let name = item.file_name().to_string_lossy().to_string();
        entries.push((is_dir, name, size));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));

    if entries.is_empty() {
        return Ok(ToolOutcome::ok(format!("{} 是空目录", pretty(&dir))));
    }

    let mut out = format!("{}（{} 项）\n", pretty(&dir), entries.len());
    for (is_dir, name, size) in entries.iter().take(300) {
        if *is_dir {
            out.push_str(&format!("  [目录] {name}/\n"));
        } else {
            out.push_str(&format!("  [文件] {name}  {}\n", human_size(*size)));
        }
    }
    if entries.len() > 300 {
        out.push_str(&format!("  …还有 {} 项未列出\n", entries.len() - 300));
    }
    Ok(ToolOutcome::ok(out))
}

fn tool_read_file(root: &str, args: &Value) -> Result<ToolOutcome, String> {
    let rel = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("缺少 path 参数")?;
    let path = resolve(root, rel)?;
    if !path.is_file() {
        return Ok(ToolOutcome::fail(format!("{} 不存在或不是文件", pretty(&path))));
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取信息失败：{e}"))?;
    if meta.len() > MAX_READ_BYTES {
        return Ok(ToolOutcome::fail(format!(
            "{} 太大（{}），超过 512KB 单次读取上限",
            pretty(&path),
            human_size(meta.len())
        )));
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let total = text.lines().count();
    let offset = args
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(400)
        .clamp(1, 4000) as usize;

    let start = (offset - 1).min(total);
    let end = (start + limit).min(total);

    let mut out = format!(
        "{}（共 {} 行，显示 {}-{}）\n",
        pretty(&path),
        total,
        start + 1,
        end
    );
    for (i, line) in text.lines().skip(start).take(end - start).enumerate() {
        out.push_str(&format!("{:>5} | {}\n", start + i + 1, line));
    }
    Ok(ToolOutcome::ok(clip(out, MAX_OUTPUT_CHARS)))
}

fn tool_write_file(root: &str, args: &Value) -> Result<ToolOutcome, String> {
    let rel = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("缺少 path 参数")?;
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .ok_or("缺少 content 参数")?;
    let path = resolve(root, rel)?;
    if path.is_dir() {
        return Ok(ToolOutcome::fail(format!("{} 是个目录", pretty(&path))));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let root_canon = root_of(root)?;
    if let Some(record) = snapshot(&root_canon, &path) {
        record_change(&root_canon, &record);
    }
    let existed = path.exists();
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("写入失败：{e}"))?;
    Ok(ToolOutcome::ok(format!(
        "{} {}（{} 字符）{}",
        if existed { "已覆盖" } else { "已新建" },
        pretty(&path),
        content.chars().count(),
        if existed { "，可用 undo_last 撤销" } else { "" }
    )))
}

fn tool_edit_file(root: &str, args: &Value) -> Result<ToolOutcome, String> {
    let rel = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("缺少 path 参数")?;
    let old_text = args
        .get("old_text")
        .and_then(Value::as_str)
        .ok_or("缺少 old_text 参数")?;
    let new_text = args
        .get("new_text")
        .and_then(Value::as_str)
        .ok_or("缺少 new_text 参数")?;

    if old_text.is_empty() {
        return Ok(ToolOutcome::fail(
            "old_text 不能为空。整文件重写请用 write_file",
        ));
    }

    let path = resolve(root, rel)?;
    if !path.is_file() {
        return Ok(ToolOutcome::fail(format!("{} 不存在", pretty(&path))));
    }

    let original = std::fs::read_to_string(&path).map_err(|e| format!("读取失败：{e}"))?;
    let count = original.matches(old_text).count();
    if count == 0 {
        return Ok(ToolOutcome::fail(format!(
            "在 {} 里没找到要替换的内容。请先用 read_file 确认原文（注意缩进和空格要完全一致）",
            pretty(&path)
        )));
    }
    if count > 1 {
        return Ok(ToolOutcome::fail(format!(
            "这段内容在文件里出现了 {count} 次，无法确定改哪一处。请带上更多上下文让它唯一",
        )));
    }

    let start_byte = original.find(old_text).unwrap_or(0);
    let start_line = original[..start_byte].lines().count() + 1;
    let removed = old_text.lines().count();
    let added = new_text.lines().count();

    let updated = original.replacen(old_text, new_text, 1);
    let root_canon = root_of(root)?;
    if let Some(record) = snapshot(&root_canon, &path) {
        record_change(&root_canon, &record);
    }
    std::fs::write(&path, updated.as_bytes()).map_err(|e| format!("写入失败：{e}"))?;

    Ok(ToolOutcome::ok(format!(
        "已修改 {}（第 {} 行起，删除 {} 行、新增 {} 行）。可用 undo_last 撤销",
        pretty(&path),
        start_line,
        removed,
        added
    )))
}

/// 自己实现的目录遍历，跳过依赖和构建产物
fn walk_files(base: &Path, limit: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= limit {
            break;
        }
        let Ok(reader) = std::fs::read_dir(&dir) else {
            continue;
        };
        for item in reader.flatten() {
            let path = item.path();
            let Ok(meta) = item.metadata() else {
                continue;
            };
            if meta.is_dir() {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
            } else if meta.is_file() {
                out.push(path);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    out
}

fn glob_to_regex(pattern: &str) -> String {
    let mut out = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    out.push_str(".*");
                    i += 1;
                    if i + 1 < chars.len() && (chars[i + 1] == '/' || chars[i + 1] == '\\') {
                        i += 1;
                    }
                } else {
                    out.push_str("[^/\\\\]*");
                }
            }
            '?' => out.push_str("[^/\\\\]"),
            '.' => out.push_str("\\."),
            '/' | '\\' => out.push_str("[/\\\\]"),
            c if "()[]{}+^$|".contains(c) => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
        i += 1;
    }
    out.push('$');
    out
}

fn tool_glob(root: &str, args: &Value) -> Result<ToolOutcome, String> {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or("缺少 pattern 参数")?
        .trim();
    if pattern.is_empty() {
        return Ok(ToolOutcome::fail("pattern 不能为空"));
    }
    let rel = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let base = resolve(root, rel)?;
    let root_canon = root_of(root)?;
    let limit = args
        .get("max_results")
        .and_then(Value::as_u64)
        .unwrap_or(80)
        .clamp(1, 500) as usize;

    let re = Regex::new(&glob_to_regex(pattern)).map_err(|e| format!("模式无效：{e}"))?;
    let files = walk_files(&base, 20_000);

    let mut hits: Vec<String> = Vec::new();
    for file in files {
        let rel_path = file
            .strip_prefix(&root_canon)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        if re.is_match(&rel_path) {
            hits.push(rel_path);
            if hits.len() >= limit {
                break;
            }
        }
    }

    if hits.is_empty() {
        return Ok(ToolOutcome::ok(format!(
            "没有匹配 {pattern} 的文件（已跳过依赖和构建目录）"
        )));
    }
    let mut out = format!("匹配 {pattern} 的文件（{} 个）：\n", hits.len());
    for hit in &hits {
        out.push_str(&format!("  {hit}\n"));
    }
    Ok(ToolOutcome::ok(clip(out, MAX_OUTPUT_CHARS)))
}

fn tool_search_text(root: &str, args: &Value) -> Result<ToolOutcome, String> {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or("缺少 pattern 参数")?
        .trim();
    if pattern.is_empty() {
        return Ok(ToolOutcome::fail("pattern 不能为空"));
    }
    let rel = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let glob = args
        .get("glob")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let max = args
        .get("max_results")
        .and_then(Value::as_u64)
        .unwrap_or(60)
        .clamp(1, 300) as usize;

    let base = resolve(root, rel)?;
    let root_canon = root_of(root)?;

    // 先按正则解析，不行就当纯文本
    let re = Regex::new(pattern)
        .or_else(|_| Regex::new(&regex::escape(pattern)))
        .map_err(|e| format!("搜索模式无效：{e}"))?;
    let file_filter = match glob {
        Some(g) => Some(Regex::new(&glob_to_regex(g)).map_err(|e| format!("glob 无效：{e}"))?),
        None => None,
    };

    let files = walk_files(&base, 20_000);
    let mut hits: Vec<String> = Vec::new();
    let mut scanned = 0usize;

    for file in files {
        if hits.len() >= max {
            break;
        }
        let rel_path = file
            .strip_prefix(&root_canon)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        if let Some(filter) = &file_filter {
            if !filter.is_match(&rel_path) {
                continue;
            }
        }
        let Ok(meta) = file.metadata() else { continue };
        if meta.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        // 跳过二进制文件
        if bytes.iter().take(2048).any(|b| *b == 0) {
            continue;
        }
        scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        for (index, line) in text.lines().enumerate() {
            if re.is_match(line) {
                let trimmed = line.trim();
                let shown = if trimmed.chars().count() > 160 {
                    format!("{}…", trimmed.chars().take(160).collect::<String>())
                } else {
                    trimmed.to_string()
                };
                hits.push(format!("{}:{}: {}", rel_path, index + 1, shown));
                if hits.len() >= max {
                    break;
                }
            }
        }
    }

    if hits.is_empty() {
        return Ok(ToolOutcome::ok(format!(
            "没搜到匹配 {pattern} 的内容（扫描了 {scanned} 个文件）"
        )));
    }

    let mut out = format!(
        "匹配 {pattern} 的位置（{} 条，扫描 {} 个文件）：\n",
        hits.len(),
        scanned
    );
    for hit in &hits {
        out.push_str(hit);
        out.push('\n');
    }
    if hits.len() >= max {
        out.push_str(&format!("…已达 {max} 条上限，可以加 glob 或换更精确的 pattern\n"));
    }
    Ok(ToolOutcome::ok(clip(out, MAX_OUTPUT_CHARS)))
}

/// 把子进程的一个输出流逐行读出来，边读边推给前端
fn spawn_reader<R>(
    reader: R,
    channel: Channel<ToolStreamEvent>,
    cancel: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<String>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        let mut buffer = String::new();
        loop {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            match lines.next_line().await {
                Ok(Some(line)) => {
                    buffer.push_str(&line);
                    buffer.push('\n');
                    let _ = channel.send(ToolStreamEvent::Output { text: line });
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
        buffer
    })
}

async fn tool_run_command(
    root: &str,
    args: &Value,
    on_event: &Channel<ToolStreamEvent>,
) -> Result<ToolOutcome, String> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or("缺少 command 参数")?
        .trim()
        .to_string();
    if command.is_empty() {
        return Ok(ToolOutcome::fail("命令为空"));
    }
    if let Some(reason) = dangerous_reason(&command) {
        return Ok(ToolOutcome::fail(format!(
            "这条命令被拦下了：{reason}。这类操作不可逆，如需执行请用户自己在终端里运行"
        )));
    }
    let cwd = resolve(root, ".")?;
    let secs = args
        .get("timeout_sec")
        .and_then(Value::as_u64)
        .unwrap_or(60)
        .clamp(5, 300);

    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("powershell");
        c.arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-Command")
            // 先切 UTF-8，否则中文输出全是乱码
            .arg(format!(
                "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Continue'; {command}"
            ));
        c
    } else {
        let mut c = tokio::process::Command::new("bash");
        c.arg("-lc").arg(&command);
        c
    };

    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：避免弹黑框
        cmd.creation_flags(0x0800_0000);
    }

    let run_id = args.get("run_id").and_then(Value::as_str).unwrap_or("").to_string();
    let flag = Arc::new(AtomicBool::new(false));
    if !run_id.is_empty() {
        if let Ok(mut table) = cancel_table().lock() {
            table.insert(run_id.clone(), flag.clone());
        }
    }

    let started = std::time::Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("命令启动失败：{e}"))?;
    let out_handle = child
        .stdout
        .take()
        .map(|s| spawn_reader(s, on_event.clone(), flag.clone()));
    let err_handle = child
        .stderr
        .take()
        .map(|s| spawn_reader(s, on_event.clone(), flag.clone()));

    let mut cancelled = false;
    let mut timed_out = false;
    let mut exit_code: Option<i32> = None;

    loop {
        if flag.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            cancelled = true;
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = Some(status.code().unwrap_or(-1));
                break;
            }
            Ok(None) => {
                if started.elapsed() > Duration::from_secs(secs) {
                    let _ = child.kill().await;
                    timed_out = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            Err(e) => return Ok(ToolOutcome::fail(format!("等待命令失败：{e}"))),
        }
    }

    let stdout = match out_handle {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    };
    let stderr = match err_handle {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    };

    if !run_id.is_empty() {
        if let Ok(mut table) = cancel_table().lock() {
            table.remove(&run_id);
        }
    }

    if timed_out {
        return Ok(ToolOutcome::fail(format!(
            "命令超过 {secs}s 未结束，已强制终止"
        )));
    }

    let elapsed = started.elapsed().as_secs_f64();
    let mut text = String::new();
    if cancelled {
        text.push_str(&format!("已手动中断，耗时 {elapsed:.1}s\n"));
    } else {
        text.push_str(&format!("退出码 {}，耗时 {elapsed:.1}s\n", exit_code.unwrap_or(-1)));
    }
    let out_trim = stdout.trim_end();
    let err_trim = stderr.trim_end();
    if !out_trim.is_empty() {
        text.push_str("--- 标准输出 ---\n");
        text.push_str(out_trim);
        text.push('\n');
    }
    if !err_trim.is_empty() {
        text.push_str("--- 错误输出 ---\n");
        text.push_str(err_trim);
        text.push('\n');
    }
    if out_trim.is_empty() && err_trim.is_empty() {
        text.push_str("（无输出）\n");
    }

    Ok(ToolOutcome {
        ok: !cancelled && exit_code == Some(0),
        output: clip(text, MAX_OUTPUT_CHARS),
    })
}

/// 读取工作目录下的项目约定文件，注入到 system prompt
#[tauri::command]
pub fn project_guide(root: String) -> Option<String> {
    let root_canon = root_of(&root).ok()?;
    for name in ["AGENTS.md", "CLAUDE.md", ".cursorrules"] {
        let path = root_canon.join(name);
        if let Ok(text) = std::fs::read_to_string(&path) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(clip(trimmed.to_string(), 6_000));
            }
        }
    }
    None
}

#[tauri::command]
pub async fn run_tool(
    name: String,
    args: Value,
    root: String,
    on_event: Channel<ToolStreamEvent>,
) -> Result<ToolOutcome, String> {
    let started = std::time::Instant::now();
    let outcome = match name.as_str() {
        "list_dir" => tool_list_dir(&root, &args),
        "read_file" => tool_read_file(&root, &args),
        "write_file" => tool_write_file(&root, &args),
        "edit_file" => tool_edit_file(&root, &args),
        "search_text" => tool_search_text(&root, &args),
        "glob" => tool_glob(&root, &args),
        "undo_last" => tool_undo_last(&root),
        "use_skill" => tool_use_skill(&root, &args),
        "memory" => tool_memory(&root, &args),
        "run_command" => tool_run_command(&root, &args, &on_event).await,
        other => Ok(ToolOutcome::fail(format!("未知工具：{other}"))),
    };
    let final_outcome = match outcome {
        Ok(value) => value,
        Err(message) => ToolOutcome::fail(message),
    };
    audit_log(
        &root,
        &name,
        &args,
        &final_outcome,
        started.elapsed().as_millis() as u64,
    );
    Ok(final_outcome)
}

/* ---------------- 会话落盘 / 审计 / 预览 / 文件引用 ---------------- */

/// 应用数据目录：%APPDATA%/xiaozhou，会话和审计都放这里
pub fn app_data_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(home_dir()));
    base.join("xiaozhou")
}

#[tauri::command]
pub fn load_sessions() -> Result<Value, String> {
    let path = app_data_dir().join("sessions.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("会话文件损坏：{e}")),
        Err(_) if !path.exists() => Ok(json!({ "sessions": [], "activeId": null })),
        Err(e) => Err(format!("读取会话失败：{e}")),
    }
}

#[tauri::command]
pub fn save_sessions(sessions: Value, active_id: Option<String>) -> Result<(), String> {
    let dir = app_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;

    let body = json!({
        "version": 1,
        "savedAt": now_millis(),
        "activeId": active_id,
        "sessions": sessions,
    });
    let text = body.to_string();
    if text.len() > 96 * 1024 * 1024 {
        return Err("会话数据太大（超过 96MB），删掉一些旧对话或大图片再试".into());
    }

    // 原子写：先写临时文件再改名，断电也不会损坏现有数据
    let tmp = dir.join("sessions.json.tmp");
    std::fs::write(&tmp, &text).map_err(|e| format!("写入会话失败：{e}"))?;
    std::fs::rename(&tmp, dir.join("sessions.json"))
        .map_err(|e| format!("保存会话失败：{e}"))?;
    Ok(())
}

/// 工具调用的审计日志：谁在什么时候让 agent 动了什么
fn audit_log(root: &str, tool: &str, args: &Value, outcome: &ToolOutcome, elapsed_ms: u64) {
    let dir = app_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("audit.jsonl");

    // 超过 5MB 轮转成 .1，避免无限膨胀
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5_000_000 {
            let _ = std::fs::rename(&path, dir.join("audit.jsonl.1"));
        }
    }

    let record = json!({
        "ts": now_millis(),
        "tool": tool,
        "root": root,
        "args": clip(args.to_string(), 2000),
        "ok": outcome.ok,
        "elapsedMs": elapsed_ms,
        "output": clip(outcome.output.clone(), 600),
    });
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{record}");
    }
}

/// 读取 @ 引用的文件原文（给模型看的，不带行号），超长截断
#[tauri::command]
pub fn read_reference(root: String, path: String) -> Result<String, String> {
    let target = resolve(&root, &path)?;
    if !target.is_file() {
        return Err(format!("{} 不是文件", pretty(&target)));
    }
    let meta = std::fs::metadata(&target).map_err(|e| format!("读取失败：{e}"))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "{} 超过 {}，太大了",
            pretty(&target),
            human_size(MAX_READ_BYTES)
        ));
    }
    let bytes = std::fs::read(&target).map_err(|e| format!("读取失败：{e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(clip(text.trim_end().to_string(), 12_000))
}

/// @ 引用弹层用的文件搜索：按名字包含匹配，返回相对路径
#[tauri::command]
pub fn list_files(root: String, query: String) -> Result<Vec<String>, String> {
    let root_canon = root_of(&root)?;
    let needle = query.to_lowercase();

    let mut matches: Vec<String> = walk_files(&root_canon, 4000)
        .into_iter()
        .filter_map(|path| {
            let rel = path.strip_prefix(&root_canon).ok()?;
            let text = rel.to_string_lossy().replace('\\', "/");
            if needle.is_empty() || text.to_lowercase().contains(&needle) {
                Some(text)
            } else {
                None
            }
        })
        .collect();

    // 浅层优先、同层按名字排，最像「项目里的文件」的排前面
    matches.sort_by_key(|rel| (rel.matches('/').count(), rel.to_lowercase()));
    matches.truncate(300);
    Ok(matches)
}

/// diff 预览：算出改前/改后的完整内容，前端渲染成红绿对比
#[tauri::command]
pub fn preview_change(
    root: String,
    kind: String,
    path: String,
    content: Option<String>,
    old_text: Option<String>,
    new_text: Option<String>,
) -> Result<Value, String> {
    let target = resolve(&root, &path)?;

    let old_content = if target.exists() {
        let bytes = std::fs::read(&target).map_err(|e| format!("读取失败：{e}"))?;
        String::from_utf8_lossy(&bytes).to_string()
    } else {
        String::new()
    };

    let new_content = match kind.as_str() {
        "write" => content.unwrap_or_default(),
        "edit" => {
            let old_text = old_text.unwrap_or_default();
            let new_text = new_text.unwrap_or_default();
            if old_text.is_empty() {
                return Err("old_text 不能为空".into());
            }
            if !old_content.contains(&old_text) {
                return Err("old_text 在文件里不存在，先让模型重新 read_file".into());
            }
            old_content.replacen(&old_text, &new_text, 1)
        }
        other => return Err(format!("未知的改动类型：{other}")),
    };

    Ok(json!({
        "path": pretty(&target),
        "exists": target.exists(),
        "oldContent": old_content,
        "newContent": new_content,
    }))
}

/* ---------------- 技能（skill） ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    name: String,
    description: String,
    /// user = 用户级（%APPDATA%），project = 项目级（工作目录）
    source: String,
}

/// 解析技能文件的 frontmatter。必须按行处理——中文字符不能按字节切片，
/// 否则切到多字节字符中间会直接 panic。
fn split_front_matter(text: &str) -> (String, String, String) {
    let trimmed = text.trim();
    let lines: Vec<&str> = trimmed.lines().collect();

    let is_dashes = |line: &str| line.trim() == "---";
    if lines.first().map(|l| is_dashes(l)).unwrap_or(false) {
        if let Some(end_idx) = lines.iter().skip(1).position(|l| is_dashes(l)) {
            let mut name = String::new();
            let mut description = String::new();
            for line in lines.iter().take(end_idx + 1).skip(1) {
                let line = line.trim();
                if let Some(value) = line.strip_prefix("name:") {
                    name = value.trim().to_string();
                } else if let Some(value) = line.strip_prefix("description:") {
                    description = value.trim().to_string();
                }
            }
            let body = if end_idx + 2 <= lines.len() {
                lines[end_idx + 2..].join("\n").trim().to_string()
            } else {
                String::new()
            };
            return (name, description, body);
        }
    }

    (String::new(), String::new(), trimmed.to_string())
}

fn parse_skill_file(path: &Path, source: &str, fallback_name: &str) -> Option<SkillInfo> {
    let text = std::fs::read_to_string(path).ok()?;
    let (meta_name, description, body) = split_front_matter(&text);
    if body.is_empty() {
        return None;
    }
    let name = if meta_name.is_empty() {
        fallback_name.to_string()
    } else {
        meta_name
    };
    Some(SkillInfo {
        name,
        description,
        source: source.to_string(),
    })
}

/// 扫描用户级与项目级技能目录。项目级优先，同名时覆盖用户级。
fn scan_skills(root: &str) -> Result<Vec<SkillInfo>, String> {
    let mut out: Vec<SkillInfo> = Vec::new();

    let mut dirs: Vec<(PathBuf, &str)> = Vec::new();
    dirs.push((app_data_dir().join("skills"), "user"));
    if let Ok(root_canon) = root_of(root) {
        dirs.push((root_canon.join(STATE_DIR).join("skills"), "project"));
    }

    for (dir, source) in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let skill_file = path.join("SKILL.md");
                if skill_file.is_file() {
                    let name = path.file_name().map(|n| n.to_string_lossy().to_string());
                    if let Some(skill) =
                        parse_skill_file(&skill_file, source, &name.unwrap_or_default())
                    {
                        out.push(skill);
                    }
                }
            } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                let stem = path
                    .file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                if let Some(skill) = parse_skill_file(&path, source, &stem) {
                    out.push(skill);
                }
            }
        }
    }

    // 项目级排在前面；同名时去掉用户级的
    out.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.cmp(&b.name)));
    out.dedup_by(|a, b| a.name == b.name);
    Ok(out)
}

/// 系统提示里要列出的技能清单
#[tauri::command]
pub fn list_skills(root: String) -> Result<Vec<SkillInfo>, String> {
    scan_skills(&root)
}

fn tool_use_skill(root: &str, args: &Value) -> Result<ToolOutcome, String> {
    let wanted = args
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if wanted.is_empty() {
        return Ok(ToolOutcome::fail("缺少 name 参数"));
    }
    let skills = scan_skills(root)?;
    let exists = skills.iter().any(|skill| skill.name == wanted);
    if !exists {
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        return Ok(ToolOutcome::fail(format!(
            "没有叫「{wanted}」的技能。可用的有：{}",
            if names.is_empty() {
                "（一个都没有）".to_string()
            } else {
                names.join("、")
            }
        )));
    }

    // 重新读一遍文件拿正文
    let dirs = [
        root_of(root).ok().map(|r| r.join(STATE_DIR).join("skills")),
        Some(app_data_dir().join("skills")),
    ];
    for dir in dirs.into_iter().flatten() {
        for candidate in [
            dir.join(format!("{wanted}.md")),
            dir.join(wanted).join("SKILL.md"),
        ] {
            if candidate.is_file() {
                if let Ok(text) = std::fs::read_to_string(&candidate) {
                    let (_, _, body) = split_front_matter(&text);
                    if !body.is_empty() {
                        return Ok(ToolOutcome::ok(format!(
                            "技能「{wanted}」的指令如下，请严格按照这些要求完成任务：\n\n{body}"
                        )));
                    }
                }
            }
        }
    }

    Ok(ToolOutcome::fail(format!("技能「{wanted}」的文件读不到，可能已被删除")))
}

/* ---------------- 定时任务存储 / 会话导出 ---------------- */

#[tauri::command]
pub fn load_schedules() -> Result<Value, String> {
    let path = app_data_dir().join("schedules.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("定时任务文件损坏：{e}")),
        Err(_) if !path.exists() => Ok(json!({ "schedules": [] })),
        Err(e) => Err(format!("读取定时任务失败：{e}")),
    }
}

#[tauri::command]
pub fn save_schedules(schedules: Value) -> Result<(), String> {
    let dir = app_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let body = json!({ "version": 1, "savedAt": now_millis(), "schedules": schedules });
    let tmp = dir.join("schedules.json.tmp");
    std::fs::write(&tmp, body.to_string()).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, dir.join("schedules.json")).map_err(|e| format!("保存失败：{e}"))?;
    Ok(())
}

/// 把导出的 Markdown 写到用户选定的地方
#[tauri::command]
pub fn write_export(path: String, content: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("路径为空".into());
    }
    std::fs::write(&path, content).map_err(|e| format!("写入失败：{e}"))?;
    Ok(path)
}


/* ---------------- 检查更新 ---------------- */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    latest: String,
    has_update: bool,
    url: String,
    notes: String,
}

fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split('.')
            .map(|part| part.split('-').next().unwrap_or("0").parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(a), parse(b));
    for i in 0..3 {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        if av != bv {
            return av > bv;
        }
    }
    false
}

/// 查 GitHub 最新 Release，跟当前版本比对
#[tauri::command]
pub async fn check_update() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;
    let resp = client
        .get("https://api.github.com/repos/hope023/XiaoZhou/releases/latest")
        .header("User-Agent", "xiaozhou-desktop")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("访问 GitHub 失败：{e}"))?;
    if resp.status().as_u16() == 404 {
        return Err("仓库还没有发布过 Release，发布 v0.1.0 之后就能检测了".into());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub 返回 {}", resp.status().as_u16()));
    }
    let value: Value = resp.json().await.map_err(|e| format!("解析失败：{e}"))?;
    let latest = value
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let current = env!("CARGO_PKG_VERSION").to_string();
    Ok(UpdateInfo {
        has_update: version_gt(&latest, &current) && !latest.is_empty(),
        url: value
            .get("html_url")
            .and_then(Value::as_str)
            .unwrap_or("https://github.com/hope023/XiaoZhou/releases")
            .to_string(),
        notes: value
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(500)
            .collect(),
        current,
        latest,
    })
}


/* ---------------- 长期记忆（zcode 式） ---------------- */

/// 用户级：%APPDATA%/xiaozhou/memory.md；项目级：<workspace>/.xiaozhou/memory.md
fn memory_path(root: &str, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "user" => Ok(app_data_dir().join("memory.md")),
        _ => Ok(root_of(root)?.join(STATE_DIR).join("memory.md")),
    }
}

/// 给 system prompt 用的两段记忆原文
#[tauri::command]
pub fn memory_read(root: String) -> Value {
    let user = std::fs::read_to_string(app_data_dir().join("memory.md"))
        .unwrap_or_default();
    let project = root_of(&root)
        .ok()
        .and_then(|r| std::fs::read_to_string(r.join(STATE_DIR).join("memory.md")).ok())
        .unwrap_or_default();
    json!({
        "user": clip(user.trim().to_string(), 4_000),
        "project": clip(project.trim().to_string(), 4_000),
    })
}

fn tool_memory(root: &str, args: &Value) -> Result<ToolOutcome, String> {
    let action = args.get("action").and_then(Value::as_str).unwrap_or("list");
    let scope = args.get("scope").and_then(Value::as_str).unwrap_or("project");
    if !matches!(scope, "user" | "project") {
        return Ok(ToolOutcome::fail("scope 只能是 user 或 project"));
    }
    let path = memory_path(root, scope)?;
    let label = if scope == "user" { "用户级" } else { "项目级" };

    match action {
        "add" => {
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if content.is_empty() {
                return Ok(ToolOutcome::fail("content 不能为空"));
            }
            if content.contains('\n') {
                return Ok(ToolOutcome::fail(
                    "一次只记一条，content 里不要换行；多条分多次调用",
                ));
            }
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let existing = std::fs::read_to_string(&path).unwrap_or_default();
            let duplicated = existing.lines().any(|line| line.trim_end() == format!("- {content}").trim_end());
            if duplicated {
                return Ok(ToolOutcome::ok(format!("{label}记忆里已经有这条了：{content}")));
            }
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("写入记忆失败：{e}"))?;
            writeln!(file, "- {content}").map_err(|e| format!("写入记忆失败：{e}"))?;
            Ok(ToolOutcome::ok(format!("已存入{label}记忆：{content}")))
        }
        "list" => {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Ok(ToolOutcome::ok(format!("{label}记忆目前是空的")))
            } else {
                Ok(ToolOutcome::ok(format!(
                    "{label}记忆（共 {} 条）：\n{}",
                    trimmed.lines().count(),
                    clip(trimmed.to_string(), 4_000)
                )))
            }
        }
        "remove" => {
            let keyword = args
                .get("keyword")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if keyword.is_empty() {
                return Ok(ToolOutcome::fail("remove 需要提供 keyword（匹配要删的行）"));
            }
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let (kept, removed): (Vec<&str>, Vec<&str>) = text
                .lines()
                .partition(|line| !line.contains(keyword));
            if removed.is_empty() {
                return Ok(ToolOutcome::fail(format!(
                    "{label}记忆里没有包含「{keyword}」的条目"
                )));
            }
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&path, kept.join("\n") + "\n").map_err(|e| format!("写入失败：{e}"))?;
            let preview: Vec<String> = removed
                .iter()
                .map(|l| l.trim_start_matches("- ").to_string())
                .collect();
            Ok(ToolOutcome::ok(format!(
                "已从{label}记忆删除 {} 条：{}",
                removed.len(),
                preview.join("；")
            )))
        }
        "clear" => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&path, "").map_err(|e| format!("清空失败：{e}"))?;
            Ok(ToolOutcome::ok(format!("{label}记忆已清空")))
        }
        other => Ok(ToolOutcome::fail(format!(
            "未知 action：{other}（可用 add / list / remove / clear）"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_patterns_work() {
        let re = Regex::new(&glob_to_regex("**/*.tsx")).unwrap();
        assert!(re.is_match("src/App.tsx"));
        assert!(re.is_match("App.tsx"));
        assert!(!re.is_match("src/App.ts"));

        let re2 = Regex::new(&glob_to_regex("src/*.ts")).unwrap();
        assert!(re2.is_match("src/a.ts"));
        assert!(!re2.is_match("src/sub/a.ts"));
    }

    #[test]
    fn dangerous_commands_are_blocked() {
        assert!(dangerous_reason("rm -rf /").is_some());
        assert!(dangerous_reason("rm -rf C:").is_some());
        assert!(dangerous_reason("format c:").is_some());
        assert!(dangerous_reason("diskpart").is_some());
        assert!(dangerous_reason("shutdown /s /t 0").is_some());
        assert!(dangerous_reason("git status").is_none());
        assert!(dangerous_reason("npm run build").is_none());
        assert!(dangerous_reason("rm -rf node_modules").is_none());
    }
}

#[cfg(test)]
mod skill_tests {
    use super::*;

    #[test]
    fn frontmatter_with_chinese_parses_safely() {
        let text = "---\nname: translate\ndescription: 把中文内容翻译成地道英文，保持原格式\n---\n你是翻译专家。把用户给出的中文内容翻译。";
        let (name, desc, body) = split_front_matter(text);
        assert_eq!(name, "translate");
        assert_eq!(desc, "把中文内容翻译成地道英文，保持原格式");
        assert!(body.starts_with("你是翻译专家"));
        assert!(body.contains("翻译。"));
    }

    #[test]
    fn no_frontmatter_returns_whole_text() {
        let (name, desc, body) = split_front_matter("直接就是正文");
        assert!(name.is_empty() && desc.is_empty());
        assert_eq!(body, "直接就是正文");
    }
}
