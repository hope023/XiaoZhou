import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  value: string;
  streaming: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** 输入框左下角的目录 / 权限控件 */
  children?: ReactNode;
  /** @ 引用要用的当前工作目录 */
  workspace: string;
  /** 已粘贴的图片（data URL） */
  images: string[];
  onAddImage: (dataUrl: string) => void;
  onRemoveImage: (index: number) => void;
  /** 当前模型与常用列表，右下角快速切换 */
  model: string;
  models: string[];
  onSelectModel: (model: string) => void;
  onManageModels: () => void;
}

/** 读文件为 data URL，超过 8MB 的图片拒收，避免请求体爆炸 */
function fileToDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (file.size > 8 * 1024 * 1024) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

const MENTION_RE = /@([\w\-./\\]*)$/;

export function Composer({
  value,
  streaming,
  onChange,
  onSubmit,
  onStop,
  children,
  workspace,
  images,
  onAddImage,
  onRemoveImage,
  model,
  models,
  onSelectModel,
  onManageModels,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 模型快速切换菜单
  const [modelMenu, setModelMenu] = useState(false);

  // @ 引用弹层
  const [mention, setMention] = useState<{
    query: string;
    start: number;
    items: string[];
    active: number;
  } | null>(null);
  const mentionTimer = useRef<number | null>(null);

  // 模型菜单：点外面就关
  useEffect(() => {
    if (!modelMenu) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".model-wrap")) setModelMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [modelMenu]);

  // 高度跟着内容走，最多 6 行
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [value]);

  // 输入变化时检测是否在输入 @ 引用
  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = MENTION_RE.exec(before);
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[1];
    const start = caret - query.length - 1;
    if (mentionTimer.current) window.clearTimeout(mentionTimer.current);
    const requestId = window.setTimeout(() => {
      if (!workspace) {
        setMention({ query, start, items: [], active: 0 });
        return;
      }
      invoke<string[]>("list_files", { root: workspace, query })
        .then((items) => setMention({ query, start, items, active: 0 }))
        .catch(() => setMention({ query, start, items: [], active: 0 }));
    }, 120);
    mentionTimer.current = requestId;
    setMention({ query, start, items: mention?.items ?? [], active: 0 });
  };

  const applyMention = (path: string) => {
    if (!mention) return;
    const next = value.slice(0, mention.start) + `@${path} ` + value.slice(mention.start + mention.query.length + 1);
    onChange(next);
    setMention(null);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await fileToDataUrl(file);
      if (dataUrl) onAddImage(dataUrl);
    }
  };

  const canSend = value.trim().length > 0 && !streaming;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mention.items.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMention({ ...mention, active: (mention.active + 1) % mention.items.length });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMention({
          ...mention,
          active: (mention.active - 1 + mention.items.length) % mention.items.length,
        });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(mention.items[mention.active]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((url, index) => (
              <div className="composer-image" key={index}>
                <img src={url} alt={`图片 ${index + 1}`} />
                <button
                  className="composer-image-del"
                  title="移除图片"
                  onClick={() => onRemoveImage(index)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          placeholder="说点什么，@ 引用文件，或粘贴截图…"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            detectMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onPaste={(event) => {
            const items = event.clipboardData?.items;
            if (!items) return;
            const imageFiles: File[] = [];
            for (const item of items) {
              if (item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) imageFiles.push(file);
              }
            }
            if (imageFiles.length > 0) {
              event.preventDefault();
              void addFiles(imageFiles);
            }
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // 点击弹层项时不能立刻关掉，延一拍
            setTimeout(() => setMention(null), 150);
          }}
        />

        {mention && (mention.items.length > 0 || mention.query.length > 0) && (
          <div className="mention-pop">
            {mention.items.length === 0 ? (
              <div className="mention-empty">
                {workspace ? "没有匹配的文件" : "先设置工作目录才能引用文件"}
              </div>
            ) : (
              mention.items.slice(0, 8).map((path, index) => (
                <button
                  key={path}
                  className={`mention-item ${index === mention.active ? "active" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyMention(path);
                  }}
                  onMouseEnter={() => setMention({ ...mention, active: index })}
                  type="button"
                >
                  {path}
                </button>
              ))
            )}
          </div>
        )}

        <div className="composer-bar">
          <div className="composer-chips">{children}</div>

          <div className="composer-right">
            <div className="model-wrap">
              <button
                className="chip model-chip"
                onClick={() => setModelMenu((v) => !v)}
                title={`${model}（点击切换模型）`}
                type="button"
              >
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path
                    d="M8 2l5 2.9v6.2L8 14 3 11.1V4.9L8 2Z"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    fill="none"
                    strokeLinejoin="round"
                  />
                  <path d="M8 8l5-2.9M8 8v6M8 8L3 5.1" stroke="currentColor" strokeWidth="1.1" fill="none" />
                </svg>
                <span className="chip-text">{model || "未配置模型"}</span>
              </button>

              {modelMenu && (
                <div className="model-menu">
                  <div className="model-menu-title">切换模型</div>
                  {models.length === 0 && (
                    <div className="mention-empty">
                      还没有常用模型，点「管理模型」把常用的加进去
                    </div>
                  )}
                  {models.map((item) => (
                    <button
                      key={item}
                      className="model-menu-item"
                      onClick={() => {
                        onSelectModel(item);
                        setModelMenu(false);
                      }}
                      type="button"
                    >
                      <span className="model-menu-name">{item}</span>
                      {item === model && <span className="model-check">✓ 当前</span>}
                    </button>
                  ))}
                  <button
                    className="model-menu-item model-manage"
                    onClick={() => {
                      setModelMenu(false);
                      onManageModels();
                    }}
                    type="button"
                  >
                    管理模型…
                  </button>
                </div>
              )}
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              className="icon-btn"
              onClick={() => fileRef.current?.click()}
              disabled={streaming}
              title="插入图片（也可以直接粘贴截图）"
              type="button"
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
                <circle cx="5.8" cy="6.8" r="1.1" fill="currentColor" />
                <path d="M3 11.6l3.4-3 2.4 2.2 2.6-2.6 2.4 2.2" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {streaming ? (
              <button className="send-btn stop" onClick={onStop} title="停止">
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.6" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button className="send-btn" onClick={onSubmit} disabled={!canSend} title="发送 (Enter)">
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                  <path
                    d="M8 12.6V3.6M8 3.6L3.9 7.7M8 3.6l4.1 4.1"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="composer-hint">Enter 发送 · Shift + Enter 换行 · @ 引用文件 · 粘贴截图</div>
    </div>
  );
}
