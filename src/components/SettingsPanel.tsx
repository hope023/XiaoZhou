import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { MODES } from "../modes";
import type { Schedule, Settings } from "../types";
import { ScheduleManager } from "./ScheduleManager";

interface Props {
  settings: Settings;
  schedules: Schedule[];
  onSchedulesChange: (next: Schedule[]) => void;
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

export function SettingsPanel({ settings, schedules, onSchedulesChange, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [showKey, setShowKey] = useState(false);
  const [workspaceOk, setWorkspaceOk] = useState<boolean | null>(null);

  const patch = (part: Partial<Settings>) => setDraft((prev) => ({ ...prev, ...part }));

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

        <div className="settings-body">
          <section className="field-group">
            <div className="group-label">模型接口</div>

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
              <input
                value={draft.model}
                onChange={(event) => patch({ model: event.target.value })}
                placeholder="deepseek-chat"
                spellCheck={false}
              />
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

          <section className="field-group">
            <div className="group-label">工作区</div>

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
                发给模型的历史上限（近似 token）。超出后自动丢掉最早的消息，
                按模型上下文窗口的一半左右填比较稳，比如 32k 窗口填 16000
              </span>
            </div>
          </section>

          <section className="field-group">
            <div className="group-label">定时任务</div>
            <ScheduleManager
              schedules={schedules}
              defaultWorkspace={settings.workspace}
              onChange={onSchedulesChange}
            />
          </section>
        </div>

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
