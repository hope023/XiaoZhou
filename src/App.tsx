import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "./assets/logo.png";
import { Composer } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ContextMenu, type CtxMenuItem } from "./components/ContextMenu";
import { MessageItem } from "./components/MessageItem";
import { SessionTools } from "./components/SessionTools";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { runAgent } from "./agent";
import { dateLocale, setLocale, tr, useLocale } from "./i18n";
import {
  createSession,
  deriveTitle,
  loadSchedules,
  loadSessions,
  loadSettings,
  newId,
  nextRunOf,
  saveSessions,
  saveSchedules,
  saveSettings,
} from "./store";
import type {
  AgentMode,
  ChatMessage,
  DiffData,
  Schedule,
  Session,
  Settings,
} from "./types";

function fmtK(n?: number): string {
  if (!n) return "0";
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

const SUGGESTIONS = [
  "看看当前目录里有什么",
  "帮我读一下 README，说说这个项目是干嘛的",
  "列出最近改过的文件",
];

/** 从消息文本里抽 @ 引用的文件路径，读出内容作为附件（最多 5 个） */
async function expandRefs(text: string, workspace: string) {
  const paths = [...new Set([...text.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1]))].slice(0, 5);
  if (paths.length === 0) return [];
  const attachments: { path: string; content: string }[] = [];
  for (const path of paths) {
    try {
      const content = await invoke<string>("read_reference", { root: workspace, path });
      attachments.push({ path, content });
    } catch {
      /* 不存在的引用就忽略 */
    }
  }
  return attachments;
}

/** 对输入框替换选区并让 React 感知（setRangeText 不触发 input 事件，需手动派发） */
function setEditableValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  start: number,
  end: number
) {
  el.focus();
  el.setRangeText(value, start, end, "end");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 按右键位置上下文组装菜单项；返回空数组表示只拦截不弹菜单 */
function buildContextMenu(event: MouseEvent): CtxMenuItem[] {
  const target = event.target as HTMLElement;
  const items: CtxMenuItem[] = [];
  const editable = target.closest("input, textarea") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;

  // 1. 输入框 / 文本域：剪切、复制、粘贴、全选
  if (editable && !editable.readOnly && !editable.disabled) {
    const start = editable.selectionStart ?? 0;
    const end = editable.selectionEnd ?? 0;
    const selected = editable.value.slice(start, end);
    const tail = editable.value.length;
    items.push(
      {
        label: tr("剪切"),
        shortcut: "Ctrl+X",
        disabled: !selected,
        action: () => {
          void writeText(selected);
          setEditableValue(editable, "", start, end);
        },
      },
      {
        label: tr("复制"),
        shortcut: "Ctrl+C",
        disabled: !selected,
        action: () => void writeText(selected),
      },
      {
        label: tr("粘贴"),
        shortcut: "Ctrl+V",
        action: () => {
          void readText()
            .then((text) => {
              if (text) {
                setEditableValue(editable, text, editable.selectionStart ?? tail, editable.selectionEnd ?? tail);
              }
            })
            .catch(() => {});
        },
      },
      {
        label: tr("全选"),
        shortcut: "Ctrl+A",
        disabled: !editable.value,
        action: () => {
          editable.focus();
          editable.select();
        },
      }
    );
    return items;
  }

  // 2. 链接：在浏览器打开、复制地址
  const link = target.closest(".md-link") as HTMLElement | null;
  const href = link?.dataset.href;
  if (href) {
    items.push(
      { label: tr("在浏览器打开"), action: () => void openUrl(href).catch(() => {}) },
      { label: tr("复制链接地址"), action: () => void writeText(href) }
    );
  }

  // 3. 代码块：整体复制
  const codeWrap = target.closest(".md-code-wrap");
  if (codeWrap) {
    const code = codeWrap.querySelector("code")?.textContent ?? "";
    if (code) {
      items.push({ label: tr("复制代码"), action: () => void writeText(code) });
    }
  }

  // 4. 有选区：复制选中文字
  const selection = window.getSelection()?.toString();
  if (selection) {
    items.push({
      label: "复制",
      shortcut: "Ctrl+C",
      action: () => void writeText(selection),
    });
  }

  // 5. 消息区域且没有更具体的动作：复制整条消息文本
  if (items.length === 0) {
    const msg = target.closest(".msg");
    if (msg) {
      const text =
        msg.querySelector(".msg-bubble")?.textContent ??
        [...msg.querySelectorAll(".md")].map((node) => node.textContent).join("\n\n");
      if (text.trim()) {
        items.push({ label: tr("复制消息"), action: () => void writeText(text) });
      }
    }
  }

  return items;
}

/** 发系统通知：定时任务完成/失败时提醒 */
async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<string[]>([]);
  /** 哪些会话正在流式执行——多会话并行的基础 */
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  useLocale();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CtxMenuItem[] } | null>(
    null
  );

  // 右键统一接管：屏蔽 WebView2 默认浏览器菜单，按上下文弹应用菜单
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const items = buildContextMenu(event);
      setCtxMenu(items.length ? { x: event.clientX, y: event.clientY, items } : null);
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
  /** 打开设置面板时直接落到哪个页签 */
  const [initialTab, setInitialTab] = useState<"general" | "model" | "schedule" | "mcp">("general");
  /** 拖进窗口的文件，作为附件随下一条消息发出 */
  const [dragAttachments, setDragAttachments] = useState<{ path: string; content: string }[]>([]);
  const [maximized, setMaximized] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    summary: string;
    diff?: DiffData;
    context?: string;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const abortMapRef = useRef(new Map<string, boolean>());
  const stickRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find((item) => item.id === activeId);
  // 会话自己设过就用会话的，否则落到设置里的默认目录
  const workspace = activeSession?.workspace || settings.workspace || "";
  const mode = activeSession?.mode || settings.defaultMode;
  const streaming = streamingIds.has(activeId);

  const setSessionStreaming = useCallback((id: string, on: boolean) => {
    setStreamingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /* ---------- 初始化 ---------- */

  // 会话和定时任务都从磁盘加载
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSessions(), loadSchedules()])
      .then(([sessionData, scheduleList]) => {
        if (cancelled) return;
        const list = sessionData.sessions.length > 0 ? sessionData.sessions : [createSession()];
        setSessions(list);
        setActiveId(
          sessionData.activeId && list.some((item) => item.id === sessionData.activeId)
            ? sessionData.activeId
            : list[0].id
        );
        setSchedules(scheduleList);
      })
      .catch(() => {
        if (cancelled) return;
        const fresh = [createSession()];
        setSessions(fresh);
        setActiveId(fresh[0].id);
      })
      .finally(() => {
        if (!cancelled) setBooted(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    win.show().catch(() => {});
    win.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    // 拖文件进窗口 = 直接引用它
    const unlistenDrag = win.onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      for (const path of event.payload.paths) {
        invoke<{ path: string; content: string }>("read_reference", { root: workspace, path })
          .then((attachment) =>
            setDragAttachments((prev) =>
              prev.some((a) => a.path === attachment.path) ? prev : [...prev, attachment]
            )
          )
          .catch(() => {
            void notify(tr("没能引用这个文件"), path);
          });
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
      unlistenDrag.then((fn) => fn()).catch(() => {});
    };
    // workspace 变化时重挂（read_reference 依赖它）
  }, [workspace]);

  /* ---------- 全局呼出快捷键（按设置注册，改动即重挂） ---------- */

  const toggleMainWindow = useCallback(async () => {
    const win = getCurrentWindow();
    const visible = await win.isVisible().catch(() => false);
    const focused = await win.isFocused().catch(() => false);
    if (visible && focused) {
      await win.hide().catch(() => {});
    } else {
      await win.unminimize().catch(() => {});
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
    }
  }, []);

  const shortcutRef = useRef("");
  useEffect(() => {
    const desired = (settings.toggleShortcut || "").trim().toLowerCase() || "alt+space";
    if (shortcutRef.current === desired) return;
    const apply = async () => {
      if (shortcutRef.current) {
        await unregister(shortcutRef.current).catch(() => {});
        shortcutRef.current = "";
      }
      try {
        await register(desired, (event) => {
          if (event.state === "Pressed") void toggleMainWindow();
        });
        shortcutRef.current = desired;
      } catch (error) {
        void notify(
          tr("快捷键注册失败"),
          `${desired}：${error instanceof Error ? error.message : String(error)}`
        );
      }
    };
    void apply();
  }, [settings.toggleShortcut, toggleMainWindow]);

  // 首次启动给个默认工作目录
  useEffect(() => {
    if (settings.workspace) return;
    invoke<string>("default_workspace")
      .then((home) => {
        setSettings((prev) => (prev.workspace ? prev : { ...prev, workspace: home }));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // 字体大小：以 14px 为基准整体缩放界面（页面级 zoom，文字、图标一起缩放，渲染清晰）
  useEffect(() => {
    const scale = Math.max(0.85, Math.min(1.6, (settings.fontSize || 14) / 14));
    document.documentElement.style.zoom = String(scale);
  }, [settings.fontSize]);

  // 字体样式：得意黑通过 html class 切换，CSS 里接管界面字体
  useEffect(() => {
    document.documentElement.classList.toggle("font-smiley", settings.fontFamily === "smiley");
  }, [settings.fontFamily]);

  // 界面语言：切换后立刻重渲染所有文案
  useEffect(() => {
    setLocale(settings.language ?? "zh-CN");
  }, [settings.language]);

  useEffect(() => {
    if (!booted || !activeId) return;
    const timer = setTimeout(() => saveSessions(sessions, activeId), 400);
    return () => clearTimeout(timer);
  }, [sessions, activeId, booted]);

  useEffect(() => {
    if (!booted) return;
    saveSchedules(schedules);
  }, [schedules, booted]);

  // 流式输出时贴住底部
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [activeSession?.messages]);

  /* ---------- 会话操作 ---------- */

  const patchMessage = useCallback(
    (sessionId: string, messageId: string, patch: Partial<ChatMessage>) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id !== sessionId
            ? session
            : {
                ...session,
                updatedAt: Date.now(),
                messages: session.messages.map((message) =>
                  message.id === messageId ? { ...message, ...patch } : message
                ),
              }
        )
      );
    },
    []
  );

  const newSession = useCallback(() => {
    const fresh = createSession();
    // 在同一个项目里连着开新对话时，继承当前目录，省得每次重选
    if (activeSession?.workspace) fresh.workspace = activeSession.workspace;
    setSessions((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setDraft("");
  }, [activeSession]);

  // 只改当前对话的目录，不动设置里的默认值
  const setSessionWorkspace = useCallback(
    (path: string | undefined) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeId
            ? { ...session, workspace: path, updatedAt: Date.now() }
            : session
        )
      );
    },
    [activeId]
  );

  const setSessionMode = useCallback(
    (next: AgentMode) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeId ? { ...session, mode: next, updatedAt: Date.now() } : session
        )
      );
    },
    [activeId]
  );

  // 工具卡片上的「撤销」：回滚最近一次文件改动，并把结果写回那张卡片
  const handleUndo = useCallback(
    async (sessionId: string, messageId: string, toolCallId: string) => {
      let note = "";
      try {
        const outcome = await invoke<{ ok: boolean; output: string }>("run_tool", {
          name: "undo_last",
          args: {},
          root: workspace,
        });
        note = outcome.ok ? `↩ ${outcome.output}` : `↩ 撤销失败：${outcome.output}`;
      } catch (error) {
        note = `↩ 撤销出错：${error instanceof Error ? error.message : String(error)}`;
      }

      setSessions((prev) =>
        prev.map((session) =>
          session.id !== sessionId
            ? session
            : {
                ...session,
                messages: session.messages.map((message) =>
                  message.id !== messageId
                    ? message
                    : {
                        ...message,
                        toolResults: (message.toolResults ?? []).map((result) =>
                          result.toolCallId === toolCallId
                            ? { ...result, output: `${result.output}\n\n${note}` }
                            : result
                        ),
                      }
                ),
              }
        )
      );
    },
    [workspace]
  );

  const requestApproval = useCallback(
    (info: { name: string; summary: string; diff?: DiffData; context?: string }) =>
      new Promise<boolean>((resolve) => {
        // 之前勾过「不再询问」的命令直接放行（命令与 MCP 工具按精确摘要匹配；文件改动不记）
        if ((info.name === "run_command" || info.name.startsWith("mcp__")) && !info.diff) {
          try {
            const remembered: string[] = JSON.parse(
              localStorage.getItem("xiaozhou.approved.v1") || "[]"
            );
            if (remembered.includes(info.summary)) {
              resolve(true);
              return;
            }
          } catch {
            /* 忽略 */
          }
        }
        setPendingApproval({
          summary: info.summary,
          diff: info.diff,
          context: info.context,
          resolve,
        });
      }),
    []
  );

  const settleApproval = useCallback(
    (approved: boolean, remember = false) => {
      setPendingApproval((current) => {
        if (current?.resolve) current.resolve(approved);
        if (approved && remember && current) {
          try {
            const remembered: string[] = JSON.parse(
              localStorage.getItem("xiaozhou.approved.v1") || "[]"
            );
            if (!remembered.includes(current.summary)) {
              remembered.push(current.summary);
              localStorage.setItem("xiaozhou.approved.v1", JSON.stringify(remembered.slice(-50)));
            }
          } catch {
            /* 忽略 */
          }
        }
        return null;
      });
    },
    []
  );

  const deleteSession = useCallback(
    (id: string) => {
      // 删除正在跑的会话要先停掉它
      if (streamingIds.has(id)) {
        abortMapRef.current.set(id, true);
        setSessionStreaming(id, false);
      }
      setSessions((prev) => {
        const next = prev.filter((session) => session.id !== id);
        if (next.length === 0) {
          const fresh = createSession();
          setActiveId(fresh.id);
          return [fresh];
        }
        if (id === activeId) setActiveId(next[0].id);
        return next;
      });
    },
    [activeId, setSessionStreaming, streamingIds]
  );

  /* ---------- 发送 ---------- */

  const send = useCallback(
    async (text: string, baseMessages?: ChatMessage[]) => {
      const content = text.trim();
      if (!content || streamingIds.has(activeId)) return;

      const sessionId = activeId;
      const history = baseMessages ?? activeSession?.messages ?? [];
      // @ 引用的文件在发送时展开成附件，界面只显示 @路径
      const attachments = [...dragAttachments, ...(await expandRefs(content, workspace))];
      const userMessage: ChatMessage = {
        id: newId(),
        role: "user",
        content,
        ...(images.length > 0 ? { images: [...images] } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        createdAt: Date.now(),
      };
      const assistantMessage: ChatMessage = {
        id: newId(),
        role: "assistant",
        content: "",
        createdAt: Date.now(),
      };

      setSessions((prev) =>
        prev.map((session) =>
          session.id !== sessionId
            ? session
            : {
                ...session,
                title: session.messages.length === 0 ? deriveTitle(content) : session.title,
                updatedAt: Date.now(),
                messages: [...session.messages, userMessage, assistantMessage],
              }
        )
      );

      setDraft("");
      setImages([]);
      setDragAttachments([]);
      setSessionStreaming(sessionId, true);
      abortMapRef.current.set(sessionId, false);
      stickRef.current = true;

      try {
        await runAgent({
          history: [...history, userMessage],
          settings,
          workspace,
          mode,
          sessionTitle: activeSession?.title || "新对话",
          todos: activeSession?.todos,
          isAborted: () => abortMapRef.current.get(sessionId) ?? false,
          onAssistant: (patch) => patchMessage(sessionId, assistantMessage.id, patch),
          onTodos: (items) =>
            setSessions((prev) =>
              prev.map((session) =>
                session.id === sessionId ? { ...session, todos: items } : session
              )
            ),
          requestApproval,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        patchMessage(sessionId, assistantMessage.id, { error: message });
      } finally {
        setSessionStreaming(sessionId, false);
        abortMapRef.current.delete(sessionId);
      }
    },
    [
      activeId,
      activeSession,
      patchMessage,
      requestApproval,
      settings,
      streamingIds,
      workspace,
      mode,
      images,
      dragAttachments,
      setSessionStreaming,
    ]
  );

  const stop = useCallback(() => {
    abortMapRef.current.set(activeId, true);
    setSessionStreaming(activeId, false);
    settleApproval(false);
  }, [activeId, setSessionStreaming, settleApproval]);

  /** 重新生成：砍掉这条回复及其后的内容，用同一条提问重发 */
  const regenerate = useCallback(
    (messageId: string) => {
      if (streaming || !activeSession) return;
      const list = activeSession.messages;
      const idx = list.findIndex((item) => item.id === messageId);
      if (idx < 0) return;
      let userIdx = idx - 1;
      while (userIdx >= 0 && list[userIdx].role !== "user") userIdx--;
      if (userIdx < 0) return;

      const text = list[userIdx].content;
      const before = list.slice(0, userIdx);
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeId ? { ...session, messages: before } : session
        )
      );
      setTimeout(() => send(text, before), 30);
    },
    [activeSession, activeId, send, streaming]
  );

  /** 编辑：把这条提问放回输入框，并删掉它之后的所有内容 */
  const editMessage = useCallback(
    (messageId: string) => {
      if (streaming || !activeSession) return;
      const list = activeSession.messages;
      const idx = list.findIndex((item) => item.id === messageId);
      if (idx < 0) return;
      setDraft(list[idx].content);
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeId ? { ...session, messages: list.slice(0, idx) } : session
        )
      );
    },
    [activeSession, activeId, streaming]
  );

  /** 会话分支：复制这条提问（含）之前的历史，开一个新会话继续 */
  const branchFrom = useCallback(
    (messageId: string) => {
      if (!activeSession) return;
      const idx = activeSession.messages.findIndex((item) => item.id === messageId);
      if (idx < 0) return;
      const now = Date.now();
      const fresh: Session = {
        ...createSession(),
        title: `${activeSession.title} · 分支`,
        workspace: activeSession.workspace,
        mode: activeSession.mode,
        messages: activeSession.messages.slice(0, idx + 1).map((m) => ({ ...m, id: newId() })),
        createdAt: now,
        updatedAt: now,
      };
      setSessions((prev) => [fresh, ...prev]);
      setActiveId(fresh.id);
    },
    [activeSession]
  );

  /** 导出会话为 Markdown 文件 */
  const exportSession = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      const md = [
        `# ${session.title}`,
        "",
        tr("> 导出于 {time} · 工作目录 {dir}", {
          time: new Date().toLocaleString(dateLocale(), { hour12: false }),
          dir: session.workspace || settings.workspace || tr("未设置"),
        }),
        "",
        ...session.messages.map((message) =>
          message.role === "user"
            ? `## ${tr("🧑 我")}\n\n${message.content}\n`
            : `## ${tr("🤖 小舟")}\n\n${message.error ? tr("（出错：{msg}）", { msg: message.error }) + "\n\n" : ""}${message.content || tr("（执行了工具调用，见下）")}\n${
                (message.toolResults ?? [])
                  .map((r) => `\n<details><summary>${r.name}：${r.args}</summary>\n\n\`\`\`\n${r.output}\n\`\`\`\n</details>`)
                  .join("\n")
              }\n`
        ),
      ].join("\n");

      try {
        const path = await save({
          defaultPath: `${session.title.replace(/[\\/:*?"<>|]/g, "_")}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (!path) return;
        await invoke("write_export", { path, content: md });
        notify(tr("导出完成"), path);
      } catch (error) {
        notify(tr("导出失败"), error instanceof Error ? error.message : String(error));
      }
    },
    [sessions, settings.workspace]
  );

  /* ---------- 定时任务 ---------- */

  /** 静默执行一个定时任务：开独立会话跑 runAgent，完成后系统通知 */
  const runSchedule = useCallback(
    async (schedule: Schedule) => {
      const ws = schedule.workspace || settings.workspace || "";
      const sid = newId();
      const now = Date.now();
      const userMessage: ChatMessage = { id: newId(), role: "user", content: schedule.prompt, createdAt: now };
      const assistantMessage: ChatMessage = { id: newId(), role: "assistant", content: "", createdAt: now };
      const fresh: Session = {
        id: sid,
        title: `⏰ ${schedule.name}`,
        workspace: ws || undefined,
        mode: schedule.mode,
        source: "schedule",
        scheduleId: schedule.id,
        messages: [userMessage, assistantMessage],
        createdAt: now,
        updatedAt: now,
      };

      setSessions((prev) => [fresh, ...prev]);
      // 触发时就排好下一次，执行再慢也不影响节奏
      const upcoming = nextRunOf(schedule, now);
      setSchedules((prev) =>
        prev.map((item) =>
          item.id === schedule.id
            ? { ...item, lastRun: now, nextRun: upcoming, lastStatus: "running", lastRunSessionId: sid }
            : item
        )
      );

      setSessionStreaming(sid, true);
      abortMapRef.current.set(sid, false);
      let failed: string | null = null;
      try {
        await runAgent({
          history: [userMessage],
          settings,
          workspace: ws,
          mode: schedule.mode,
          isAborted: () => abortMapRef.current.get(sid) ?? false,
          onAssistant: (patch) => patchMessage(sid, assistantMessage.id, patch),
        });
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error);
        patchMessage(sid, assistantMessage.id, { error: failed });
      } finally {
        setSessionStreaming(sid, false);
        abortMapRef.current.delete(sid);
        setSchedules((prev) =>
          prev.map((item) =>
            item.id === schedule.id ? { ...item, lastStatus: failed ? "fail" : "ok" } : item
          )
        );
        void notify(
          tr("定时任务：{name}", { name: schedule.name }),
          failed
            ? tr("执行失败：{msg}", { msg: failed.slice(0, 120) })
            : tr("执行完成，点开「小舟」查看结果")
        );
      }
    },
    [settings, patchMessage, setSessionStreaming]
  );

  // 到期检查循环：只在应用开着时生效
  const scheduleCheckRef = useRef<() => void>(() => {});
  scheduleCheckRef.current = () => {
    const due = schedules.filter(
      (item) => item.enabled && item.lastStatus !== "running" && (item.nextRun ?? 0) <= Date.now()
    );
    for (const schedule of due) {
      void runSchedule(schedule);
    }
  };
  useEffect(() => {
    const timer = setInterval(() => scheduleCheckRef.current(), 20_000);
    return () => clearInterval(timer);
  }, []);

  const renameSession = useCallback((id: string, title: string) => {
    setSessions((prev) =>
      prev.map((session) => (session.id === id ? { ...session, title, updatedAt: Date.now() } : session))
    );
  }, []);

  const pinSession = useCallback((id: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === id ? { ...session, pinned: !session.pinned, updatedAt: Date.now() } : session
      )
    );
  }, []);

  /* ---------- 快捷键 ---------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newSession();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession]);

  const messages = activeSession?.messages ?? [];
  const isEmpty = messages.length === 0;

  return (
    <div className={`app ${maximized ? "maximized" : ""}`}>
      <TitleBar />

      <div className="app-body">
        <Sidebar
          sessions={sessions}
          activeId={activeSession?.id ?? ""}
          defaultWorkspace={settings.workspace}
          streamingIds={streamingIds}
          onSelect={(id) => setActiveId(id)}
          onNew={newSession}
          onDelete={deleteSession}
          onExport={exportSession}
          onRename={renameSession}
          onPin={pinSession}
          onOpenSettings={() => {
            setInitialTab("general");
            setSettingsOpen(true);
          }}
          onOpenSchedules={() => {
            setInitialTab("schedule");
            setSettingsOpen(true);
          }}
        />

        <main className="chat">
          <div
            className="messages"
            ref={scrollRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            }}
          >
            <div className="messages-inner">
              {!isEmpty && (activeSession?.todos?.length ?? 0) > 0 && (
                <div className="todo-panel">
                  <div className="todo-title">
                    任务清单 · {activeSession!.todos!.filter((t) => t.status === "done").length}/
                    {activeSession!.todos!.length}
                  </div>
                  {activeSession!.todos!.map((todo) => (
                    <div className={`todo-item todo-${todo.status}`} key={todo.id}>
                      <span className="todo-mark">
                        {todo.status === "done" ? "✓" : todo.status === "in_progress" ? "▶" : "○"}
                      </span>
                      <span className={todo.status === "done" ? "todo-done-text" : ""}>
                        {todo.content}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {isEmpty ? (
                <div className="empty">
                  <img className="empty-logo" src={logo} alt="" draggable={false} />
                  <h1 className="empty-title">{tr("小舟")}</h1>
                  <p className="empty-sub">
                    {tr("我能读写你的文件、跑命令。不确定从哪开始？试试下面这些。")}
                  </p>
                  <div className="empty-cards">
                    {SUGGESTIONS.map((item) => {
                      const text = tr(item);
                      return (
                        <button key={item} className="empty-card" onClick={() => send(text)}>
                          {text}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                messages.map((message, index) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    streaming={
                      streaming &&
                      index === messages.length - 1 &&
                      message.role === "assistant"
                    }
                    onUndo={(toolCallId) =>
                      handleUndo(activeSession?.id ?? "", message.id, toolCallId)
                    }
                    onRetry={() => regenerate(message.id)}
                    onEdit={() => editMessage(message.id)}
                    onBranch={() => branchFrom(message.id)}
                  />
                ))
              )}
            </div>
          </div>

          <Composer
            value={draft}
            streaming={streaming}
            onChange={setDraft}
            onSubmit={() => send(draft)}
            onStop={stop}
            workspace={workspace}
            images={images}
            onAddImage={(url) => setImages((prev) => [...prev, url])}
            onRemoveImage={(index) => setImages((prev) => prev.filter((_, i) => i !== index))}
            model={settings.model}
            models={settings.modelList}
            contextUsage={(() => {
              const lastUsage = messages.filter((m) => m.role === "assistant" && m.usage).at(-1)?.usage;
              if (!lastUsage?.prompt) return undefined;
              return `${fmtK(lastUsage.prompt)} / ${fmtK(settings.contextBudget || 24000)}`;
            })()}
            onSelectModel={(model) => setSettings((prev) => ({ ...prev, model }))}
            onManageModels={() => {
              setInitialTab("model");
              setSettingsOpen(true);
            }}
          >
            <SessionTools
              workspace={workspace}
              isCustom={!!activeSession?.workspace}
              mode={mode}
              onPick={(path) => setSessionWorkspace(path)}
              onReset={() => setSessionWorkspace(undefined)}
              onModeChange={setSessionMode}
            />
          </Composer>
        </main>
      </div>

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          schedules={schedules}
          onSchedulesChange={setSchedules}
          initialTab={initialTab}
          onOpenSession={(sessionId) => {
            setActiveId(sessionId);
          }}
          onSave={(next) => {
            setSettings(next);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {pendingApproval && (
        <ConfirmDialog
          summary={pendingApproval.summary}
          diff={pendingApproval.diff}
          context={pendingApproval.context}
          onApprove={() => settleApproval(true)}
          onReject={() => settleApproval(false)}
        />
      )}

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  );
}
