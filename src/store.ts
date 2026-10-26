import { invoke } from "@tauri-apps/api/core";
import type { Schedule, Session, Settings } from "./types";

const SESSION_KEY = "xiaozhou.sessions.v1";
const SETTINGS_KEY = "xiaozhou.settings.v1";
const ACTIVE_KEY = "xiaozhou.active.v1";

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-chat",
  modelList: [],
  temperature: 0.7,
  workspace: "",
  defaultMode: "standard",
  contextBudget: 32000,
  taskMinutes: 15,
  autoContinue: true,
  toggleShortcut: "alt+space",
  fontSize: 15,
  fontFamily: "default",
};

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function createSession(): Session {
  const now = Date.now();
  return {
    id: newId(),
    title: "新的对话",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略配额错误 */
  }
}

function normalize(s: Session): Session {
  return { ...s, messages: Array.isArray(s.messages) ? s.messages : [] };
}

/**
 * 会话存到磁盘（%APPDATA%/xiaozhou/sessions.json），清缓存、换机拷文件都不丢。
 * 磁盘为空但 localStorage 里有旧数据时自动迁移；invoke 失败（比如在纯浏览器里调试）退回 localStorage。
 */
export async function loadSessions(): Promise<{ sessions: Session[]; activeId: string | null }> {
  let disk: { sessions: Session[]; activeId: string | null } | null = null;
  try {
    const data = await invoke<{ sessions: Session[]; activeId: string | null }>("load_sessions");
    if (Array.isArray(data?.sessions) && data.sessions.length > 0) {
      disk = { sessions: data.sessions.map(normalize), activeId: data.activeId ?? null };
    }
  } catch {
    /* 走降级 */
  }

  if (disk) return disk;

  // 迁移：localStorage 里的老数据搬到磁盘
  const legacy = readJson<Session[]>(SESSION_KEY, []);
  if (legacy.length > 0) {
    const list = legacy.map(normalize);
    const active = localStorage.getItem(ACTIVE_KEY);
    void invoke("save_sessions", { sessions: list, activeId: active }).catch(() => {});
    return { sessions: list, activeId: active };
  }

  return { sessions: [], activeId: null };
}

export function saveSessions(sessions: Session[], activeId: string) {
  void invoke("save_sessions", { sessions, activeId }).catch(() => {});
}

export function loadSettings(): Settings {
  const raw = readJson<Partial<Settings> & { autoApprove?: boolean }>(SETTINGS_KEY, {});
  const merged: Settings = { ...DEFAULT_SETTINGS, ...raw };
  // 老版本只有一个 autoApprove 开关，迁移成模式：开=放开，关=标准
  if (!raw.defaultMode && typeof raw.autoApprove === "boolean") {
    merged.defaultMode = raw.autoApprove ? "yolo" : "standard";
  }
  delete (merged as { autoApprove?: boolean }).autoApprove;
  // 轮数上限已改成内部兜底（不再让用户配），老数据里的 maxRounds 直接忽略
  delete (merged as { maxRounds?: number }).maxRounds;
  // 24000 是旧版默认上下文预算，读代码类任务太容易触发压缩；同样跟着升
  if (!("contextBudget" in raw) || raw.contextBudget === 24000) {
    merged.contextBudget = DEFAULT_SETTINGS.contextBudget;
  }
  // 老数据没有常用模型列表：把当前模型放进去，保证切换菜单非空
  if (!Array.isArray(merged.modelList)) {
    merged.modelList = merged.model ? [merged.model] : [];
  }
  return merged;
}

export function saveSettings(settings: Settings) {
  writeJson(SETTINGS_KEY, settings);
}

/* ---------- 定时任务（磁盘存储，与应用内生效的范围一致） ---------- */

export async function loadSchedules(): Promise<Schedule[]> {
  try {
    const data = await invoke<{ schedules: Schedule[] }>("load_schedules");
    if (Array.isArray(data?.schedules)) return data.schedules;
  } catch {
    /* 没有文件就是没有任务 */
  }
  return [];
}

export function saveSchedules(schedules: Schedule[]) {
  void invoke("save_schedules", { schedules }).catch(() => {});
}

/** 计算下一次执行时间 */
export function nextRunOf(schedule: Schedule, from = Date.now()): number {
  if (schedule.schedule.kind === "interval") {
    return from + schedule.schedule.minutes * 60_000;
  }
  // daily：今天的 time 已过就排到明天
  const [h, m] = schedule.schedule.time.split(":").map(Number);
  const next = new Date(from);
  next.setHours(h || 0, m || 0, 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function loadActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}

/** 用首条用户消息做会话标题 */
export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "新的对话";
  return clean.length > 24 ? clean.slice(0, 24) + "…" : clean;
}
