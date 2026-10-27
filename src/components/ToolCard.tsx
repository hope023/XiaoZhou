import { useEffect, useState } from "react";
import type { ToolResult } from "../types";
import { cancelTool, toolLabel } from "../tools";
import { tr, useLocale } from "../i18n";

interface Props {
  result: ToolResult;
  /** 写文件类工具才需要，用于撤销这一步改动 */
  onUndo?: () => void;
}

const EDITABLE = new Set(["write_file", "edit_file"]);

/** 工具名 → 摘要里用的量词说法 */
const UNITS: Record<string, [string, string]> = {
  read_file: ["读取", "个文件"],
  list_dir: ["浏览", "个目录"],
  glob: ["匹配", "次"],
  search_text: ["搜索", "次"],
  run_command: ["运行", "条命令"],
  edit_file: ["修改", "个文件"],
  write_file: ["写入", "个文件"],
  web_search: ["网页搜索", "次"],
  web_fetch: ["抓取网页", "次"],
  use_skill: ["加载技能", "个"],
  memory: ["记忆", "次"],
  todo_write: ["更新任务清单", ""],
  undo_last: ["回滚", "次"],
  undo_changes: ["批量回滚", "次"],
};

/** 把一组工具调用归纳成一句人话：读取 4 个文件、执行 1 条命令 */
function summarize(results: ToolResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    counts.set(result.name, (counts.get(result.name) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [name, count] of counts) {
    if (name.startsWith("mcp__")) {
      const server = name.split("__")[1] ?? "mcp";
      parts.push(`${server} ×${count}`);
      continue;
    }
    const unit = UNITS[name];
    if (unit) {
      const [verb, quantifier] = unit;
      parts.push(quantifier ? `${tr(verb)} ${count} ${tr(quantifier)}`.trim() : `${tr(verb)} ×${count}`);
    } else {
      parts.push(`${toolLabel(name)} ×${count}`);
    }
  }
  const failed = results.filter((result) => result.status === "done" && !result.ok).length;
  const text = parts.join(tr("、"));
  return failed > 0 ? tr("{text}（{n} 个失败）", { text, n: failed }) : text;
}

/**
 * 把一轮里连续的工具调用收成一条摘要，展开才看每一条细节。
 * 只有一次调用时退回普通卡片，避免为了一个操作多套一层壳。
 */
export function ToolGroup({
  results,
  onUndo,
  streaming,
}: {
  results: ToolResult[];
  onUndo?: (toolCallId: string) => void;
  streaming?: boolean;
}) {
  useLocale();
  const running = results.filter((result) => result.status === "running");
  const failed = results.filter((result) => result.status === "done" && !result.ok);
  const [open, setOpen] = useState(false);

  if (results.length === 1) {
    const only = results[0];
    return (
      <ToolCard result={only} onUndo={onUndo ? () => onUndo(only.toolCallId) : undefined} />
    );
  }

  const state = running.length > 0 ? "running" : failed.length > 0 ? "fail" : "ok";
  const live = running[0];
  const label = live
    ? tr("正在{action}", { action: toolLabel(live.name) }) +
      (live.args && live.args !== "." ? ` · ${live.args}` : "…")
    : summarize(results);

  return (
    <div className={`tool-group tool-${state}`}>
      <button className="tool-group-head" onClick={() => setOpen((v) => !v)} type="button">
        <span className="tool-dot" />
        <span className="tool-group-text">{label}</span>
        <span className="tool-group-count">{tr("{n} 步", { n: results.length })}</span>
        <svg
          className={`tool-chevron ${open ? "open" : ""}`}
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.3"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {/* 收起时把失败原因摆在明面上，不用点开才看到 */}
      {!open && failed.length > 0 && (
        <div className="tool-group-errors">
          {failed.slice(0, 2).map((result) => (
            <div className="tool-group-error" key={result.toolCallId}>
              <span className="tool-group-error-mark">✗</span>
              {toolLabel(result.name)} {result.args} — {result.output.split("\n")[0].slice(0, 90)}
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className="tool-group-body">
          {results.map((result, index) => (
            <ToolCard
              key={`${result.toolCallId}-${index}`}
              result={result}
              onUndo={onUndo ? () => onUndo(result.toolCallId) : undefined}
            />
          ))}
        </div>
      )}
      {!open && streaming && running.length > 0 && <span className="tool-group-hint">{tr("执行中…")}</span>}
    </div>
  );
}

export function ToolCard({ result, onUndo }: Props) {
  const running = result.status === "running";
  const [open, setOpen] = useState(false);

  // 执行中自动展开好让用户看到实时输出；出错也展开
  useEffect(() => {
    if (running || !result.ok) setOpen(true);
  }, [running, result.ok]);

  const state = running ? "running" : result.ok ? "ok" : "fail";
  const undone = result.output.includes("↩");
  const canUndo = !!onUndo && EDITABLE.has(result.name) && !running && result.ok && !undone;
  const canCancel = running && result.name === "run_command";

  return (
    <div className={`tool-card tool-${state}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)} type="button">
        <span className="tool-dot" />
        <span className="tool-name">{toolLabel(result.name)}</span>
        <span className="tool-summary">{result.args}</span>
        {canCancel && (
          <span
            className="tool-stop"
            role="button"
            tabIndex={0}
            title="中断这条命令"
            onClick={(event) => {
              event.stopPropagation();
              void cancelTool(result.toolCallId);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.stopPropagation();
                event.preventDefault();
                void cancelTool(result.toolCallId);
              }
            }}
          >
            {tr("中断")}
          </span>
        )}
        {canUndo && (
          <span
            className="tool-undo"
            role="button"
            tabIndex={0}
            title="撤销这一步改动"
            onClick={(event) => {
              event.stopPropagation();
              onUndo?.();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.stopPropagation();
                event.preventDefault();
                onUndo?.();
              }
            }}
          >
            {tr("撤销")}
          </span>
        )}
        <svg
          className={`tool-chevron ${open ? "open" : ""}`}
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="tool-body">
          <pre className="tool-output">
            {result.output
              ? result.output + (running ? "\n▌" : "")
              : running
                ? "执行中…"
                : "（无输出）"}
          </pre>
        </div>
      )}
    </div>
  );
}
