import { useEffect, useState } from "react";
import type { ToolResult } from "../types";
import { cancelTool, toolLabel } from "../tools";

interface Props {
  result: ToolResult;
  /** 写文件类工具才需要，用于撤销这一步改动 */
  onUndo?: () => void;
}

const EDITABLE = new Set(["write_file", "edit_file"]);

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
            中断
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
            撤销
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
