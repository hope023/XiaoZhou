import logo from "../assets/logo.png";
import type { ChatMessage } from "../types";
import { Markdown } from "../Markdown";
import { ToolCard } from "./ToolCard";

interface Props {
  message: ChatMessage;
  streaming?: boolean;
  /** 点工具卡片上的「撤销」时回调，参数是该工具调用的 id */
  onUndo?: (toolCallId: string) => void;
  /** 重新生成这条回复 */
  onRetry?: () => void;
  /** 把这条提问放回输入框 */
  onEdit?: () => void;
  /** 从这条提问处分叉出新会话 */
  onBranch?: () => void;
}

function fmt(n?: number): string {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function MessageItem({ message, streaming, onUndo, onRetry, onEdit, onBranch }: Props) {
  const isUser = message.role === "user";
  const results = message.toolResults ?? [];

  const renderTools = (callIds: string[], key: string) => {
    const items = callIds
      .map((id) => results.find((result) => result.toolCallId === id))
      .filter((result) => !!result);
    if (!items.length) return null;
    return (
      <div className="tool-list" key={key}>
        {items.map((result, index) => (
          <ToolCard
            key={`${result!.toolCallId}-${index}`}
            result={result!}
            onUndo={onUndo ? () => onUndo(result!.toolCallId) : undefined}
          />
        ))}
      </div>
    );
  };

  const hasParts = !!message.parts && message.parts.length > 0;
  const hasVisible =
    (hasParts &&
      message.parts!.some((part) =>
        part.kind === "text" ? part.text.trim().length > 0 : part.callIds.length > 0
      )) ||
    message.content.trim().length > 0 ||
    results.length > 0;
  const showDots = !!streaming && !hasVisible;

  if (isUser) {
    return (
      <div className="msg msg-user">
        <div className="msg-user-col">
          {message.images && message.images.length > 0 && (
            <div className="msg-images">
              {message.images.map((url, index) => (
                <img key={index} className="msg-image" src={url} alt={`图片 ${index + 1}`} />
              ))}
            </div>
          )}
          <div className="msg-bubble">{message.content}</div>
          {(message.attachments?.length ?? 0) > 0 && (
            <div className="msg-attachments">
              {message.attachments!.map((attachment) => (
                <span className="msg-attachment" key={attachment.path} title={attachment.path}>
                  @ {attachment.path.split(/[\\/]/).pop()}
                </span>
              ))}
            </div>
          )}
          {!streaming && (onEdit || onBranch) && (
            <div className="msg-actions">
              {onBranch && (
                <button className="msg-action" onClick={onBranch} type="button">
                  分叉
                </button>
              )}
              {onEdit && (
                <button className="msg-action" onClick={onEdit} type="button">
                  编辑
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg-assistant">
      <img className="msg-avatar" src={logo} alt="" draggable={false} />
      <div className="msg-body">
        {hasParts
          ? message.parts!.map((part) =>
              part.kind === "text" ? (
                part.text.trim() ? <Markdown key={part.id} text={part.text} /> : null
              ) : (
                renderTools(part.callIds, part.id)
              )
            )
          : [
              message.content ? <Markdown key="legacy-text" text={message.content} /> : null,
              renderTools(
                results.map((result) => result.toolCallId),
                "legacy-tools"
              ),
            ]}

        {showDots && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}

        {message.error && <div className="msg-error">{message.error}</div>}

        {!streaming && message.usage && (message.usage.total ?? 0) > 0 && (
          <div className="msg-usage" title="本次请求消耗的 token">
            ↑{fmt(message.usage.prompt)} ↓{fmt(message.usage.completion)} · 共 {fmt(message.usage.total)} tokens
          </div>
        )}

        {!streaming && hasVisible && onRetry && (
          <div className="msg-actions">
            <button className="msg-action" onClick={onRetry} type="button">
              重新生成
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
