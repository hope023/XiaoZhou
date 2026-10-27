import { useEffect, useMemo, useState } from "react";
import type { Session } from "../types";
import { tr, useLocale } from "../i18n";

/** 会话项 hover 出现的操作按钮 */
function SessionOps({
  pinned,
  onPin,
  onRename,
  onExport,
  onDelete,
}: {
  pinned?: boolean;
  onPin: () => void;
  onRename: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  return (
    <span className="session-ops">
      <button
        className={`session-op ${pinned ? "on" : ""}`}
        title={pinned ? tr("取消置顶") : tr("置顶")}
        onClick={(event) => {
          event.stopPropagation();
          onPin();
        }}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M9.8 2.2l4 4-1.4 1.4-.9-.3-2.6 2.6.4 2.9-1.1 1.1-2.6-2.6L3 14l-1-1 2.7-2.6L2.1 7.8l1.1-1.1 2.9.4 2.6-2.6-.3-.9 1.4-1.4Z"
            stroke="currentColor"
            strokeWidth="1.1"
            fill="none"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <button
        className="session-op"
        title={tr("重命名")}
        onClick={(event) => {
          event.stopPropagation();
          onRename();
        }}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M11.3 2.6l2.1 2.1L5 13.1l-2.7.6.6-2.7 8.4-8.4Z"
            stroke="currentColor"
            strokeWidth="1.1"
            fill="none"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <button
        className="session-op"
        title={tr("导出为 Markdown")}
        onClick={(event) => {
          event.stopPropagation();
          onExport();
        }}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M8 2.6v7.2M8 9.8L5 6.9M8 9.8l3-2.9M3.4 11v1.6a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V11"
            stroke="currentColor"
            strokeWidth="1.3"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <button
        className="session-op danger"
        title={tr("删除对话")}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

interface Props {
  sessions: Session[];
  activeId: string;
  /** 设置里的默认目录，会话没单独设过时归到这一组 */
  defaultWorkspace: string;
  /** 正在执行的会话 id 集合，列表里显示小圆点 */
  streamingIds?: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string) => void;
  onOpenSettings: () => void;
  onOpenSchedules: () => void;
}

function baseName(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

const NONE_KEY = "__none__";

export function Sidebar({
  sessions,
  activeId,
  defaultWorkspace,
  streamingIds,
  onSelect,
  onNew,
  onDelete,
  onExport,
  onRename,
  onPin,
  onOpenSettings,
  onOpenSchedules,
}: Props) {
  useLocale();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? sessions.filter(
        (session) =>
          session.title.toLowerCase().includes(needle) ||
          session.messages.some((message) => message.content.toLowerCase().includes(needle))
      )
    : sessions;

  // 按工作目录分组：组内按更新时间倒序，组之间按最近活跃排序
  const groups = useMemo(() => {
    const map = new Map<string, { dir: string; items: Session[] }>();
    for (const session of visible) {
      const dir = session.workspace || defaultWorkspace || "";
      const key = dir || NONE_KEY;
      if (!map.has(key)) map.set(key, { dir, items: [] });
      map.get(key)!.items.push(session);
    }
    const list = [...map.entries()].map(([key, group]) => ({
      key,
      dir: group.dir,
      items: [...group.items].sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      }),
    }));
    return list.sort((a, b) => {
      const latest = (items: Session[]) => Math.max(...items.map((i) => i.updatedAt));
      return latest(b.items) - latest(a.items);
    });
  }, [visible, defaultWorkspace]);

  // 切到某个对话时，它所在的分组一定展开，否则用户看不见自己在哪
  useEffect(() => {
    const current = sessions.find((item) => item.id === activeId);
    if (!current) return;
    const key = (current.workspace || defaultWorkspace || "") || NONE_KEY;
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [activeId, sessions, defaultWorkspace]);

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <button className="new-chat" onClick={onNew}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {tr("新建对话")}
      </button>

      <button className="new-chat schedule-entry" onClick={onOpenSchedules} title={tr("定时任务")}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" fill="none" />
          <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
        </svg>
        {tr("定时任务")}
      </button>

      <div className="session-search">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.3" fill="none" />
          <path d="M10.2 10.2L13.4 13.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr("搜索对话…")}
          spellCheck={false}
        />
        {query && (
          <button className="session-search-clear" onClick={() => setQuery("")} title={tr("清空")}>
            ×
          </button>
        )}
      </div>

      <div className="session-list">
        {groups.length === 0 && needle && <div className="session-empty">{tr("没有匹配「{query}」的对话", { query })}</div>}
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.key);
          return (
            <div className="dir-group" key={group.key}>
              <button
                className="dir-group-head"
                onClick={() => toggle(group.key)}
                title={group.dir || tr("未设置目录")}
                type="button"
              >
                <svg
                  className={`dir-group-caret ${isCollapsed ? "" : "open"}`}
                  viewBox="0 0 16 16"
                  width="10"
                  height="10"
                  aria-hidden="true"
                >
                  <path
                    d="M6 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" className="dir-group-icon">
                  <path
                    d="M2 5.4A1.4 1.4 0 0 1 3.4 4h2.3l1.2 1.4h4.7A1.4 1.4 0 0 1 13 6.8v4.4a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.2V5.4Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    fill="none"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="dir-group-name">
                  {group.dir ? baseName(group.dir) : tr("未设置目录")}
                </span>
                <span className="dir-group-count">{group.items.length}</span>
              </button>

              {!isCollapsed &&
                group.items.map((session) => (
                  <div
                    key={session.id}
                    className={`session-item ${session.id === activeId ? "active" : ""}`}
                    onClick={() => onSelect(session.id)}
                  >
                    {streamingIds?.has(session.id) && <span className="session-live" title={tr("执行中")} />}
                    {renamingId === session.id ? (
                      <input
                        className="session-rename"
                        value={renameDraft}
                        autoFocus
                        spellCheck={false}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            onRename(session.id, renameDraft.trim() || session.title);
                            setRenamingId(null);
                          }
                          if (event.key === "Escape") setRenamingId(null);
                        }}
                        onBlur={() => {
                          onRename(session.id, renameDraft.trim() || session.title);
                          setRenamingId(null);
                        }}
                      />
                    ) : (
                      <>
                        <span className="session-title">{session.title}</span>
                        <SessionOps
                          pinned={session.pinned}
                          onPin={() => onPin(session.id)}
                          onRename={() => {
                            setRenameDraft(session.title);
                            setRenamingId(session.id);
                          }}
                          onExport={() => onExport(session.id)}
                          onDelete={() => onDelete(session.id)}
                        />
                      </>
                    )}
                  </div>
                ))}
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <button className="settings-bar" onClick={onOpenSettings} title={tr("设置 (Ctrl+,)")}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.1" fill="none" />
            <path
              d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </svg>
          <span>{tr("设置")}</span>
        </button>
      </div>
    </aside>
  );
}
