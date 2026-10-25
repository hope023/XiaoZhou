export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  args: string;
  output: string;
  ok: boolean;
  status: "running" | "done";
}

/** 助手消息里按真实顺序排列的片段：一段话、一轮工具调用、或模型思考 */
export type MessagePart =
  | { kind: "text"; id: string; text: string }
  | { kind: "tools"; id: string; callIds: string[] }
  | { kind: "reasoning"; id: string; text: string };

/** 本轮请求的 token 消耗（来自接口的 usage 字段） */
export interface UsageInfo {
  prompt?: number;
  completion?: number;
  total?: number;
}

/** @ 引用的文件内容，发给模型时拼在消息后面 */
export interface Attachment {
  path: string;
  content: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 展示顺序（仅 assistant 消息），没有时回退到 content + toolResults */
  parts?: MessagePart[];
  /** 本消息触发的工具调用与执行结果（仅 assistant 消息） */
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  error?: string;
  /** 用户消息带的图片（data URL），仅 role=user */
  images?: string[];
  /** 用户消息 @ 引用的文件，仅 role=user */
  attachments?: Attachment[];
  /** 最后一轮请求的 token 消耗，仅 assistant 消息 */
  usage?: UsageInfo | null;
  createdAt: number;
}

/** diff 预览的行级数据 */
export interface DiffRow {
  type: "same" | "add" | "del";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffData {
  path: string;
  rows: DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
}

/** 只读：只能看；标准：能改但命令要确认；放开：全自动 */
export type AgentMode = "readonly" | "standard" | "yolo";

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  /** 这个对话自己的工作目录；没设过就用设置里的默认目录 */
  workspace?: string;
  /** 这个对话的权限模式；没设过就用设置里的默认模式 */
  mode?: AgentMode;
  /** 置顶的对话排在分组最前 */
  pinned?: boolean;
  /** 定时任务产生的对话 */
  source?: "schedule";
  scheduleId?: string;
  createdAt: number;
  updatedAt: number;
}

/** 应用内定时任务：应用开着才执行，关闭即暂停 */
export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  /** 相对工作目录或绝对路径；空则用设置里的默认目录 */
  workspace: string;
  /** 静默执行用的权限模式；定时任务建议只读或标准 */
  mode: AgentMode;
  /** interval = 每 N 分钟一次；daily = 每天固定时刻 */
  schedule:
    | { kind: "interval"; minutes: number }
    | { kind: "daily"; time: string };
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  /** 最近一次执行的结果摘要（通知用） */
  lastStatus?: "ok" | "fail" | "running";
  /** 上次运行产生的会话，用于跳转查看 */
  lastRunSessionId?: string;
  createdAt: number;
}

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 常用模型列表，供输入框右下角快速切换 */
  modelList: string[];
  temperature: number;
  workspace: string;
  defaultMode: AgentMode;
  /** 发给模型的上下文预算（近似 token 数） */
  contextBudget: number;
  maxRounds: number;
}

/** 多模态内容块：文本或图片（data URL） */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ApiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
