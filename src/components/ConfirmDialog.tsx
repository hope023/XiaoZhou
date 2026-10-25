import type { DiffData } from "../types";

interface Props {
  summary: string;
  /** 带了就是改文件（展示红绿对比），没有就是跑命令 */
  diff?: DiffData;
  /** 来源会话名，后台任务弹窗时用户才知道是谁在要权限 */
  context?: string;
  onApprove: () => void;
  onReject: () => void;
}

export function ConfirmDialog({ summary, diff, context, onApprove, onReject }: Props) {
  const isFile = !!diff;

  return (
    <div className="settings-backdrop" onClick={onReject}>
      <div className="confirm-panel confirm-wide" onClick={(event) => event.stopPropagation()}>
        <h3 className="confirm-title">{isFile ? "要应用这次文件改动吗？" : "要执行这条命令吗？"}</h3>
        {context && <p className="confirm-context">来自对话「{context}」</p>}

        {isFile && diff ? (
          <>
            <div className="diff-path">
              <span className="diff-file">{diff.path}</span>
              <span className="diff-stat">
                <span className="diff-add">+{diff.added}</span>{" "}
                <span className="diff-del">-{diff.removed}</span>
              </span>
            </div>
            <div className="diff-view">
              {diff.rows.map((row, index) => (
                <div className={`diff-row diff-${row.type}`} key={index}>
                  <span className="diff-no">{row.oldNo ?? row.newNo ?? ""}</span>
                  <span className="diff-sign">
                    {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
                  </span>
                  <span className="diff-text">{row.text || " "}</span>
                </div>
              ))}
            </div>
            {diff.truncated && (
              <p className="confirm-hint">文件太大，只展示前后对比，没有逐行对齐。</p>
            )}
          </>
        ) : (
          <>
            <pre className="confirm-code">{summary}</pre>
            <p className="confirm-hint">
              它会在工作目录下以 PowerShell 运行。你可以在设置里关掉逐条确认。
            </p>
          </>
        )}

        <div className="confirm-actions">
          <button className="ghost-btn wide" onClick={onReject}>
            {isFile ? "不改" : "拒绝"}
          </button>
          <button className="primary-btn" onClick={onApprove} autoFocus>
            {isFile ? "应用" : "执行"}
          </button>
        </div>
      </div>
    </div>
  );
}
