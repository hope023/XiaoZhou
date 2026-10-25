import { useState } from "react";
import { nextRunOf } from "../store";
import type { Schedule } from "../types";

interface Props {
  schedules: Schedule[];
  defaultWorkspace: string;
  onChange: (next: Schedule[]) => void;
  /** 跳到某次任务运行产生的会话 */
  onOpenRun?: (sessionId: string) => void;
}

function describe(schedule: Schedule): string {
  if (schedule.schedule.kind === "interval") {
    const minutes = schedule.schedule.minutes;
    return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  }
  return `每天 ${schedule.schedule.time}`;
}

function fmtNext(ts?: number): string {
  if (!ts) return "—";
  const diff = ts - Date.now();
  if (diff <= 0) return "即将执行";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

const MODE_LABEL: Record<string, string> = { readonly: "只读", standard: "标准", yolo: "放开" };

export function ScheduleManager({ schedules, defaultWorkspace, onChange, onOpenRun }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"interval" | "daily">("interval");
  const [minutes, setMinutes] = useState(60);
  const [time, setTime] = useState("09:00");
  const [mode, setMode] = useState<"readonly" | "standard" | "yolo">("readonly");
  const [workspace, setWorkspace] = useState("");

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed || !prompt.trim()) return;
    const now = Date.now();
    const schedule: Schedule = {
      id: Math.random().toString(36).slice(2, 10),
      name: trimmed,
      prompt: prompt.trim(),
      workspace: workspace.trim(),
      mode,
      schedule:
        kind === "interval"
          ? { kind: "interval", minutes: Math.max(5, Math.min(10080, minutes)) }
          : { kind: "daily", time: time || "09:00" },
      enabled: true,
      nextRun: 0,
      createdAt: now,
    };
    schedule.nextRun = nextRunOf(schedule, now);
    onChange([schedule, ...schedules]);
    setAdding(false);
    setName("");
    setPrompt("");
  };

  const toggle = (id: string) =>
    onChange(
      schedules.map((item) => {
        if (item.id !== id) return item;
        const enabled = !item.enabled;
        return {
          ...item,
          enabled,
          nextRun: enabled ? nextRunOf(item) : item.nextRun,
        };
      })
    );

  const remove = (id: string) => onChange(schedules.filter((item) => item.id !== id));

  const runNow = (id: string) =>
    onChange(schedules.map((item) => (item.id === id ? { ...item, nextRun: Date.now() - 1 } : item)));

  return (
    <div className="field schedule-block">
      <label>
        定时任务
        <button className="schedule-add" onClick={() => setAdding((v) => !v)} type="button">
          {adding ? "收起" : "＋ 新建"}
        </button>
      </label>

      {adding && (
        <div className="schedule-form">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="任务名，如「检查构建」"
          />
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="要执行什么，如「看看 dist 目录有没有今天的新构建，有就列出来」"
            rows={3}
          />
          <div className="schedule-row">
            <select value={kind} onChange={(event) => setKind(event.target.value as "interval" | "daily")}>
              <option value="interval">固定间隔</option>
              <option value="daily">每天定时</option>
            </select>
            {kind === "interval" ? (
              <span className="schedule-inline">
                每 <input type="number" min={5} max={10080} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 60)} /> 分钟
              </span>
            ) : (
              <span className="schedule-inline">
                每天 <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </span>
            )}
          </div>
          <div className="schedule-row">
            <select value={mode} onChange={(event) => setMode(event.target.value as "readonly" | "standard" | "yolo")}>
              <option value="readonly">只读模式</option>
              <option value="standard">标准模式</option>
              <option value="yolo">放开模式</option>
            </select>
            <input
              className="schedule-ws"
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              placeholder={`工作目录（默认 ${defaultWorkspace || "未设置"}）`}
              spellCheck={false}
            />
          </div>
          <div className="schedule-row">
            <button className="ghost-btn" onClick={create} disabled={!name.trim() || !prompt.trim()}>
              创建
            </button>
            <span className="field-hint">任务只在应用开着时执行；关闭应用即暂停</span>
          </div>
        </div>
      )}

      <div className="schedule-list">
        {schedules.length === 0 && (
          <span className="field-hint">还没有定时任务。创建后，到点时小舟会自己开一个对话执行，并用系统通知告诉你结果。</span>
        )}
        {schedules.map((schedule) => (
          <div className="schedule-item" key={schedule.id}>
            <div className="schedule-main">
              <div className="schedule-head">
                <span className={`schedule-dot ${schedule.lastStatus ?? ""}`} />
                <span className="schedule-name">{schedule.name}</span>
                <span className="schedule-freq">{describe(schedule)}</span>
                <span className="schedule-mode">{MODE_LABEL[schedule.mode]}</span>
              </div>
              <div className="schedule-prompt" title={schedule.prompt}>
                {schedule.prompt}
              </div>
              <div className="schedule-meta">
                {schedule.enabled ? `下次：${fmtNext(schedule.nextRun)}` : "已停用"}
                {schedule.lastStatus === "fail" && " · 上次失败"}
                {schedule.lastStatus === "running" && " · 执行中…"}
              </div>
            </div>
            <div className="schedule-ops">
              <button onClick={() => toggle(schedule.id)} type="button">
                {schedule.enabled ? "停用" : "启用"}
              </button>
              <button onClick={() => runNow(schedule.id)} disabled={schedule.lastStatus === "running"} type="button">
                立即跑
              </button>
              {schedule.lastRunSessionId && (
                <button onClick={() => onOpenRun?.(schedule.lastRunSessionId!)} type="button">
                  上次运行
                </button>
              )}
              <button className="danger" onClick={() => remove(schedule.id)} type="button">
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
