import { Channel, invoke } from "@tauri-apps/api/core";
import type { ApiMessage, ToolCall } from "./types";

export interface LlmDone {
  content: string;
  reasoning: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: unknown;
}

type LlmEvent =
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "done";
      content: string;
      // 后端字段名历史上出现过 camelCase / snake_case 两种，都接住
      toolCalls?: ToolCall[];
      tool_calls?: ToolCall[];
      finishReason?: string | null;
      finish_reason?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      usage?: unknown;
    }
  | { kind: "error"; message: string };

export interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ApiMessage[];
  tools: unknown[];
  temperature: number;
}

/**
 * 发起一轮流式对话。正文增量通过 onDelta 实时回调，
 * 结束后返回完整的正文与工具调用。
 */
export function streamChat(
  options: StreamOptions,
  onDelta: (text: string) => void,
  onReasoning?: (text: string) => void
): Promise<LlmDone> {
  return new Promise<LlmDone>((resolve, reject) => {
    const channel = new Channel<LlmEvent>();
    let settled = false;

    channel.onmessage = (event) => {
      if (settled) return;
      if (event.kind === "delta") {
        onDelta(event.text);
        return;
      }
      if (event.kind === "reasoning") {
        onReasoning?.(event.text);
        return;
      }
      if (event.kind === "done") {
        settled = true;
        const calls = event.toolCalls ?? event.tool_calls ?? [];
        resolve({
          content: event.content,
          reasoning: event.reasoning ?? event.reasoning_content ?? null,
          toolCalls: Array.isArray(calls) ? calls : [],
          finishReason: event.finishReason ?? event.finish_reason ?? null,
          usage: event.usage ?? null,
        });
        return;
      }
      settled = true;
      reject(new Error(event.message));
    };

    invoke("llm_stream", {
      onEvent: channel,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      temperature: options.temperature,
    }).catch((err) => {
      if (settled) return;
      settled = true;
      reject(new Error(typeof err === "string" ? err : String(err?.message ?? err)));
    });
  });
}
