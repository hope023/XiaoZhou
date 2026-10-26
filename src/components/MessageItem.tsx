import { useState } from "react";
import logo from "../assets/logo.png";
import type { ChatMessage, MessagePart, ToolResult } from "../types";
import { Markdown } from "../Markdown";
import { ToolGroup } from "./ToolCard";

/** 把 <think>…</think>（或流式未闭合的 <think>…）从正文里切出来 */
function parseThinking(
  text: string
): { kind: "text" | "think"; text: string; streaming?: boolean }[] {
  const out: { kind: "text" | "think"; text: string; streaming?: boolean }[] = [];
  let rest = text;
  let idx = rest.indexOf("<think>");
  while (idx !== -1) {
    if (idx > 0) out.push({ kind: "text", text: rest.slice(0, idx) });
    const after = rest.slice(idx + 7);
    const end = after.indexOf("</think>");
    if (end === -1) {
      // 还没闭合：正在思考中
      out.push({ kind: "think", text: after, streaming: true });
      return out;
    }
    const body = after.slice(0, end).trim();
    if (body) out.push({ kind: "think", text: body });
    rest = after.slice(end + 8);
    idx = rest.indexOf("<think>");
  }
  if (rest.trim()) out.push({ kind: "text", text: rest });
  return out;
}

function ThinkingBlock({
  text,
  streaming,
  defaultLabel,
}: {
  text: string;
  streaming?: boolean;
  defaultLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className={`think-box ${streaming ? "thinking" : ""}`} open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M8 1.8c-2.9 0-5 2-5 4.5 0 1.5.8 2.8 2 3.6v1.6c0 .5.4.9.9.9h4.2c.5 0 .9-.4.9-.9V9.9c1.2-.8 2-2.1 2-3.6 0-2.5-2.1-4.5-5-4.5Z"
            stroke="currentColor"
            strokeWidth="1.1"
            fill="none"
            strokeLinejoin="round"
          />
          <path d="M6.2 14.2h3.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
        <span className="think-label">
          {streaming && !open ? "思考中…" : (defaultLabel ?? "思考过程")}
        </span>
        <svg
          className={`think-chevron ${open ? "open" : ""}`}
          viewBox="0 0 16 16"
          width="10"
          height="10"
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="think-body">
        <Markdown text={text} />
      </div>
    </details>
  );
}

function fmt(n?: number): string {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 思考块标题：带上字数，长思考一眼看得出体量 */
function thinkLabel(text: string): string {
  const len = text.trim().length;
  return len >= 1000 ? `思考过程 · ${(len / 1000).toFixed(1)}k 字` : `思考过程 · ${len} 字`;
}

type RenderNode =
  | { kind: "text"; key: string; text: string }
  | { kind: "think"; key: string; text: string; streaming?: boolean }
  | { kind: "tools"; key: string; callIds: string[] };

/**
 * 把零件的流水合并：连续的多轮思考合成一个折叠块，
 * 连续多轮的工具调用合成一条摘要，避免十几行「读取 …」刷屏。
 */
function buildNodes(parts: MessagePart[], streaming?: boolean): RenderNode[] {
  const nodes: RenderNode[] = [];
  const pushThink = (key: string, text: string, isStreaming?: boolean) => {
    const last = nodes[nodes.length - 1];
    if (last?.kind === "think") {
      last.text = `${last.text}\n\n${text}`;
      last.streaming = last.streaming || isStreaming;
      return;
    }
    nodes.push({ kind: "think", key, text, streaming: isStreaming });
  };

  for (const part of parts) {
    if (part.kind === "reasoning") {
      if (part.text.trim()) pushThink(part.id, part.text, streaming);
      continue;
    }
    if (part.kind === "tools") {
      if (!part.callIds.length) continue;
      const last = nodes[nodes.length - 1];
      if (last?.kind === "tools") last.callIds.push(...part.callIds);
      else nodes.push({ kind: "tools", key: part.id, callIds: [...part.callIds] });
      continue;
    }
    if (!part.text.trim()) continue;
    for (const segment of parseThinking(part.text)) {
      if (segment.kind === "think") {
        pushThink(`${part.id}-think-${segment.text.slice(0, 8)}`, segment.text, segment.streaming);
      } else if (segment.text.trim()) {
        nodes.push({ kind: "text", key: `${part.id}-text-${segment.text.slice(0, 8)}`, text: segment.text });
      }
    }
  }
  return nodes;
}

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

export function MessageItem({ message, streaming, onUndo, onRetry, onEdit, onBranch }: Props) {
  const isUser = message.role === "user";
  const results = message.toolResults ?? [];
  const [copied, setCopied] = useState(false);

  const copyAll = () => {
    navigator.clipboard
      ?.writeText(message.content)
      .catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const renderTools = (callIds: string[], key: string) => {
    const items = callIds
      .map((id) => results.find((result) => result.toolCallId === id))
      .filter((result): result is ToolResult => !!result);
    if (!items.length) return null;
    return (
      <ToolGroup
        key={key}
        results={items}
        streaming={streaming}
        onUndo={onUndo}
      />
    );
  };

  const hasParts = !!message.parts && message.parts.length > 0;
  const hasVisible =
    (hasParts &&
      message.parts!.some((part) =>
        part.kind === "text" ? part.text.trim().length > 0 : part.kind === "tools" ? part.callIds.length > 0 : part.text.trim().length > 0
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
          ? buildNodes(message.parts!, streaming).map((node) =>
              node.kind === "text" ? (
                <Markdown key={node.key} text={node.text} />
              ) : node.kind === "think" ? (
                <ThinkingBlock
                  key={node.key}
                  text={node.text}
                  streaming={node.streaming && streaming}
                  defaultLabel={thinkLabel(node.text)}
                />
              ) : (
                renderTools(node.callIds, node.key)
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

        {!streaming && hasVisible && (onRetry || message.content.trim()) && (
          <div className="msg-actions">
            {message.content.trim() && (
              <button className="msg-action" onClick={copyAll} type="button">
                {copied ? "已复制" : "复制"}
              </button>
            )}
            {onRetry && (
              <button className="msg-action" onClick={onRetry} type="button">
                重新生成
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
