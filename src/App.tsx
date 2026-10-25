import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "./assets/logo.png";
import { Composer } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { MessageItem } from "./components/MessageItem";
import { SessionTools } from "./components/SessionTools";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { runAgent } from "./agent";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 打开设置面板时直接落到哪个页签 */
  const [initialTab, setInitialTab] = useState<"general" | "model" | "schedule">("general");
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
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

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
    (approved: boolean) => {
      setPendingApproval((current) => {
        current?.resolve(approved);
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
      const attachments = await expandRefs(content, workspace);
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
          isAborted: () => abortMapRef.current.get(sessionId) ?? false,
          onAssistant: (patch) => patchMessage(sessionId, assistantMessage.id, patch),
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
        `> 导出于 ${new Date().toLocaleString("zh-CN", { hour12: false })} · 工作目录 ${session.workspace || settings.workspace || "未设置"}`,
        "",
        ...session.messages.map((message) =>
          message.role === "user"
            ? `## 🧑 我\n\n${message.content}\n`
            : `## 🤖 小舟\n\n${message.error ? `（出错：${message.error}）\n\n` : ""}${message.content || "（执行了工具调用，见下）"}\n${
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
        notify("导出完成", path);
      } catch (error) {
        notify("导出失败", error instanceof Error ? error.message : String(error));
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
          item.id === schedule.id ? { ...item, lastRun: now, nextRun: upcoming, lastStatus: "running" } : item
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
          `定时任务：${schedule.name}`,
          failed ? `执行失败：${failed.slice(0, 120)}` : "执行完成，点开「小舟」查看结果"
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
          model={settings.model}
          streamingIds={streamingIds}
          onSelect={(id) => setActiveId(id)}
          onNew={newSession}
          onDelete={deleteSession}
          onExport={exportSession}
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
              {isEmpty ? (
                <div className="empty">
                  <img className="empty-logo" src={logo} alt="" draggable={false} />
                  <h1 className="empty-title">小舟</h1>
                  <p className="empty-sub">
                    我能读写你的文件、跑命令。不确定从哪开始？试试下面这些。
                  </p>
                  <div className="empty-cards">
                    {SUGGESTIONS.map((item) => (
                      <button key={item} className="empty-card" onClick={() => send(item)}>
                        {item}
                      </button>
                    ))}
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
    </div>
  );
}
