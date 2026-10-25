import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { MODES } from "../modes";
import type { Schedule, Settings } from "../types";
import { ScheduleManager } from "./ScheduleManager";
import { McpPanel } from "./McpPanel";

interface Props {
  settings: Settings;
  schedules: Schedule[];
  onSchedulesChange: (next: Schedule[]) => void;
  /** 打开时直接落到某个页签（如从侧栏定时任务、模型切换菜单进来） */
  initialTab?: "general" | "model" | "schedule" | "mcp";
  /** 跳到某个会话（定时任务「上次运行」用） */
  onOpenSession?: (sessionId: string) => void;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}

const PRESETS = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  {
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  { label: "本地 llama.cpp", baseUrl: "http://127.0.0.1:8080", model: "local-model" },
  { label: "OpenAI", baseUrl: "https://api.openai.com", model: "gpt-4o-mini" },
];

export function SettingsPanel({ settings, schedules, onSchedulesChange, initialTab, onOpenSession, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [showKey, setShowKey] = useState(false);
  const [workspaceOk, setWorkspaceOk] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"general" | "model" | "schedule" | "mcp">(
    initialTab === "mcp" ? "mcp" : (initialTab ?? "general")
  );

  const patch = (part: Partial<Settings>) => setDraft((prev) => ({ ...prev, ...part }));

  const [memoryCount, setMemoryCount] = useState({ user: 0, project: 0 });
  const countMemory = useCallback(() => {
    invoke<{ user: string; project: string }>("memory_read", { root: draft.workspace })
      .then((memory) =>
        setMemoryCount({
          user: memory.user?.trim() ? memory.user.trim().split("\n").length : 0,
          project: memory.project?.trim() ? memory.project.trim().split("\n").length : 0,
        })
      )
      .catch(() => setMemoryCount({ user: 0, project: 0 }));
  }, [draft.workspace]);

  useEffect(() => {
    countMemory();
  }, [countMemory]);

  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    hasUpdate: boolean;
    latest: string;
    current: string;
    url: string;
  } | null>(null);
  const [updateError, setUpdateError] = useState("");
  const checkUpdate = async () => {
    setChecking(true);
    setUpdateError("");
    try {
      const info = await invoke<{
        hasUpdate: boolean;
        latest: string;
        current: string;
        url: string;
      }>("check_update");
      setUpdateInfo(info);
    } catch (err) {
      setUpdateInfo(null);
      setUpdateError(String(err));
    } finally {
      setChecking(false);
    }
  };

  // 目录一改就校验，填错路径自己能立刻看到
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<boolean>("dir_exists", { path: draft.workspace })
        .then((ok) => {
          if (!cancelled) setWorkspaceOk(ok);
        })
        .catch(() => {
          if (!cancelled) setWorkspaceOk(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft.workspace]);

  const pickFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择工作目录",
        defaultPath: draft.workspace || undefined,
      });
      if (typeof selected === "string") {
        patch({ workspace: selected });
      }
    } catch {
      /* 用户取消，或对话框不可用 */
    }
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="settings-tabs">
          {(
            [
              ["general", "通用设置"],
              ["model", "模型设置"],
              ["schedule", "定时任务"],
              ["mcp", "MCP"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={`settings-tab ${tab === value ? "active" : ""}`}
              onClick={() => setTab(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "general" && (
        <div className="settings-body">
          <section className="field-group">
            <div className="group-label">通用设置</div>

            <div className="field">
              <label>默认工作目录</label>
              <div className="input-with-action">
                <input
                  value={draft.workspace}
                  onChange={(event) => patch({ workspace: event.target.value })}
                  placeholder="D:\\projects"
                  spellCheck={false}
                />
                <button className="ghost-btn" onClick={pickFolder} title="浏览文件夹">
                  浏览…
                </button>
              </div>
              {workspaceOk === false ? (
                <span className="field-hint warn">
                  这个目录不存在，先建好，或者点「浏览…」重新选一个
                </span>
              ) : (
                <span className="field-hint">
                  新建对话默认用这个目录。已经开着的对话可以在对话顶部的目录栏单独切换，互不影响
                </span>
              )}
            </div>

            <div className="field">
              <label>默认权限模式</label>
              <div className="preset-row">
                {MODES.map((item) => (
                  <button
                    key={item.value}
                    className={`preset ${draft.defaultMode === item.value ? "active" : ""}`}
                    title={item.desc}
                    onClick={() => patch({ defaultMode: item.value })}
                  >
                    <span className={`mode-dot mode-${item.value}`} />
                    {item.label}
                  </button>
                ))}
              </div>
              <span className="field-hint">
                新建对话默认用这个。已经开着的对话可以在顶栏右侧单独切换，互不影响
              </span>
            </div>

            <div className="field">
              <label>单次任务最多轮数</label>
              <input
                type="number"
                min={1}
                max={60}
                value={draft.maxRounds}
                onChange={(event) =>
                  patch({ maxRounds: Math.max(1, Math.min(60, Number(event.target.value) || 1)) })
                }
              />
              <span className="field-hint">
                一轮 = 模型请求一次（一轮里可以同时调多个工具）。复杂任务
                （读几个文件再改再验证）常见 10~20 轮，超出上限就停下。一般 25
                够用，只有跑批处理才需要调更高
              </span>
            </div>

            <div className="field">
              <label>上下文预算</label>
              <input
                type="number"
                min={4000}
                max={200000}
                step={1000}
                value={draft.contextBudget}
                onChange={(event) => {
                  const next = Number(event.target.value) || 24000;
                  patch({ contextBudget: Math.max(4000, Math.min(200000, next)) });
                }}
              />
              <span className="field-hint">
                发给模型的历史上限（近似 token）。超出后自动摘要压缩最早的消息，
                按模型上下文窗口的一半左右填比较稳，比如 32k 窗口填 16000
              </span>
            </div>

            <div className="field">
              <label>界面字体大小</label>
              <input
                className="slider"
                type="range"
                min={12}
                max={20}
                step={0.5}
                value={draft.fontSize}
                onChange={(event) => patch({ fontSize: Number(event.target.value) })}
              />
              <div className="slider-labels">
                <span>12px</span>
                <span className="field-value">{draft.fontSize}px</span>
                <span>20px</span>
              </div>
              <span className="field-hint">
                整个界面（消息、侧栏、代码）按比例缩放，默认 15px，比旧版大一号。保存后立即生效
              </span>
            </div>

            <div className="field">
              <label>界面字体样式</label>
              <div className="preset-row">
                <button
                  className={`preset ${draft.fontFamily === "default" ? "active" : ""}`}
                  onClick={() => patch({ fontFamily: "default" })}
                >
                  系统默认
                </button>
                <button
                  className={`preset ${draft.fontFamily === "smiley" ? "active" : ""}`}
                  onClick={() => patch({ fontFamily: "smiley" })}
                >
                  得意黑
                </button>
              </div>
              <div
                className="font-preview"
                style={
                  draft.fontFamily === "smiley"
                    ? { fontFamily: '"Smiley Sans", var(--sans)' }
                    : undefined
                }
              >
                小舟 Xiaozhou —— 让 AI 帮你干活 0123456789
              </div>
              <span className="field-hint">
                得意黑（Smiley Sans）为开源免费商用字体，已内置在应用里，离线可用；代码块仍使用等宽字体
              </span>
            </div>

            <div className="field">
              <label>全局呼出快捷键</label>
              <input
                value={draft.toggleShortcut}
                onChange={(event) => patch({ toggleShortcut: event.target.value })}
                placeholder="alt+space"
                spellCheck={false}
              />
              <span className="field-hint">
                任何应用里按它呼出/隐藏小舟。写法：修饰键加号连键名，如 alt+space、
                ctrl+shift+z、super+j。改完点「保存」立即生效；注册失败会弹系统通知
              </span>
            </div>

            <div className="field">
              <label>长期记忆</label>
              <div className="schedule-row">
                <span className="field-hint">
                  用户级 {memoryCount.user} 条 · 项目级 {memoryCount.project} 条。
                  对话里说「记住…」，小舟会存下来并在此后所有对话中生效
                </span>
              </div>
              <div className="schedule-row">
                <button
                  className="ghost-btn"
                  disabled={memoryCount.user + memoryCount.project === 0}
                  onClick={() => {
                    if (!window.confirm("确定清空全部长期记忆？不可恢复。")) return;
                    void invoke("run_tool", {
                      name: "memory",
                      args: { action: "clear", scope: "user" },
                      root: draft.workspace,
                    });
                    void invoke("run_tool", {
                      name: "memory",
                      args: { action: "clear", scope: "project" },
                      root: draft.workspace,
                    }).then(() => countMemory());
                  }}
                >
                  清空记忆
                </button>
                <span className="field-hint">
                  存放在 %APPDATA%\xiaozhou\memory.md（用户级）和工作目录 .xiaozhou\memory.md（项目级），可以直接编辑
                </span>
              </div>
            </div>

            <div className="field">
              <label>关于</label>
              <div className="schedule-row">
                <button className="ghost-btn" onClick={() => void checkUpdate()} disabled={checking}>
                  {checking ? "检查中…" : "检查更新"}
                </button>
                {updateInfo && (
                  <span className="field-hint">
                    {updateInfo.hasUpdate
                      ? `有新版本 v${updateInfo.latest}（当前 v${updateInfo.current}），去 Release 页下载`
                      : `已是最新版本 v${updateInfo.current}`}
                  </span>
                )}
                {updateInfo?.hasUpdate && (
                  <button
                    className="ghost-btn"
                    onClick={() => {
                      navigator.clipboard?.writeText(updateInfo.url).catch(() => {});
                      setUpdateError("下载链接已复制到剪贴板");
                    }}
                  >
                    复制下载链接
                  </button>
                )}
                {updateError && <span className="field-hint">{updateError}</span>}
              </div>
            </div>
          </section>
        </div>
        )}

        {tab === "model" && (
        <div className="settings-body">
          <section className="field-group">
            <div className="group-label">模型设置</div>

            <div className="field">
              <label>快速预设</label>
              <div className="preset-row">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    className={`preset ${draft.baseUrl === preset.baseUrl ? "active" : ""}`}
                    title={`${preset.baseUrl}｜模型 ${preset.model}（会同时覆盖地址和模型）`}
                    onClick={() => patch({ baseUrl: preset.baseUrl, model: preset.model })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>接口地址</label>
              <input
                value={draft.baseUrl}
                onChange={(event) => patch({ baseUrl: event.target.value })}
                placeholder="https://api.deepseek.com"
                spellCheck={false}
              />
              <span className="field-hint">
                填到域名或版本路径即可，会自动补 chat/completions。例如
                https://open.bigmodel.cn/api/paas/v4
              </span>
            </div>

            <div className="field">
              <label>API Key</label>
              <div className="input-with-action">
                <input
                  type={showKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) => patch({ apiKey: event.target.value })}
                  placeholder="sk-…"
                  spellCheck={false}
                />
                <button className="ghost-btn" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? "隐藏" : "显示"}
                </button>
              </div>
              <span className="field-hint">本地模型不需要填</span>
            </div>

            <div className="field">
              <label>模型</label>
              <div className="input-with-action">
                <input
                  value={draft.model}
                  onChange={(event) => patch({ model: event.target.value })}
                  placeholder="deepseek-chat"
                  spellCheck={false}
                />
                <button
                  className="ghost-btn"
                  disabled={!draft.model.trim() || draft.modelList.includes(draft.model.trim())}
                  onClick={() => patch({ modelList: [...draft.modelList, draft.model.trim()] })}
                  title="加入常用模型列表，输入框右下角可以快速切换"
                >
                  ＋ 存为常用
                </button>
              </div>
              {draft.modelList.length > 0 && (
                <div className="model-list">
                  {draft.modelList.map((item) => (
                    <span
                      key={item}
                      className={`model-tag ${item === draft.model ? "active" : ""}`}
                      onClick={() => patch({ model: item })}
                      title={item === draft.model ? "当前模型" : "点击切换到这个模型"}
                    >
                      {item}
                      <button
                        className="model-tag-del"
                        title="从常用列表移除"
                        onClick={(event) => {
                          event.stopPropagation();
                          patch({ modelList: draft.modelList.filter((x) => x !== item) });
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="field">
              <label>
                温度
                <span className="field-value">{draft.temperature.toFixed(1)}</span>
              </label>
              <input
                className="slider"
                type="range"
                min={0}
                max={1.5}
                step={0.1}
                value={draft.temperature}
                onChange={(event) => patch({ temperature: Number(event.target.value) })}
              />
              <div className="slider-labels">
                <span>0 更稳、更守规矩</span>
                <span>1.5 更发散、更随意</span>
              </div>
              <span className="field-hint">
                决定模型每次挑词有多随机。调低会照章办事、少发挥；调高更有创意，但也更容易跑偏。
                让它改代码、跑命令建议 0.2~0.5；闲聊写作 0.7~1.0。
              </span>
            </div>
          </section>
        </div>
        )}

        {tab === "schedule" && (
        <div className="settings-body">
          <section className="field-group">
            <div className="group-label">定时任务设置</div>
            <ScheduleManager
              schedules={schedules}
              defaultWorkspace={settings.workspace}
              onChange={onSchedulesChange}
              onOpenRun={(sessionId) => {
                onOpenSession?.(sessionId);
                onClose();
              }}
            />
          </section>
        </div>
        )}

        {tab === "mcp" && (
        <div className="settings-body">
          <section className="field-group">
            <div className="group-label">MCP 服务器</div>
            <McpPanel active={tab === "mcp"} />
          </section>
        </div>
        )}

        <div className="settings-foot">
          <button className="ghost-btn wide" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" onClick={() => onSave(draft)}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
