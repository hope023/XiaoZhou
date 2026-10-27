import { useSyncExternalStore } from "react";

export type Locale = "zh-CN" | "zh-TW" | "en";

export const LOCALES: { value: Locale; label: string; native: string }[] = [
  { value: "zh-CN", label: "简体中文", native: "简体中文" },
  { value: "zh-TW", label: "繁體中文", native: "繁體中文" },
  { value: "en", label: "English", native: "English" },
];

/**
 * 翻译键直接用中文原文：写代码时不用想 key 名，缺翻译时自动退回中文。
 * 占位符写成 {name}。
 */
type Vars = Record<string, string | number>;

const EN: Record<string, string> = {
  /* ---------- 窗口与通用 ---------- */
  "小舟": "XiaoZhou",
  "最小化": "Minimize",
  "最大化": "Maximize",
  "还原": "Restore",
  "关闭": "Close",
  "设置": "Settings",
  "取消": "Cancel",
  "保存": "Save",
  "确定": "OK",
  "删除": "Delete",
  "清空": "Clear",
  "复制": "Copy",
  "已复制": "Copied",
  "编辑": "Edit",
  "分叉": "Branch",
  "重命名": "Rename",
  "置顶": "Pin",
  "取消置顶": "Unpin",
  "执行中": "Running",
  "执行中…": "Running…",
  "导出为 Markdown": "Export as Markdown",
  "删除对话": "Delete chat",

  /* ---------- 侧栏 ---------- */
  "新建对话": "New chat",
  "定时任务": "Scheduled tasks",
  "搜索对话…": "Search chats…",
  "没有匹配「{query}」的对话": 'No chats match "{query}"',
  "未设置目录": "No folder",
  "设置 (Ctrl+,)": "Settings (Ctrl+,)",

  /* ---------- 输入区 ---------- */
  "图片 {n}": "Image {n}",
  "移除图片": "Remove image",
  "说点什么，@ 引用文件，或粘贴截图…": "Ask anything, type @ to reference a file, or paste a screenshot…",
  "没有匹配的文件": "No matching files",
  "先设置工作目录才能引用文件": "Set a working folder first to reference files",
  "{model}（点击切换模型）": "{model} (click to switch)",
  "未配置模型": "No model",
  "切换模型": "Switch model",
  "还没有常用模型，点「管理模型」把常用的加进去": "No saved models yet. Use \"Manage models\" to add some.",
  "✓ 当前": "✓ Active",
  "管理模型…": "Manage models…",
  "插入图片（也可以直接粘贴截图）": "Attach image (or paste a screenshot)",
  "停止": "Stop",
  "发送 (Enter)": "Send (Enter)",
  "Enter 发送 · Shift + Enter 换行 · @ 引用文件 · 粘贴截图":
    "Enter to send · Shift + Enter for newline · @ to reference files · paste screenshots",
  "当前会话的上下文用量 / 预算，快到预算时早期对话会被摘要压缩":
    "Context usage / budget for this chat. When it gets close, older turns are summarized.",

  /* ---------- 消息 ---------- */
  "思考中…": "Thinking…",
  "思考过程": "Reasoning",
  "思考过程 · {n} 字": "Reasoning · {n} chars",
  "过程": "Process",
  "思考 {n} 字": "Thought {n} chars",
  "点击展开这部分过程": "Click to expand this process",
  "重新生成": "Regenerate",
  "↑{a} ↓{b} · 共 {c} tokens": "↑{a} ↓{b} · {c} tokens total",

  /* ---------- 工具卡片 ---------- */
  "{n} 步": "{n} steps",
  "中断": "Stop",
  "撤销": "Undo",
  "错误": "Error",
  "读取": "Read",
  "浏览": "Browsed",
  "匹配": "Matched",
  "搜索": "Searched",
  "运行": "Ran",
  "修改": "Edited",
  "写入": "Wrote",
  "网页搜索": "Web search",
  "抓取网页": "Fetched page",
  "加载技能": "Loaded skill",
  "记忆": "Memory",
  "更新任务清单": "Updated todo list",
  "回滚": "Reverted",
  "批量回滚": "Reverted batch",
  "个文件": "files",
  "个目录": "folders",
  "次": "times",
  "条命令": "commands",
  "个": "",
  "正在{action}": "Running {action}",
  "{text}（{n} 个失败）": "{text} ({n} failed)",

  /* ---------- 右键菜单 ---------- */
  "剪切": "Cut",
  "粘贴": "Paste",
  "全选": "Select all",
  "在浏览器打开": "Open in browser",
  "复制链接地址": "Copy link address",
  "复制代码": "Copy code",
  "复制消息": "Copy message",

  /* ---------- 权限模式 ---------- */
  "只读": "Read-only",
  "标准": "Standard",
  "放开": "Unrestricted",
  "只能看目录、读文件和搜索，绝不改动任何东西":
    "Browse folders, read files and search only. Nothing is ever modified.",
  "可以改文件、跑命令，改文件和命令前都会先给你看变更再确认":
    "Can edit files and run commands, but shows you the diff and asks before each change.",
  "能干所有事，不再逐条确认，速度最快":
    "Does everything without asking each time. Fastest, least safe.",

  /* ---------- 快捷键提示 ---------- */
  "按 {key} 呼出/隐藏窗口": "{key} shows or hides the window",

  /* ---------- 设置面板 ---------- */
  "通用设置": "General",
  "模型设置": "Model",
  "定时任务设置": "Scheduled tasks",
  "MCP 服务器": "MCP servers",
  "界面语言": "Language",
  "切换后立即生效。界面语言不影响模型回复的语言，回复会跟随你提问的语言":
    "Takes effect immediately. This does not change the language the model replies in — that follows your question.",
  "默认工作目录": "Default working folder",
  "默认权限模式": "Default permission mode",
  "界面字体大小": "Font size",
  "界面字体样式": "Font family",
  "系统默认": "System default",
  "得意黑": "Smiley Sans",
  "上下文预算": "Context budget",
  "全局呼出快捷键": "Global shortcut",
  "长期记忆": "Long-term memory",
  "关于": "About",
  "快速预设": "Presets",
  "接口地址": "API base URL",
  "API Key": "API key",
  "模型": "Model",
  "＋ 存为常用": "+ Save to favorites",
  "温度": "Temperature",

  /* ---------- 输入区控件 ---------- */
  "选择工作目录": "Choose working folder",
  "选择目录": "Choose folder",
  "还没设目录": "No folder yet",
  "选择文件夹…": "Choose folder…",
  "恢复默认目录": "Use default folder",
  "选择这个对话的工作目录": "Choose a working folder for this chat",
  "打开文件夹选择框失败：{msg}": "Could not open the folder picker: {msg}",
  "这个对话的权限": "Permissions for this chat",
  "当前": "Active",

  /* ---------- 确认弹窗 ---------- */
  "要应用这次文件改动吗？": "Apply these file changes?",
  "要执行这条命令吗？": "Run this command?",
  "来自对话「{name}」": 'From chat "{name}"',
  "文件太大，只展示前后对比，没有逐行对齐。":
    "File is large — showing a side-by-side summary instead of line-by-line alignment.",
  "它会在工作目录下以 PowerShell 运行。你可以在设置里关掉逐条确认。":
    "It will run in the working folder using the Windows shell. You can turn off per-command confirmation in Settings.",
  "记住这条命令，以后不再询问": "Remember this command, don't ask again",
  "不改": "Discard",
  "拒绝": "Reject",
  "应用": "Apply",
  "执行": "Run",

  /* ---------- 通知与导出 ---------- */
  "没能引用这个文件": "Could not reference this file",
  "快捷键注册失败": "Shortcut registration failed",
  "导出完成": "Export finished",
  "导出失败": "Export failed",
  "定时任务：{name}": "Scheduled task: {name}",
  "执行失败：{msg}": "Failed: {msg}",
  "执行完成，点开「小舟」查看结果": "Done. Open XiaoZhou to see the result.",
  "未设置": "Not set",
  "> 导出于 {time} · 工作目录 {dir}": "> Exported at {time} · Working folder {dir}",
  "🧑 我": "🧑 Me",
  "🤖 小舟": "🤖 XiaoZhou",
  "（出错：{msg}）": "(Error: {msg})",
  "（执行了工具调用，见下）": "(Tool calls were made — see below)",
  "我能读写你的文件、跑命令。不确定从哪开始？试试下面这些。":
    "I can read and write your files and run commands. Not sure where to start? Try one of these.",

  "浏览…": "Browse…",
  "浏览文件夹": "Browse folders",
  "这个目录不存在，先建好，或者点「浏览…」重新选一个":
    "This folder doesn't exist. Create it first, or click Browse to pick another one.",
  "新建对话默认用这个目录。已经开着的对话可以在对话顶部的目录栏单独切换，互不影响":
    "New chats use this folder. Existing chats can switch folders from the folder bar above the composer.",
  "新建对话默认用这个。已经开着的对话可以在顶栏右侧单独切换，互不影响":
    "New chats use this mode. Existing chats can switch it from the chip in the composer.",
  "小舟按时间跑，不再让你算轮数：一段跑满这个时长就先给你阶段结论。普通改代码任务一段够用；通读整个项目做审查建议 30~60 分钟":
    "XiaoZhou works against a time budget instead of a step count: when a segment runs out, you get an interim conclusion. 15 minutes is plenty for everyday edits; use 30–60 for a full project review.",
  "到时间后自动接着跑（最多 3 段）": "Continue automatically when the time budget runs out (max 3 segments)",
  "开：一段跑满后自动压缩上下文、接着上一段的进度继续，你不用点「继续」；关：跑满就停下来给你阶段结论，由你决定要不要接着做":
    "On: compacts the context and keeps going from where it stopped. Off: stops at the budget and leaves the next step to you.",
  "发给模型的历史上限（近似 token）。超出后自动摘要压缩最早的消息，按模型上下文窗口的一半左右填比较稳，比如 32k 窗口填 16000":
    "History budget sent to the model (approx. tokens). Beyond it, the oldest turns are summarized. Half of the model's context window is a safe value — e.g. 16000 for a 32k window.",
  "整个界面（消息、侧栏、代码）按比例缩放，默认 15px，比旧版大一号。保存后立即生效":
    "Scales the whole UI (messages, sidebar, code). Default 15px. Applies as soon as you save.",
  "得意黑（Smiley Sans）为开源免费商用字体，已内置在应用里，离线可用；代码块仍使用等宽字体":
    "Smiley Sans is a free, open-source, commercially usable font bundled with the app. Code blocks stay monospaced.",
  "任何应用里按它呼出/隐藏小舟。写法：修饰键加号连键名，如 alt+space、ctrl+shift+z、super+j。改完点「保存」立即生效；注册失败会弹系统通知":
    "Press it in any app to show or hide XiaoZhou. Format: modifiers joined by '+', e.g. alt+space, ctrl+shift+z, super+j. Applies on save; a system notification appears if registration fails.",
  "用户级 {a} 条 · 项目级 {b} 条。对话里说「记住…」，小舟会存下来并在此后所有对话中生效":
    "{a} user entries · {b} project entries. Say \"remember…\" in a chat and it will be kept for future chats.",
  "清空记忆": "Clear memory",
  "存放在 ~/.xiaozhou/memory.md（用户级）和工作目录下的 .xiaozhou/memory.md（项目级），都是纯 Markdown，可以直接编辑":
    "Stored in ~/.xiaozhou/memory.md (user) and .xiaozhou/memory.md in the working folder (project). Both are plain Markdown you can edit.",
  "检查更新": "Check for updates",
  "检查中…": "Checking…",
  "有新版本 v{latest}（当前 v{current}），去 Release 页下载":
    "v{latest} is available (you have v{current}). Download it from the Releases page.",
  "已是最新版本 v{current}": "You're on the latest version (v{current}).",
  "复制下载链接": "Copy download link",
  "填到域名或版本路径即可，会自动补 chat/completions。例如 https://open.bigmodel.cn/api/paas/v4":
    "A host or version path is enough — chat/completions is appended automatically, e.g. https://open.bigmodel.cn/api/paas/v4",
  "本地模型不需要填": "Not needed for local models",
  "显示": "Show",
  "隐藏": "Hide",
  "0 更稳、更守规矩": "0 — steadier, follows instructions",
  "1.5 更发散、更随意": "1.5 — more varied, more freewheeling",
  "决定模型每次挑词有多随机。调低会照章办事、少发挥；调高更有创意，但也更容易跑偏。让它改代码、跑命令建议 0.2~0.5；闲聊写作 0.7~1.0。":
    "How randomly the model picks words. Lower is more literal and predictable, higher is more creative but drifts more. Use 0.2–0.5 for code and commands, 0.7–1.0 for chat and writing.",
  "简体中文": "简体中文",
  "繁體中文": "繁體中文",
  "English": "English",

  "看看当前目录里有什么": "What's in the current folder?",
  "帮我读一下 README，说说这个项目是干嘛的": "Read the README and tell me what this project does",
  "列出最近改过的文件": "List the recently modified files",

  /* ---------- 工具名 ---------- */
  "查看目录": "List folder",
  "读取文件": "Read file",
  "写入文件": "Write file",
  "修改文件": "Edit file",
  "搜索内容": "Search text",
  "查找文件": "Find files",
  "撤销改动": "Revert change",
  "执行命令": "Run command",
  "调用技能": "Use skill",
  "更新清单": "Update todos",
  "联网搜索": "Web search",
  "、": ", ",

  /* ---------- 定时任务 ---------- */
  "＋ 新建": "+ New",
  "收起": "Collapse",
  "任务名，如「检查构建」": 'Task name, e.g. "Check build"',
  "要执行什么，如「看看 dist 目录有没有今天的新构建，有就列出来」":
    'What to run, e.g. "Check whether dist/ has a build from today and list it"',
  "固定间隔": "Fixed interval",
  "每天定时": "Daily at",
  "每": "Every",
  "分钟": "min",
  "每 {n} 分钟": "Every {n} min",
  "每 {n} 小时": "Every {n} h",
  "每天": "Daily at",
  "只读模式": "Read-only mode",
  "标准模式": "Standard mode",
  "放开模式": "Unrestricted mode",
  "工作目录（默认 {dir}）": "Working folder (default {dir})",
  "创建": "Create",
  "任务只在应用开着时执行；关闭应用即暂停": "Runs only while the app is open; closing the app pauses it.",
  "还没有定时任务。创建后，到点时小舟会自己开一个对话执行，并用系统通知告诉你结果。":
    "No scheduled tasks yet. When one is due, XiaoZhou opens a chat, runs it, and notifies you with the result.",
  "下次：{when}": "Next: {when}",
  "即将执行": "due now",
  "{n} 分钟后": "in {n} min",
  "{n} 小时后": "in {n} h",
  "已停用": "Paused",
  " · 上次失败": " · last run failed",
  " · 执行中…": " · running…",
  "停用": "Pause",
  "启用": "Enable",
  "立即跑": "Run now",
  "上次运行": "Last run",

  /* ---------- MCP ---------- */
  "添加 MCP Server": "Add MCP server",
  "名称，如 dbx": "Name, e.g. dbx",
  "启动命令，如 dbx mcp --stdio": "Command, e.g. dbx mcp --stdio",
  "添加并连接": "Add & connect",
  "连接": "Connect",
  "连接中…": "Connecting…",
  "断开": "Disconnect",
  "{n} 个工具": "{n} tools",
  "填本地 MCP server 的启动命令（stdio 传输）。连接成功后它的工具会自动出现在「标准 / 放开」模式的工具列表里，工具名形如 mcp__dbx__query。":
    "Enter the launch command of a local MCP server (stdio). Once connected, its tools appear automatically in Standard and Unrestricted modes as mcp__dbx__query.",
  "还没有配置 MCP server。配置保存在 ~/.xiaozhou/mcp.json，也可以直接编辑那个文件。":
    "No MCP servers yet. Config lives in ~/.xiaozhou/mcp.json — you can also edit that file by hand.",


  "单段任务时长（分钟）": "Segment length (minutes)",
  "小舟 Xiaozhou —— 让 AI 帮你干活 0123456789": "XiaoZhou — let AI do the work 0123456789",
  "确定清空全部长期记忆？不可恢复。": "Clear all long-term memories? This cannot be undone.",
  "下载链接已复制到剪贴板": "Download link copied to clipboard",
  "{url}｜模型 {model}（会同时覆盖地址和模型）": "{url} | model {model} (overwrites both URL and model)",
  "加入常用模型列表，输入框右下角可以快速切换": "Add to favorites — switch quickly from the model chip",
  "当前模型": "Current model",
  "点击切换到这个模型": "Switch to this model",
  "从常用列表移除": "Remove from favorites",


  /* ---------- 设置导航 ---------- */
  "通用": "General",
  "对话与任务": "Chat & tasks",
  "扩展": "Extensions",
  "其他": "Other",
  "语言与外观": "Language & appearance",
  "工作目录": "Working folder",
  "权限模式": "Permissions",
  "时长与续跑": "Time budget",
  "上下文与记忆": "Context & memory",
  "快捷键": "Shortcut",
  "接口与密钥": "Endpoint & key",
  "模型与参数": "Model & sampling",
  "关于与更新": "About & updates",


  "小舟只在这个目录里读写文件、执行命令；换项目就换目录。它不会主动往里面写东西——只有你让它改文件，或保存项目级记忆/技能时，才会用到这里面的 .xiaozhou 文件夹":
    "XiaoZhou only reads, writes and runs commands inside this folder — switch folders to switch projects. It never writes here on its own: only when you ask it to change files, or when saving project-level memory/skills, does it use a .xiaozhou folder inside it.",
  "现在是盘符根目录或用户主目录，范围太大了。建议选一个具体项目文件夹，或用默认的 ~/XiaoZhou":
    "This is a drive root or your home folder — far too broad. Pick an actual project folder, or use the default ~/XiaoZhou.",
  "用默认目录（~/XiaoZhou）": "Use default folder (~/XiaoZhou)",
  "会话记录、定时任务、模型配置和用户级记忆都存在 ~/.xiaozhou，不会放进工作目录":
    "Chat history, scheduled tasks, model config and user-level memory live in ~/.xiaozhou — not in the working folder.",


  "用默认目录（用户主目录）": "Use default folder (home)",
  "盘符根目录范围太大了，选一个具体项目文件夹吧": "A drive root is too broad — pick an actual project folder.",


  "执行策略": "Execution",
  "复杂任务先列计划再动手": "Plan before acting on complex tasks",
  "要改代码或多步操作时，先在对话里给出 3~6 步清单再逐步执行，你随时能看到进度；简单问答不受影响":
    "For code changes and multi-step work it lists 3–6 steps first, then executes them one by one so you can follow along. Simple questions are unaffected.",
  "改完文件自动跑验证（typecheck / build）": "Auto-verify after edits (typecheck / build)",
  "识别到项目里的 typecheck / build 命令时，改完自动跑一次并把报错喂回模型自己修，一次任务最多 3 次。它真的会执行项目脚本，不需要就关掉":
    "When a typecheck/build command is detected, it runs once after edits and feeds errors back to the model, up to 3 times per task. It really executes project scripts — turn this off if you don't want that.",
  "回答完成后折叠过程": "Collapse the process once the answer is done",
  "思考和工具调用只在执行时展开；最终回答出来后收进一条「过程」里，点一下就能重新展开。中途有工具报错时仍会自动展开":
    "Reasoning and tool calls stay open only while running. Once the final answer lands they fold into a single Process row you can click to reopen. It still auto-expands if a tool failed.",

};

/* ---------------- 简体 → 繁体（UI 常用字词表） ---------------- */

const TW_PHRASES: [string, string][] = [
  ["服务器", "伺服器"],
  ["接口", "介面"],
  ["回复", "回覆"],
  ["后台", "後台"],
  ["默认", "預設"],
  ["设置", "設定"],
  ["保存", "儲存"],
  ["复制", "複製"],
  ["撤销", "撤銷"],
  ["重置", "重設"],
  ["只读", "唯讀"],
  ["视频", "影片"],
  ["文件", "檔案"],
  ["信息", "資訊"],
  ["菜单", "選單"],
  ["界面", "介面"],
  ["登录", "登入"],
  ["账号", "帳號"],
  ["示例", "範例"],
  ["支持", "支援"],
  ["运行", "執行"],
  ["打印", "列印"],
  ["网络", "網路"],
  ["视频", "影片"],
  ["垃圾", "垃圾桶"],
  ["回收站", "資源回收筒"],
];

const TW_CHARS: Record<string, string> = {
  参: "參" , 键: "鍵" , 于: "於" , 传: "傳" , 侧: "側" , 册: "冊" , 决: "決" , 准: "準",
  办: "辦" , 号: "號" , 吗: "嗎" , 块: "塊" , 审: "審" , 宽: "寬" , 将: "將" , 当: "當",
  径: "徑" , 挥: "揮" , 旧: "舊" , 条: "條" , 构: "構" , 栏: "欄" , 满: "滿" , 独: "獨",
  着: "著" , 离: "離" , 称: "稱" , 经: "經" , 绝: "絕" , 统: "統" , 编: "編" , 补: "補",
  议: "議" , 论: "論" , 询: "詢" , 轮: "輪" , 较: "較" , 辑: "輯" , 钟: "鐘" , 链: "鏈",
  闲: "閒" , 阶: "階" , 饰: "飾" , 临: "臨" , 丽: "麗" , 举: "舉" , 义: "義" , 乐: "樂",
  争: "爭" , 产: "產" , 仅: "僅" , 从: "從" , 价: "價" , 众: "眾" , 优: "優" , 会: "會",
  伤: "傷" , 体: "體" , 余: "餘" , 值: "值" , 停: "停" , 关: "關" , 兴: "興" , 养: "養",
  冲: "衝" , 净: "淨" , 减: "減" , 几: "幾" , 击: "擊" , 划: "劃" , 则: "則" , 刚: "剛",
  创: "創" , 别: "別" , 制: "制" , 务: "務" , 动: "動" , 势: "勢" , 勋: "勳" , 们: "們",
  个: "個" , 为: "為" , 这: "這" , 里: "裡" , 设: "設" , 选: "選" , 择: "擇" , 项: "項",
  时: "時" , 间: "間" , 开: "開" , 闭: "閉" , 发: "發" , 现: "現" , 读: "讀" , 写: "寫",
  录: "錄" , 夹: "夾" , 说: "說" , 话: "話" , 输: "輸" , 图: "圖" , 删: "刪" , 对: "對",
  应: "應" , 该: "該" , 无: "無" , 错: "錯" , 误: "誤" , 试: "試" , 验: "驗" , 复: "複",
  检: "檢" , 测: "測" , 权: "權" , 标: "標" , 级: "級" , 进: "進" , 记: "記" , 忆: "憶",
  长: "長" , 缓: "緩" , 内: "內" , 数: "數" , 据: "據" , 类: "類" , 计: "計" , 单: "單",
  换: "換" , 确: "確" , 认: "認" , 继: "繼" , 续: "續" , 断: "斷" , 运: "運" , 环: "環",
  显: "顯" , 隐: "隱" , 层: "層" , 弹: "彈" , 盘: "盤" , 贴: "貼" , 终: "終" , 败: "敗",
  状: "狀" , 态: "態" , 结: "結" , 总: "總" , 费: "費" , 额: "額" , 预: "預" , 浏: "瀏",
  览: "覽" , 网: "網" , 页: "頁" , 载: "載" , 滚: "滾" , 执: "執" , 库: "庫" , 钥: "鑰",
  温: "溫" , 稳: "穩" , 随: "隨" , 机: "機" , 顺: "順" , 帮: "幫" , 历: "歷" , 陆: "陸",
  压: "壓" , 缩: "縮" , 诉: "訴" , 让: "讓" , 给: "給" , 变: "變" , 后: "後" , 台: "臺",
  与: "與" , 并: "並" , 还: "還" , 没: "沒" , 见: "見" , 听: "聽" , 觉: "覺" , 么: "麼",
  样: "樣" , 须: "須" , 过: "過" , 来: "來" , 边: "邊" , 头: "頭" , 门: "門" , 问: "問",
  题: "題" , 视: "視" , 频: "頻" , 语: "語" , 简: "簡" , 连: "連" , 启: "啟" , 调: "調",
  骤: "驟" , 细: "細" , 节: "節" , 点: "點" , 双: "雙" , 盖: "蓋" , 销: "銷" , 暂: "暫",
  导: "導" , 顶: "頂" , 学: "學" , 习: "習" , 户: "戶" , 遗: "遺" , 齐: "齊" , 备: "備",
  够: "夠" , 获: "獲" , 树: "樹" , 苏: "蘇" , 松: "鬆" , 借: "藉" , 采: "採" , 签: "簽",
  联: "聯" , 络: "絡" , 闻: "聞" , 险: "險" , 营: "營" , 响: "響" , 师: "師" , 赢: "贏",
  词: "詞" , 讲: "講" , 质: "質" , 观: "觀" , 规: "規" , 请: "請" , 谢: "謝" , 谁: "誰",
  华: "華" , 湾: "灣" , 码: "碼" , 线: "線" , 练: "練",

};

function toTraditional(text: string): string {
  let out = text;
  for (const [from, to] of TW_PHRASES) out = out.split(from).join(to);
  let result = "";
  for (const ch of out) result += TW_CHARS[ch] ?? ch;
  return result;
}

/* ---------------- 运行时状态 ---------------- */

let current: Locale = "zh-CN";
const listeners = new Set<() => void>();
const missing = new Set<string>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale) {
  if (next === current) return;
  current = next;
  document.documentElement.lang = next === "en" ? "en" : next === "zh-TW" ? "zh-TW" : "zh-CN";
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 组件里调用一次即可在切换语言时重新渲染 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/** 翻译 + 占位符替换；缺词时退回中文并在开发期提示 */
export function tr(text: string, vars?: Vars): string {
  let out = text;
  if (current === "en") {
    out = EN[text] ?? text;
    if (!(text in EN) && import.meta.env.DEV) {
      if (!missing.has(text)) {
        missing.add(text);
        console.warn("[i18n] missing en:", text);
      }
    }
  } else if (current === "zh-TW") {
    out = toTraditional(text);
  }
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.split(`{${key}}`).join(String(value));
    }
  }
  return out;
}

/** 按当前语言格式化时间 */
export function dateLocale(): string {
  return current === "en" ? "en-US" : current === "zh-TW" ? "zh-TW" : "zh-CN";
}
