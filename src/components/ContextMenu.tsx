import { useEffect, useRef, useState } from "react";

export interface CtxMenuItem {
  label: string;
  /** 显示在右侧的快捷键提示 */
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

interface Props {
  x: number;
  y: number;
  items: CtxMenuItem[];
  onClose: () => void;
}

/**
 * 应用内右键菜单：替代 WebView2 默认的浏览器菜单（刷新/检查元素等）。
 * 位置自动避开窗口边缘，点击任意处 / Esc / 滚动时关闭。
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // 出现后按实际尺寸夹到窗口内，避免贴边时溢出
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(6, Math.min(x, window.innerWidth - rect.width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - rect.height - 6)),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // 捕获阶段监听，避免菜单内点击被外层 stopPropagation 拦住
    window.addEventListener("mousedown", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          key={index}
          type="button"
          className="ctx-item"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.action();
          }}
        >
          <span className="ctx-label">{item.label}</span>
          {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
