import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "../assets/logo.png";
import { tr, useLocale } from "../i18n";

export function TitleBar() {
  useLocale();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const win = getCurrentWindow();

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <img className="titlebar-logo" src={logo} alt="" draggable={false} />
        <span className="titlebar-title" data-tauri-drag-region>
          {tr("小舟")}
        </span>
      </div>

      <div className="titlebar-actions">
        <button
          className="win-btn"
          title={tr("最小化")}
          onClick={() => win.minimize().catch(() => {})}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M3.5 8.5h9" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className="win-btn"
          title={maximized ? tr("还原") : tr("最大化")}
          onClick={() => win.toggleMaximize().catch(() => {})}
        >
          {maximized ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="3.2" y="5" width="7.6" height="7.6" rx="1.2" stroke="currentColor" strokeWidth="1.1" fill="none" />
              <path d="M5.6 5V4.2A1.2 1.2 0 0 1 6.8 3h5a1.2 1.2 0 0 1 1.2 1.2v5a1.2 1.2 0 0 1-1.2 1.2H11" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.4" stroke="currentColor" strokeWidth="1.1" fill="none" />
            </svg>
          )}
        </button>
        <button
          className="win-btn win-btn-close"
          title={tr("关闭")}
          onClick={() => win.close().catch(() => {})}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </header>
  );
}
