import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { MODES, modeInfo } from "../modes";
import type { AgentMode } from "../types";

interface Props {
  workspace: string;
  /** 本对话是否单独设过目录（设过才能"恢复默认"） */
  isCustom: boolean;
  mode: AgentMode;
  onPick: (path: string) => void;
  onReset: () => void;
  onModeChange: (mode: AgentMode) => void;
}

function baseName(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

/** 让浮层停在输入框卡片正上方，而不是盖住卡片内容 */
function anchorAbove(el: HTMLElement | null): CSSProperties {
  const box = el?.closest(".composer");
  if (!el || !box) return {};
  const chipRect = el.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  return {
    position: "fixed",
    left: Math.max(8, chipRect.left),
    right: "auto",
    bottom: Math.round(window.innerHeight - boxRect.top + 10),
    maxWidth: Math.min(340, window.innerWidth - chipRect.left - 16),
  };
}

/** 输入框左下角的两个控件：工作目录、权限模式 */
export function SessionTools({
  workspace,
  isCustom,
  mode,
  onPick,
  onReset,
  onModeChange,
}: Props) {
  const [modeMenu, setModeMenu] = useState(false);
  const [dirMenu, setDirMenu] = useState(false);
  const [dirError, setDirError] = useState("");

  const modeRef = useRef<HTMLDivElement>(null);
  const dirRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const [dirMenuStyle, setDirMenuStyle] = useState<CSSProperties>({});
  const [modeMenuStyle, setModeMenuStyle] = useState<CSSProperties>({});
  const info = modeInfo(mode);

  // 点别处关掉所有浮层
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!modeRef.current?.contains(target)) setModeMenu(false);
      if (!dirRef.current?.contains(target)) setDirMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    if (!dirError) return;
    const timer = setTimeout(() => setDirError(""), 5000);
    return () => clearTimeout(timer);
  }, [dirError]);

  const openDialog = async () => {
    setDirMenu(false);
    setDirError("");
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择这个对话的工作目录",
        defaultPath: workspace || undefined,
      });
      if (typeof selected === "string") onPick(selected);
    } catch (error) {
      // 不能静默失败，否则用户只看到"点了没反应"
      const message = error instanceof Error ? error.message : String(error);
      setDirError(`打开文件夹选择框失败：${message}`);
    }
  };

  return (
    <>
      <div className="dir-wrap" ref={dirRef}>
        <button
          ref={chipRef}
          className={`chip dir-chip ${isCustom ? "custom" : ""}`}
          onClick={() => {
            setDirMenuStyle(anchorAbove(chipRef.current));
            setDirMenu((v) => !v);
          }}
          title={workspace || "选择工作目录"}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M2 5.4A1.4 1.4 0 0 1 3.4 4h2.3l1.2 1.4h4.7A1.4 1.4 0 0 1 13 6.8v4.4a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.2V5.4Z"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinejoin="round"
            />
          </svg>
          <span className="chip-text">{workspace ? baseName(workspace) : "选择目录"}</span>
          <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true" className="chip-caret">
            <path
              d="M3 4.6L6 7.6l3-3"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {dirMenu && (
          <div className="chip-menu" style={dirMenuStyle}>
            <div className="chip-menu-title" title={workspace}>
              {workspace || "还没设目录"}
            </div>
            <button className="chip-menu-item" onClick={openDialog}>
              选择文件夹…
            </button>
            {isCustom && (
              <button className="chip-menu-item" onClick={onReset}>
                恢复默认目录
              </button>
            )}
          </div>
        )}
      </div>

      {dirError && <span className="chip-error">{dirError}</span>}

      <div className="mode-wrap" ref={modeRef}>
        <button
          ref={modeBtnRef}
          className={`chip mode-chip mode-${mode}`}
          onClick={() => {
            setModeMenuStyle(anchorAbove(modeBtnRef.current));
            setModeMenu((v) => !v);
          }}
          title={info.desc}
        >
          <span className="mode-dot" />
          <span className="chip-text">{info.label}</span>
          <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true" className="chip-caret">
            <path
              d="M3 4.6L6 7.6l3-3"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {modeMenu && (
          <div className="mode-menu" style={modeMenuStyle}>
            <div className="mode-menu-title">这个对话的权限</div>
            {MODES.map((item) => (
              <button
                key={item.value}
                className={`mode-item ${item.value === mode ? "active" : ""}`}
                onClick={() => {
                  onModeChange(item.value);
                  setModeMenu(false);
                }}
              >
                <span className="mode-item-head">
                  <span className={`mode-dot mode-${item.value}`} />
                  <span>{item.label}</span>
                  {item.value === mode && <span className="mode-check">当前</span>}
                </span>
                <span className="mode-item-desc">{item.desc}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
