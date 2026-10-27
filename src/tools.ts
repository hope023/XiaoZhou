import { Channel, invoke } from "@tauri-apps/api/core";
import { tr } from "./i18n";

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
  /** todo_write 更新清单 */
  onTodos?: (
    items: { id: string; content: string; status: "pending" | "in_progress" | "done" }[]
  ) => void;
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
        "在持久 PowerShell 会话里执行一条命令：cd、环境变量、后台任务会跨命令保持（比如先 cd 再跑构建）。返回退出码、标准输出和错误输出。危险命令（格式化、递归删根目录）会被直接拒绝。",
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
      name: "memory",
      description:
        "长期记忆：记住 / 查询 / 删除跨对话的事实（用户偏好、项目约定、反复出现的需求）。值得记的：用户明确说「以后都…」「记住」的偏好、项目稳定约定、踩过的坑。不要记：一次性任务的临时信息。与用户当前要求冲突时，先说一句再更新记忆。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "add = 记住一条；list = 列出；remove = 删除包含关键词的条目；clear = 清空",
          },
          scope: {
            type: "string",
            description: "user = 用户级（跨所有项目）；project = 当前项目。不填默认 project",
          },
          content: { type: "string", description: "add 时要记的一句话，不要换行" },
          keyword: { type: "string", description: "remove 时匹配要删条目的关键词" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "维护当前任务的任务清单（全量替换）。3 步以上的任务先建清单，完成一项更新一项，让用户和你自己都能看到进度。一步以内的简单任务不用建。",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "完整清单",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "这一步要做什么" },
                status: {
                  type: "string",
                  description: "pending = 未开始；in_progress = 正在做；done = 已完成",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "联网搜索（Bing）。查报错方案、库的用法、版本号等需要时效信息的问题时用它，不要凭记忆猜。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词" },
          max_results: { type: "integer", description: "结果数上限，默认 8" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "抓取一个网页，返回剥掉 HTML 后的正文文本。配合 web_search 使用。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http/https 链接" },
          max_chars: { type: "integer", description: "正文字符上限，默认 12000" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_changes",
      description:
        "一次性回滚最近 N 步文件改动（基于自动快照）。改砸了一串时用它整体回退，比多次 undo_last 快。",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", description: "回滚最近几步，默认 1" },
        },
        required: [],
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
      return tr("查看目录");
    case "read_file":
      return tr("读取文件");
    case "write_file":
      return tr("写入文件");
    case "edit_file":
      return tr("修改文件");
    case "search_text":
      return tr("搜索内容");
    case "glob":
      return tr("查找文件");
    case "undo_last":
      return tr("撤销改动");
    case "run_command":
      return tr("执行命令");
    case "use_skill":
      return tr("调用技能");
    case "memory":
      return tr("长期记忆");
    case "todo_write":
      return tr("更新清单");
    case "web_search":
      return tr("联网搜索");
    case "web_fetch":
      return tr("抓取网页");
    case "undo_changes":
      return tr("批量回滚");
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
  if (name === "todo_write") {
    const items = parsed.items;
    return Array.isArray(items) ? `${items.length} 项` : "清单";
  }
  if (name === "web_search") return pick("query");
  if (name === "web_fetch") return pick("url");
  if (name === "undo_changes") return `最近 ${parsed.count ?? 1} 步`;
  if (name === "memory") {
    const action = pick("action");
    const detail = action === "add" ? pick("content") : action === "remove" ? pick("keyword") : "";
    return `${action}${detail ? ` · ${detail}` : ""}${pick("scope") === "user" ? " · 用户级" : ""}`;
  }
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

  // todo_write 是纯前端状态工具
  if (name === "todo_write") {
    const rawItems = Array.isArray(args.items) ? args.items : [];
    const clean = rawItems
      .filter(
        (item: unknown): item is { content: string; status?: unknown } =>
          typeof (item as { content?: unknown })?.content === "string" &&
          (item as { content: string }).content.trim().length > 0
      )
      .map((item, index) => ({
        id: `todo_${Date.now()}_${index}`,
        content: item.content.trim(),
        status: (["pending", "in_progress", "done"] as const).includes(
          item.status as never
        )
          ? (item.status as "pending" | "in_progress" | "done")
          : "pending",
      }));
    options?.onTodos?.(clean);
    const done = clean.filter((t) => t.status === "done").length;
    return {
      ok: true,
      output: `清单已更新（共 ${clean.length} 项，已完成 ${done}）。开始做某一步和完成某一步时，都要用 todo_write 更新状态。`,
    };
  }

  // web 与批量回滚走独立命令
  if (name === "web_search") {
    try {
      return await invoke<ToolOutcome>("web_search", {
        query: args.query ?? "",
        maxResults: typeof args.max_results === "number" ? args.max_results : null,
      });
    } catch (err) {
      return { ok: false, output: `搜索失败：${typeof err === "string" ? err : String(err)}` };
    }
  }
  if (name === "web_fetch") {
    try {
      return await invoke<ToolOutcome>("web_fetch", {
        url: args.url ?? "",
        maxChars: typeof args.max_chars === "number" ? args.max_chars : null,
      });
    } catch (err) {
      return { ok: false, output: `抓取失败：${typeof err === "string" ? err : String(err)}` };
    }
  }
  if (name === "undo_changes") {
    try {
      return await invoke<ToolOutcome>("undo_changes", {
        root,
        count: typeof args.count === "number" ? args.count : 1,
      });
    } catch (err) {
      return { ok: false, output: `回滚失败：${typeof err === "string" ? err : String(err)}` };
    }
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
