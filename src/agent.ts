import { invoke } from "@tauri-apps/api/core";
import { diffLines as computeDiffRows } from "./diff";
import { streamChat } from "./llm";
import { modeInfo } from "./modes";
import { newId } from "./store";
import type {
  AgentMode,
  ApiMessage,
  ChatMessage,
  ContentPart,
  DiffData,
  DiffRow,
  MessagePart,
  Settings,
  ToolCall,
  ToolResult,
  UsageInfo,
} from "./types";
import { TOOL_SPECS, executeTool, summarizeArgs } from "./tools";

const DEFAULT_SYSTEM = `你是「小舟」，一个运行在用户 Windows 电脑上的桌面 AI 助手。你不是只会聊天的对话框——你可以直接操作用户的电脑。

可用工具：
- list_dir(path)：列目录
- read_file(path, offset, limit)：读文件，返回带行号的内容
- write_file(path, content)：整体覆盖写入文件
- run_command(command, timeout_sec)：在工作目录下执行 PowerShell 命令

工作目录：{{WORKSPACE}}
当前时间：{{NOW}}

工作准则：
1. 涉及用户的项目或文件时，先 list_dir / read_file 看清真实情况，不要凭猜测作答。
2. 改文件前必须先读原文，改动尽量小且贴合原有风格，不要顺手重排无关代码。
3. run_command 是 PowerShell 语法；路径含空格要加引号。
4. 删除、覆盖重要文件、格式化、改系统设置这类不可逆操作，先说清后果再做。
5. 工具返回错误时，读错误信息调整方案，不要原样重试。
6. 最终回复用中文，简洁直接。不要复述工具输出的全部内容，只说结论和关键点。
7. 不要输出「我将要调用工具」这类空话，直接调用。

预算与收敛（很重要，违反会白烧时间）：
- 本次任务时间预算约 {{MINUTES}} 分钟，上下文预算约 {{BUDGET}} token。每轮可以同时发起多个工具调用，务必并行。
- 探索顺序：先用 glob / search_text 定位候选文件，再在一轮里并发 read_file 多个关键文件；不要一轮只读一个文件，也不要为了「看全」把所有文件读完。
- 大文件用 offset / limit 只读相关段落，不要整篇通读。
- 信息足够支撑结论就立刻停下写结论，剩下的留作「下一步建议」。
- 时间过半会收到提醒，此后优先收敛；时间到点会自动接着跑下一段，你不需要自己喊停，但也不要重复已经做过的工作。`;

export function buildSystemPrompt(
  settings: Settings,
  workspace: string,
  mode?: AgentMode,
  guide?: string,
  repoMap?: string
): string {
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  let prompt = DEFAULT_SYSTEM.replace("{{WORKSPACE}}", workspace || "（未设置）")
    .replace("{{NOW}}", now)
    .replace("{{MINUTES}}", String(Math.max(1, Math.round(settings.taskMinutes || 15))))
    .replace("{{BUDGET}}", String(Math.max(4000, settings.contextBudget || 24000)));
  if (mode) {
    const info = modeInfo(mode);
    prompt += `\n\n当前权限模式：${info.label} —— ${info.desc}`;
  }
  if (guide) {
    prompt += `\n\n这个项目的约定（来自工作目录里的约定文件，必须遵守）：\n${guide}`;
  }
  if (repoMap && repoMap.trim()) {
    prompt += `\n\n${repoMap.trim()}`;
  }
  if (settings.planFirst !== false) {
    prompt += `\n\n做事方式：
- 要改代码或需要多步操作时，先用 todo_write 列出 3~6 步计划，再按顺序执行，每完成一步就更新清单；一两句话能答完的问题不用列。
- 改完文件后如果收到「自动验证」的输出，先看有没有报错；有报错就继续修，直到通过或确认是环境问题。
- 改大文件时优先 edit_file 做局部替换，别整文件重写。`;
  }
  return prompt;
}

/** 把持久化的会话还原成 OpenAI 格式的消息序列 */
export function toApiMessages(
  history: ChatMessage[],
  settings: Settings,
  workspace: string,
  mode?: AgentMode,
  guide?: string,
  skills?: string,
  memory?: string,
  todos?: { content: string; status: "pending" | "in_progress" | "done" }[],
  repoMap?: string
): ApiMessage[] {
  let system = buildSystemPrompt(settings, workspace, mode, guide, repoMap);
  if (todos && todos.length > 0) {
    const lines = todos.map(
      (item) =>
        `- [${item.status === "done" ? "x" : item.status === "in_progress" ? "~" : " "}] ${item.content}`
    );
    system += `\n\n当前任务清单（用 todo_write 维护状态）：\n${lines.join("\n")}`;
  }
  if (memory && memory.trim()) {
    system += `\n\n${memory.trim()}\n对话中出现值得长期记住的信息时，主动调用 memory 工具记下来；记忆里的内容与用户当前指令冲突时，先提一句再按用户说的做。`;
  }
  if (skills && skills.trim()) {
    system += `\n\n可用技能（任务与描述匹配时，先用 use_skill 拿到详细指令再动手）：\n${skills.trim()}`;
  }
  const out: ApiMessage[] = [{ role: "system", content: system }];

  for (const msg of history) {
    if (msg.role === "user") {
      // @ 引用的文件内容拼在正文后面，模型能看到完整材料
      let text = msg.content;
      for (const attachment of msg.attachments ?? []) {
        text += `\n\n---\n文件 @${attachment.path} 的内容：\n\`\`\`\n${attachment.content}\n\`\`\``;
      }

      const images = msg.images ?? [];
      if (images.length > 0) {
        const parts: ContentPart[] = [{ type: "text", text }];
        for (const url of images) {
          parts.push({ type: "image_url", image_url: { url } });
        }
        out.push({ role: "user", content: parts });
      } else {
        out.push({ role: "user", content: text });
      }
      continue;
    }

    const callById = new Map((msg.toolCalls ?? []).map((call) => [call.id, call]));
    const resultById = new Map((msg.toolResults ?? []).map((item) => [item.toolCallId, item]));

    if (!msg.parts || msg.parts.length === 0) {
      // 老数据：一整条 assistant + 全部工具结果
      if (!msg.content && !(msg.toolCalls ?? []).length) continue;
      out.push({
        role: "assistant",
        content: msg.content || null,
        ...(msg.toolCalls?.length ? { tool_calls: msg.toolCalls } : {}),
      });
      for (const result of msg.toolResults ?? []) {
        out.push({ role: "tool", tool_call_id: result.toolCallId, content: result.output });
      }
      continue;
    }

    let buffer: string[] = [];
    const flush = (calls: ToolCall[]) => {
      if (!buffer.length && !calls.length) return;
      out.push({
        role: "assistant",
        content: buffer.join("\n\n") || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      buffer = [];
    };

    for (const part of msg.parts) {
      if (part.kind === "text") {
        if (part.text.trim()) buffer.push(part.text);
        continue;
      }
      if (part.kind !== "tools") continue;
      const calls = part.callIds
        .map((id) => callById.get(id))
        .filter((call): call is ToolCall => !!call);
      flush(calls);
      for (const call of calls) {
        out.push({
          role: "tool",
          tool_call_id: call.id,
          content: truncateText(resultById.get(call.id)?.output ?? "（没有结果）", 8000),
        });
      }
    }
    flush([]);
  }

  return out;
}

export interface AgentRunOptions {
  history: ChatMessage[];
  settings: Settings;
  /** 本次对话实际使用的工作目录（会话级优先于设置里的默认值） */
  workspace: string;
  /** 本次对话的权限模式 */
  mode: AgentMode;
  /** 返回 true 表示用户点了停止 */
  isAborted: () => boolean;
  /** 弹确认窗时标注的来源（一般是会话标题） */
  sessionTitle?: string;
  /** 实时把助手消息的中间状态推给界面 */
  onAssistant: (patch: Partial<ChatMessage>) => void;
  /** todo_write 更新任务清单 */
  onTodos?: (items: { id: string; content: string; status: "pending" | "in_progress" | "done" }[]) => void;
  /** 当前任务清单，注入 system prompt 让模型保持焦点 */
  todos?: { content: string; status: "pending" | "in_progress" | "done" }[];
  /** 关闭自动批准时，执行命令前先问用户一句；带 diff 时展示变更预览 */
  requestApproval?: (info: {
    name: string;
    summary: string;
    diff?: DiffData;
    /** 弹窗里标注来源会话，后台任务弹窗时用户才知道是谁在要权限 */
    context?: string;
  }) => Promise<boolean>;
}

/** 解析接口返回的 usage，兼容 snake / camel 两种字段名 */
function parseUsage(raw: unknown): UsageInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const num = (...keys: string[]) => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const prompt = num("prompt_tokens", "promptTokens", "input_tokens", "inputTokens");
  const completion = num(
    "completion_tokens",
    "completionTokens",
    "output_tokens",
    "outputTokens"
  );
  const total = num("total_tokens", "totalTokens") ?? (prompt ?? 0) + (completion ?? 0);
  if (!prompt && !completion && !total) return null;
  return { prompt, completion, total };
}

/** 生成 diff 行数据，超出上限的行不再做精细对齐 */
function buildDiff(path: string, oldText: string, newText: string): DiffData {
  const { rows, truncated } = computeDiffRows(oldText, newText);
  const added = rows.filter((row) => row.type === "add").length;
  const removed = rows.filter((row) => row.type === "del").length;
  return { path, rows, added, removed, truncated };
}

/** 粗略估算 token：中文按 1.6，其余按 1/3.6 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 1.6 + other / 3.6);
}

function messageCost(msg: ApiMessage): number {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return estimateTokens(content);
    // 图片按固定值估（1024~2048px 的图约 1000+ token），文本照常
    return content.reduce(
      (sum, part) =>
        sum + (part.type === "text" ? estimateTokens(part.text) : 1100),
      0
    );
  }
  if (msg.role === "assistant") {
    const calls = (msg.tool_calls ?? [])
      .map((call) => call.function?.name + (call.function?.arguments ?? ""))
      .join("");
    return estimateTokens(msg.content ?? "") + estimateTokens(calls);
  }
  return estimateTokens(msg.content ?? "");
}

/**
 * 按预算裁剪历史：system 永远保留，其余按「一个 user 及其后续」为单位
 * 从最新往前保留，避免把 assistant(tool_calls) 和对应的 tool 结果拆散。
 */
export function trimToBudget(messages: ApiMessage[], budget: number): ApiMessage[] {
  if (messages.length <= 1) return messages;
  const [system, ...rest] = messages;

  const groups: ApiMessage[][] = [];
  for (const msg of rest) {
    if (msg.role === "user" || groups.length === 0) {
      groups.push([msg]);
    } else {
      groups[groups.length - 1].push(msg);
    }
  }

  let used = messageCost(system);
  const kept: ApiMessage[][] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groups[i].reduce((sum, m) => sum + messageCost(m), 0);
    // 至少保留最新一组，否则请求会变成空对话
    if (used + cost > budget && kept.length > 0) break;
    kept.unshift(groups[i]);
    used += cost;
  }

  return [system, ...kept.flat()];
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（结果过长已截断，原长 ${text.length} 字符）`;
}

/**
 * 超出预算时，把较早的对话交给模型压成摘要，而不是直接丢掉。
 * 摘要失败就退回普通截断，不至于让请求发不出去。
 */
async function compactMessages(
  messages: ApiMessage[],
  settings: Settings,
  budget: number,
  workspace: string
): Promise<ApiMessage[]> {
  const [system, ...rest] = messages;
  if (rest.length < 4) return trimToBudget(messages, budget);

  // 留最近 40% 预算的消息，其余压成摘要
  const keepBudget = Math.floor(budget * 0.4);
  let used = 0;
  let cutIndex = rest.length;
  for (let i = rest.length - 1; i >= 0; i--) {
    used += messageCost(rest[i]);
    if (used > keepBudget) {
      cutIndex = i + 1;
      break;
    }
    cutIndex = i;
  }

  const old = rest.slice(0, cutIndex);
  const keep = rest.slice(cutIndex);
  if (old.length === 0) return messages;

  const transcript = old
    .map((msg) => {
      const body = typeof msg.content === "string" ? msg.content : "";
      return `${msg.role}: ${body}`;
    })
    .join("\n")
    .slice(-24000);

  let summary = "";
  try {
    const done = await streamChat(
      {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: [
          {
            role: "system",
            content:
              "你是对话压缩器。把给定对话压成要点，保留：用户提出的要求、已经执行过的操作及其结果、得出的结论、尚未完成的事项。不要编造，不要评价。用简短中文条目输出。",
          },
          { role: "user", content: transcript },
        ],
        tools: [],
        temperature: 0.2,
      },
      () => {}
    );
    summary = done.content.trim();
  } catch {
    /* 摘要失败就退回截断 */
  }

  if (!summary) return trimToBudget(messages, budget);

  // 合并进原来那条 system，避免出现两条 system 消息
  const mergedSystem: ApiMessage = {
    role: "system",
    content: `${system.content}\n\n【早先对话的摘要】\n${summary}`,
  };
  void workspace;
  return [mergedSystem, ...keep];
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 让 Rust 算出 write_file / edit_file 改前改后的内容，给 diff 预览用 */
async function previewDiff(
  name: string,
  args: Record<string, unknown>,
  workspace: string
): Promise<DiffData | undefined> {
  try {
    const preview = await invoke<{
      path: string;
      oldContent: string;
      newContent: string;
    }>("preview_change", {
      root: workspace,
      kind: name === "write_file" ? "write" : "edit",
      path: args.path ?? "",
      content: typeof args.content === "string" ? args.content : null,
      oldText: typeof args.old_text === "string" ? args.old_text : null,
      newText: typeof args.new_text === "string" ? args.new_text : null,
    });
    return buildDiff(preview.path, preview.oldContent, preview.newContent);
  } catch {
    // 预览失败（比如 old_text 不匹配）就不弹 diff，让工具执行时自己报错
    return undefined;
  }
}

/** 按工具 schema 做一遍基本校验，把错误直接反馈给模型，省一轮往返 */
function validateArgs(name: string, args: Record<string, unknown>): string | null {
  const spec = TOOL_SPECS.find((item) => item.function.name === name);
  if (!spec) return null;
  const params = spec.function.parameters as unknown as {
    required?: string[];
    properties?: Record<string, { type?: string }>;
  };

  for (const key of params.required ?? []) {
    const value = args[key];
    if (value === undefined || value === null || value === "") {
      return `缺少必填参数 ${key}`;
    }
  }

  for (const [key, def] of Object.entries(params.properties ?? {})) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const expected = def.type;
    if (expected === "string" && typeof value !== "string") {
      return `参数 ${key} 应该是字符串`;
    }
    if (expected === "integer" && typeof value !== "number") {
      return `参数 ${key} 应该是数字`;
    }
    if (expected === "object" && typeof value !== "object") {
      return `参数 ${key} 应该是对象`;
    }
  }
  return null;
}

/** 已连接的 MCP server 工具，转成 OpenAI 工具格式（mcp__服务__工具） */
async function mcpToolSpecs(): Promise<
  { type: "function"; function: { name: string; description: string; parameters: unknown } }[]
> {
  try {
    const tools = await invoke<
      { server: string; name: string; description: string; inputSchema: unknown }[]
    >("mcp_all_tools");
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: `mcp__${tool.server}__${tool.name}`,
        description: `[MCP·${tool.server}] ${tool.description || tool.name}`,
        parameters: (tool.inputSchema as object) ?? { type: "object", properties: {} },
      },
    }));
  } catch {
    return [];
  }
}

export async function runAgent(options: AgentRunOptions): Promise<void> {
  const { settings, workspace, mode, isAborted, onAssistant } = options;
  const permission = modeInfo(mode);

  // 工作目录里的 AGENTS.md / CLAUDE.md 会被当作项目约定带进 system prompt
  let guide: string | undefined;
  try {
    const text = await invoke<string | null>("project_guide", { root: workspace });
    if (text && text.trim()) guide = text.trim();
  } catch {
    /* 没有约定文件就算了 */
  }

  // 长期记忆：两级内容注入 system prompt
  let memoryNote = "";
  try {
    const memory = await invoke<{ user: string; project: string }>("memory_read", {
      root: workspace,
    });
    const sections: string[] = [];
    if (memory.user?.trim()) sections.push(`【用户级】\n${memory.user.trim()}`);
    if (memory.project?.trim()) sections.push(`【项目级·当前目录】\n${memory.project.trim()}`);
    if (sections.length > 0) {
      memoryNote = `你此前主动记下的长期记忆（用户偏好、项目约定等）：\n${sections.join("\n\n")}`;
    }
  } catch {
    /* 没有记忆就算了 */
  }

  // 技能清单：名字 + 描述列进系统提示，正文由 use_skill 按需取
  let skillList: string | undefined;
  try {
    const skills = await invoke<{ name: string; description: string; source: string }[]>(
      "list_skills",
      { root: workspace }
    );
    if (skills.length > 0) {
      skillList = skills
        .map((skill) => `- ${skill.name}：${skill.description || "（无描述）"}`)
        .join("\n");
    }
  } catch {
    /* 没有技能就算了 */
  }

  // 项目结构摘要：让模型先有全局印象，少盲读文件（失败就算了）
  let repoMap: string | undefined;
  try {
    const map = await invoke<string | null>("repo_map", { root: workspace });
    if (map && map.trim()) repoMap = map.trim();
  } catch {
    /* 没有就没有 */
  }

  const budget = Math.max(4000, settings.contextBudget || 24000);
  const rawMessages = toApiMessages(
    options.history,
    settings,
    workspace,
    mode,
    guide,
    skillList,
    memoryNote || undefined,
    options.todos,
    repoMap
  );
  const totalCost = rawMessages.reduce((sum, msg) => sum + messageCost(msg), 0);
  let apiMessages =
    totalCost > budget
      ? await compactMessages(rawMessages, settings, budget, workspace)
      : rawMessages;

  if (!settings.apiKey.trim() && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(settings.baseUrl)) {
    throw new Error("还没有填写 API Key，点左下角「设置」配置一下");
  }
  if (!workspace.trim()) {
    throw new Error("还没有工作目录，点对话顶部那条目录栏选一个文件夹");
  }

  const parts: MessagePart[] = [];
  const allToolCalls: ToolCall[] = [];
  const allToolResults: ToolResult[] = [];
  let emptyRetries = 0;
  let lastUsage: UsageInfo | null = null;

  const push = () =>
    onAssistant({
      content: parts
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .filter(Boolean)
        .join("\n\n"),
      parts: parts.map((part) => ({ ...part })),
      toolCalls: [...allToolCalls],
      toolResults: allToolResults.map((result) => ({ ...result })),
      usage: lastUsage,
    });

  // 不再让用户配轮数：按「时间预算 + 自动续段」跑，轮数只是防死循环的硬兜底
  const HARD_ROUND_CAP = 150;
  const MAX_CONTINUES = 3;
  const segmentMs = Math.max(0.2, settings.taskMinutes || 15) * 60_000;
  const autoContinue = settings.autoContinue !== false;

  let segmentStart = Date.now(); // 当前段的起始时间（自动续段后重置）
  let continues = 0;
  let segmentWarned = false;
  let forceText = false;
  const callCounts = new Map<string, number>();
  let dirty = false; // 本轮改过文件、还没验证
  let verifyRuns = 0; // 一次任务最多自动验证 3 次

  for (let round = 0; round < HARD_ROUND_CAP; round++) {
    if (isAborted()) return;

    // 时间预算：到点先自动续段，续满 3 段后强制收尾（收尾轮不给工具）
    const elapsed = Date.now() - segmentStart;
    if (!forceText && elapsed > segmentMs) {
      if (autoContinue && continues < MAX_CONTINUES) {
        continues += 1;
        segmentStart = Date.now();
        segmentWarned = false;
        // 段与段之间压一次上下文，避免越跑越长
        apiMessages = await compactMessages(apiMessages, settings, budget, workspace);
        apiMessages.push({
          role: "user",
          content: `【自动继续 ${continues}/${MAX_CONTINUES}】上一段的时间预算用完了，现在接着做，不要重复已经完成的工作；先用一句话说明当前进度，再继续推进没做完的部分。`,
        });
      } else {
        forceText = true;
        apiMessages.push({
          role: "user",
          content:
            "【时间到】本次任务的时间预算已用完，这一轮不能再调用工具。请立刻基于已有的信息给出结论：1) 已确认的关键发现（分条，带文件路径/行号） 2) 还没查清的部分（卡在哪） 3) 建议的下一步。",
        });
      }
    } else if (!forceText && round === HARD_ROUND_CAP - 1) {
      forceText = true;
      apiMessages.push({
        role: "user",
        content:
          "【最后一轮】这一轮不能再调用工具了。请立刻基于已经读到的信息给出结论：1) 已确认的关键发现 2) 还没查清的部分 3) 建议的下一步。",
      });
    } else if (!forceText && !segmentWarned && elapsed > segmentMs * 0.7) {
      segmentWarned = true;
      apiMessages.push({
        role: "user",
        content: `【时间提醒】本段已用 ${Math.round(elapsed / 1000)} 秒（预算 ${Math.round(segmentMs / 1000)} 秒）。优先把手上这一步做完、给出结论，别再开新话题。`,
      });
    }

    const reasoningPart: MessagePart = { kind: "reasoning", id: newId(), text: "" };
    const textPart: MessagePart = { kind: "text", id: newId(), text: "" };
    parts.push(reasoningPart);
    parts.push(textPart);

    let roundText = "";
    let roundReasoning = "";
    const done = await streamChat(
      {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: apiMessages,
        tools: forceText
          ? []
          : [
              ...TOOL_SPECS.filter((spec) => permission.tools.includes(spec.function.name)),
              ...(mode === "readonly" ? [] : await mcpToolSpecs()),
            ],
        temperature: settings.temperature,
      },
      (delta) => {
        if (isAborted()) return;
        roundText += delta;
        textPart.text = roundText;
        push();
      },
      (delta) => {
        if (isAborted()) return;
        roundReasoning += delta;
        reasoningPart.text = roundReasoning;
        push();
      }
    );
    // 等下统一在处理正文时清理空的 reasoning part

    if (isAborted()) return;

    const parsedUsage = parseUsage(done.usage);
    if (parsedUsage) lastUsage = parsedUsage;

    const text = done.content || roundText;
    if (text.trim()) {
      roundText = text;
      textPart.text = text;
    } else {
      // 这一轮模型只调工具、没说话，把空文本片段去掉
      const index = parts.indexOf(textPart);
      if (index >= 0) parts.splice(index, 1);
      roundText = "";
    }

    const finalReasoning = done.reasoning || roundReasoning;
    if (finalReasoning && finalReasoning.trim()) {
      reasoningPart.text = finalReasoning;
    } else {
      const rIndex = parts.indexOf(reasoningPart);
      if (rIndex >= 0) parts.splice(rIndex, 1);
    }

    // 已经进入强制收尾时不再给工具；个别模型仍可能吐出工具调用，一律忽略
    const calls = forceText ? [] : done.toolCalls.filter((call) => call?.function?.name);
    if (calls.length === 0) {
      // 既没正文也没工具调用，多半是模型抽风，自动重试一次（收尾轮不重试，直接结束）
      if (!roundText.trim() && !forceText && emptyRetries < 2 && !isAborted()) {
        emptyRetries += 1;
        continue;
      }
      if (forceText && !roundText.trim()) {
        roundText =
          "时间/轮次预算已用完，模型这一轮没有输出文字结论。可以直接回复「继续」，我会带着已读到的内容接着往下做。";
        textPart.text = roundText;
      }
      push();
      return;
    }

    calls.forEach((call) => {
      if (!call.id) call.id = `call_${newId()}`;
      allToolCalls.push(call);
    });

    parts.push({ kind: "tools", id: newId(), callIds: calls.map((call) => call.id) });
    push();

    apiMessages.push({
      role: "assistant",
      content: roundText || null,
      tool_calls: calls,
    });

    // 预分配结果对象，保证卡片顺序和模型调用顺序一致
    const slots: { call: ToolCall; result: ToolResult }[] = calls.map((call) => ({
      call,
      result: {
        toolCallId: call.id,
        name: call.function.name,
        args: summarizeArgs(call.function.name, call.function.arguments || "{}"),
        output: "",
        ok: true,
        status: "running",
      },
    }));
    allToolResults.push(...slots.map((slot) => slot.result));
    push();

    // 标准模式下命令和文件改动都要逐条确认，整批就得串行，否则会同时弹一堆对话框
    const needsConfirm =
      mode === "standard" &&
      !!options.requestApproval &&
      slots.some((slot) =>
        slot.call.function.name.startsWith("mcp__") ||
        ["run_command", "write_file", "edit_file"].includes(slot.call.function.name)
      );

    const runOne = async (slot: { call: ToolCall; result: ToolResult }): Promise<string> => {
      const { call, result } = slot;
      const name = call.function.name;
      const rawArgs = call.function.arguments || "{}";
      // 确认弹窗的来源标注：手动会话用它的标题
      const context = options.sessionTitle;

      // 只读模式下即使模型硬要调用被禁的工具，也在这里挡住；
      // MCP 工具能力未知，只读模式一律不给
      const isMcp = name.startsWith("mcp__");
      const memoryWriteOnly =
        name === "memory" &&
        mode === "readonly" &&
        parseArgs(rawArgs).action !== "list";
      if (memoryWriteOnly || (isMcp ? mode === "readonly" : !permission.tools.includes(name))) {
        result.ok = false;
        result.output = `现在是「${permission.label}」模式，不能调用 ${name}。需要的话请用户切到「标准」或「放开」。`;
        result.status = "done";
        push();
        return result.output;
      }

      // 安全防护：标准模式必须有人工确认回调。定时任务没传回调，
      // 若放行就等于无人确认地跑命令/改文件——直接拒绝并指路
      const needsGate =
        name === "run_command" || name === "write_file" || name === "edit_file" || isMcp;
      if (needsGate && mode === "standard" && !options.requestApproval) {
        result.ok = false;
        result.output = `这是后台任务，「标准」模式下不能${name === "run_command" ? "执行命令" : "修改文件"}（没有人在旁边确认）。请把任务的权限模式改成「只读」或「放开」。`;
        result.status = "done";
        push();
        return result.output;
      }

      // 标准模式：命令和文件改动都要先过用户这一关；放开模式直接跑
      if (mode === "standard" && options.requestApproval) {
        const needsAsk =
          name === "run_command" || name === "write_file" || name === "edit_file" || isMcp;
        if (needsAsk) {
          let diff: DiffData | undefined;
          if (name !== "run_command") {
            diff = await previewDiff(name, parseArgs(rawArgs), workspace);
          }
          const approved = await options.requestApproval({
            name,
            summary: result.args,
            diff,
            context,
          });
          if (!approved) {
            result.ok = false;
            result.output = `用户拒绝了这次${name === "run_command" ? "命令执行" : "文件修改"}，没有执行。请换个思路，或者先跟用户确认再继续。`;
            result.status = "done";
            push();
            return result.output;
          }
        }
      }

      const parsed = parseArgs(rawArgs);
      const argError = name.startsWith("mcp__") ? null : validateArgs(name, parsed);
      if (argError) {
        result.ok = false;
        result.output = `参数不合法：${argError}。请修正后重新调用。`;
        result.status = "done";
        push();
        return result.output;
      }

      const outcome = await executeTool(name, parsed, workspace, {
        runId: call.id,
        onOutput: (line) => {
          // 命令边跑边显示，跑完再用完整输出覆盖
          result.output = result.output ? `${result.output}\n${line}` : line;
          push();
        },
        onTodos: (items) => {
          options.onTodos?.(items);
          result.output = `清单已更新（共 ${items.length} 项，已完成 ${items.filter((t) => t.status === "done").length}）`;
          push();
        },
      });

      result.ok = outcome.ok;
      result.output = outcome.output;
      result.status = "done";
      push();

      // edit_file 撞上空白的差异时，替模型把当前文件读回来，下一轮直接照着重试
      if (
        !outcome.ok &&
        name === "edit_file" &&
        /没找到要替换的内容|出现了 \d+ 次/.test(outcome.output) &&
        typeof parsed.path === "string"
      ) {
        const reread = await executeTool(
          "read_file",
          { path: parsed.path, offset: 1, limit: 400 },
          workspace,
          { runId: call.id, onOutput: () => {} }
        );
        if (reread.ok) {
          result.output = `${outcome.output}\n\n【自动重读：${parsed.path} 的当前内容，照它重试 edit_file】\n${reread.output}`;
          push();
          return result.output;
        }
      }

      return outcome.output;
    };

    if (needsConfirm) {
      for (const slot of slots) {
        if (isAborted()) return;
        const content = await runOne(slot);
        apiMessages.push({ role: "tool", tool_call_id: slot.call.id, content });
      }
    } else {
      const contents = await Promise.all(slots.map((slot) => runOne(slot)));
      slots.forEach((slot, index) => {
        apiMessages.push({ role: "tool", tool_call_id: slot.call.id, content: contents[index] });
      });
    }

    if (isAborted()) return;

    // 刚才这一批改了文件？记下来，稍后统一跑一次验证
    if (
      slots.some(
        (slot) =>
          slot.result.ok && ["write_file", "edit_file"].includes(slot.call.function.name)
      )
    ) {
      dirty = true;
    }

    // 自动验证：改完就跑 typecheck/build，把结果塞回上下文让模型自己修
    if (dirty && verifyRuns < 3 && mode !== "readonly" && settings.autoVerify !== false) {
      const cmd = await invoke<string | null>("verify_command", { root: workspace }).catch(
        () => null
      );
      if (cmd) {
        dirty = false;
        verifyRuns += 1;
        const verifyCall: ToolCall = {
          id: `call_verify_${newId()}`,
          type: "function",
          function: {
            name: "run_command",
            arguments: JSON.stringify({ command: cmd, timeout_sec: 180 }),
          },
        };
        const verifyResult: ToolResult = {
          toolCallId: verifyCall.id,
          name: "run_command",
          args: `自动验证 · ${cmd}`,
          output: "",
          ok: true,
          status: "running",
        };
        allToolCalls.push(verifyCall);
        allToolResults.push(verifyResult);
        parts.push({ kind: "tools", id: newId(), callIds: [verifyCall.id] });
        push();

        const checked = await executeTool(
          "run_command",
          { command: cmd, timeout_sec: 180 },
          workspace,
          {
            runId: verifyCall.id,
            onOutput: (line) => {
              verifyResult.output = verifyResult.output
                ? `${verifyResult.output}\n${line}`
                : line;
              push();
            },
          }
        );
        verifyResult.ok = checked.ok;
        verifyResult.output = checked.output || (checked.ok ? "验证通过（无输出）" : "验证失败");
        verifyResult.status = "done";
        push();

        apiMessages.push({
          role: "assistant",
          content: null,
          tool_calls: [verifyCall],
        });
        apiMessages.push({
          role: "tool",
          tool_call_id: verifyCall.id,
          content: checked.ok
            ? `自动验证通过（${cmd}）\n${verifyResult.output.slice(-1500)}`
            : `自动验证失败（${cmd}），请根据报错继续修\n${verifyResult.output.slice(-3000)}`,
        });
        if (isAborted()) return;
      }
    }

    // 死循环检测：同一组「工具 + 参数」重复调用，说明模型在原地打转
    let worstRepeat = 0;
    for (const call of calls) {
      const sig = `${call.function.name}:${call.function.arguments ?? ""}`;
      const hits = (callCounts.get(sig) ?? 0) + 1;
      callCounts.set(sig, hits);
      worstRepeat = Math.max(worstRepeat, hits);
    }
    if (worstRepeat >= 6) {
      forceText = true;
      apiMessages.push({
        role: "user",
        content:
          "【原地打转】同一组工具调用已经重复多次，再调也不会得到新信息。这一轮不能再调工具，请直接给出当前结论和下一步建议。",
      });
    } else if (worstRepeat === 3) {
      apiMessages.push({
        role: "user",
        content:
          "【重复调用提醒】你刚才用完全相同的参数调用了同一个工具，结果不会变。换个思路：换参数、换工具，或者直接基于现有信息给结论。",
      });
    }
  }

  if (!parts.some((part) => part.kind === "text" && part.text.trim())) {
    onAssistant({
      content:
        "这次任务跑到了硬上限还没收敛（正常任务碰不到）。直接回复「继续」即可接着上次的进度往下做。",
      parts: [
        ...parts,
        {
          kind: "text",
          id: newId(),
          text:
            "这次任务跑到了硬上限还没收敛（正常任务碰不到）。直接回复「继续」即可接着上次的进度往下做。",
        },
      ],
      toolCalls: [...allToolCalls],
      toolResults: allToolResults.map((result) => ({ ...result })),
    });
  } else {
    push();
  }
}
