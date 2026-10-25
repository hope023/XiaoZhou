import type { AgentMode } from "./types";

export interface ModeInfo {
  value: AgentMode;
  label: string;
  desc: string;
  /** 允许使用的工具名 */
  tools: string[];
}

// use_skill 只是读技能指令，三种模式都放开；memory 写入按 action 在执行层细分
const READ_TOOLS = [
  "list_dir",
  "read_file",
  "search_text",
  "glob",
  "use_skill",
  "memory",
  "web_search",
  "web_fetch",
  "todo_write",
];
const WRITE_TOOLS = [
  ...READ_TOOLS,
  "edit_file",
  "write_file",
  "undo_last",
  "undo_changes",
  "run_command",
];

export const MODES: ModeInfo[] = [
  {
    value: "readonly",
    label: "只读",
    desc: "只能看目录、读文件和搜索，绝不改动任何东西",
    tools: READ_TOOLS,
  },
  {
    value: "standard",
    label: "标准",
    desc: "可以改文件、跑命令，改文件和命令前都会先给你看变更再确认",
    tools: WRITE_TOOLS,
  },
  {
    value: "yolo",
    label: "放开",
    desc: "能干所有事，不再逐条确认，速度最快",
    tools: WRITE_TOOLS,
  },
];

export function modeInfo(mode: AgentMode): ModeInfo {
  return MODES.find((item) => item.value === mode) ?? MODES[1];
}
