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
7. 不要输出「我将要调用工具」这类空话，直接调用。`;

export function buildSystemPrompt(
  settings: Settings,
  workspace: string,
  mode?: AgentMode,
  guide?: string
): string {
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  let prompt = DEFAULT_SYSTEM.replace("{{WORKSPACE}}", workspace || "（未设置）").replace(
    "{{NOW}}",
    now
  );
  if (mode) {
    const info = modeInfo(mode);
    prompt += `\n\n当前权限模式：${info.label} —— ${info.desc}`;
  }
  if (guide) {
    prompt += `\n\n这个项目的约定（来自工作目录里的约定文件，必须遵守）：\n${guide}`;
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
  todos?: { content: string; status: "pending" | "in_progress" | "done" }[]
): ApiMessage[] {
  let system = buildSystemPrompt(settings, workspace, mode, guide);
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

  const budget = Math.max(4000, settings.contextBudget || 24000);
  const rawMessages = toApiMessages(
    options.history,
    settings,
    workspace,
    mode,
    guide,
    skillList,
    memoryNote || undefined,
    options.todos
  );
  const totalCost = rawMessages.reduce((sum, msg) => sum + messageCost(msg), 0);
  const apiMessages =
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
  const maxRounds = Math.max(1, settings.maxRounds);
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

  for (let round = 0; round < maxRounds; round++) {
    if (isAborted()) return;

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
        tools: [
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

    const calls = done.toolCalls.filter((call) => call?.function?.name);
    if (calls.length === 0) {
      // 既没正文也没工具调用，多半是模型抽风，自动重试一次
      if (!roundText.trim() && emptyRetries < 2 && !isAborted()) {
        emptyRetries += 1;
        continue;
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
  }

  if (!parts.some((part) => part.kind === "text" && part.text.trim())) {
    onAssistant({
      content: `已经连续调用 ${maxRounds} 轮工具还没得出结论。可以在设置里调高轮数上限，或者把任务拆小一点。`,
      parts: [
        ...parts,
        {
          kind: "text",
          id: newId(),
          text: `已经连续调用 ${maxRounds} 轮工具还没得出结论。可以在设置里调高轮数上限，或者把任务拆小一点。`,
        },
      ],
      toolCalls: [...allToolCalls],
      toolResults: allToolResults.map((result) => ({ ...result })),
    });
  } else {
    push();
  }
}
