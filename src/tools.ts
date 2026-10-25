import { Channel, invoke } from "@tauri-apps/api/core";

export interface ToolOutcome {
  ok: boolean;
  output: string;
}

interface ToolStreamEvent {
  kind: "output";
  text: string;
}

export interface ExecuteOptions {
  /** 用来中断命令，一般传 toolCallId */
  runId?: string;
  /** 命令运行中逐行回调 */
  onOutput?: (text: string) => void;
}

export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "列出某个目录下的文件和子目录（目录优先）。想看项目结构、找文件时先调用它。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "相对于工作目录的路径，例如 '.' 或 'src/components'",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "读取一个文本文件的内容，返回带行号的行。修改文件之前必须先读它。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对于工作目录的文件路径" },
          offset: {
            type: "integer",
            description: "起始行号（从 1 开始），默认 1",
          },
          limit: { type: "integer", description: "最多读取多少行，默认 400" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description:
        "在工作目录里全文搜索文本或正则，返回「文件:行号:内容」。想知道某个函数、变量或字符串在哪定义、被谁引用时用它，比一个个文件读快得多。",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "要搜索的文本或正则表达式",
          },
          path: {
            type: "string",
            description: "搜索起点，默认整个工作目录",
          },
          glob: {
            type: "string",
            description: "只搜匹配的文件，如 *.ts 或 src/**/*.tsx",
          },
          max_results: {
            type: "integer",
            description: "最多返回多少条，默认 60",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "按文件名模式查找文件，支持 ** 通配。回答「某个组件/配置放在哪」这类问题时用它。",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "文件名模式，如 **/*.tsx、src/**/*.ts、*.json",
          },
          path: { type: "string", description: "查找起点，默认整个工作目录" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "把文件里的一段文本精确替换成新内容。改代码优先用它，不要用 write_file 整体重写——整体重写费 token 且容易改坏别处。old_text 必须在文件里唯一匹配，通常要带上前后几行做上下文。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对于工作目录的文件路径" },
          old_text: {
            type: "string",
            description:
              "要被替换掉的原文，必须和文件里完全一致（含缩进和空行），且在文件中只出现一次",
          },
          new_text: {
            type: "string",
            description: "替换后的新内容；传空字符串表示删除这一段",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "把内容写入文件，文件已存在则整体覆盖，不存在则新建（父目录自动创建）。只用于创建新文件或整文件重写；改已有文件的局部请用 edit_file。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对于工作目录的文件路径" },
          content: { type: "string", description: "要写入的完整文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_last",
      description:
        "撤销上一次对文件的修改（write_file 或 edit_file）。改错了先试它，别急着再写一遍覆盖。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "在工作目录下执行一条 PowerShell 命令，返回退出码、标准输出和错误输出。用于跑构建、测试、git 等。危险命令（格式化、递归删根目录）会被直接拒绝。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令（PowerShell 语法）" },
          timeout_sec: {
            type: "integer",
            description: "超时秒数，默认 60，最大 300",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "use_skill",
      description:
        "调用一个已安装的技能，返回该技能的详细指令。系统提示里列出了可用技能及其适用场景；任务与某个技能的描述匹配时，先调用它拿到指令再干活。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名称，见系统提示里的技能清单" },
        },
        required: ["name"],
      },
    },
  },
];

export function toolLabel(name: string): string {
  switch (name) {
    case "list_dir":
      return "查看目录";
    case "read_file":
      return "读取文件";
    case "write_file":
      return "写入文件";
    case "edit_file":
      return "修改文件";
    case "search_text":
      return "搜索内容";
    case "glob":
      return "查找文件";
    case "undo_last":
      return "撤销改动";
    case "run_command":
      return "执行命令";
    case "use_skill":
      return "调用技能";
    default:
      if (name.startsWith("mcp__")) {
        const [, server, tool] = name.split("__");
        return `${server}·${tool}`;
      }
      return name;
  }
}

/** 从工具参数里抽出一个适合显示的单行摘要 */
export function summarizeArgs(name: string, rawArgs: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(rawArgs || "{}");
  } catch {
    return rawArgs.slice(0, 80);
  }
  const pick = (key: string) => {
    const value = parsed[key];
    return typeof value === "string" ? value : "";
  };
  if (name === "run_command") return pick("command");
  if (name === "write_file") {
    const content = pick("content");
    return `${pick("path")}  ·  ${content.split("\n").length} 行`;
  }
  if (name === "edit_file") {
    const removed = pick("old_text").split("\n").length;
    const added = pick("new_text").split("\n").length;
    return `${pick("path")}  ·  -${removed} +${added} 行`;
  }
  if (name === "search_text") {
    const glob = pick("glob");
    return glob ? `${pick("pattern")}  ·  ${glob}` : pick("pattern");
  }
  if (name === "glob") return pick("pattern");
  if (name === "undo_last") return "";
  if (name === "use_skill") return pick("name");
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    // 摘要带参数原文：权限记忆按精确匹配放行，参数变了还是要问
    return `${server}/${tool} ${rawArgs}`;
  }
  return pick("path") || ".";
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
  options?: ExecuteOptions
): Promise<ToolOutcome> {
  const channel = new Channel<ToolStreamEvent>();
  if (options?.onOutput) {
    channel.onmessage = (event) => {
      if (event.kind === "output") options.onOutput?.(event.text);
    };
  }

  // MCP 工具走独立通道：mcp__服务__工具
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    if (!server || !tool) {
      return { ok: false, output: `MCP 工具名不合法：${name}` };
    }
    try {
      return await invoke<ToolOutcome>("mcp_call_tool", {
        server,
        tool,
        args,
      });
    } catch (err) {
      return {
        ok: false,
        output: `MCP 工具执行异常：${typeof err === "string" ? err : String(err)}`,
      };
    }
  }

  // run_id 交给后端登记，前端点「中断」时用它找到对应进程
  const payload: Record<string, unknown> = { ...args };
  if (options?.runId && name === "run_command") {
    payload.run_id = options.runId;
  }

  try {
    const outcome = await invoke<ToolOutcome>("run_tool", {
      name,
      args: payload,
      root,
      onEvent: channel,
    });
    if (!outcome || typeof outcome.output !== "string") {
      return { ok: false, output: "工具没有返回结果" };
    }
    return outcome;
  } catch (err) {
    return {
      ok: false,
      output: `工具执行异常：${typeof err === "string" ? err : String(err)}`,
    };
  }
}

/** 中断正在运行的命令 */
export async function cancelTool(runId: string): Promise<void> {
  try {
    await invoke("cancel_tool", { runId });
  } catch {
    /* 命令可能已经结束了 */
  }
}
