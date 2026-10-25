import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpStatus {
  name: string;
  connected: boolean;
  tools: string[];
}

interface Props {
  /** 打开时刷新一次状态 */
  active: boolean;
}

/** 一行配置解析：命令 + 参数（支持引号） */
function parseCommand(text: string): { command: string; args: string[] } | null {
  const parts = text.match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
  if (parts.length === 0 || !parts[0].trim()) return null;
  return { command: parts[0], args: parts.slice(1) };
}

export function McpPanel({ active }: Props) {
  const [config, setConfig] = useState<Record<string, ServerSpec>>({});
  const [status, setStatus] = useState<McpStatus[]>([]);
  const [name, setName] = useState("");
  const [commandText, setCommandText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    try {
      const raw = await invoke<{ mcpServers?: Record<string, ServerSpec> }>("mcp_load_config");
      setConfig(raw.mcpServers ?? {});
      const list = await invoke<McpStatus[]>("mcp_status");
      setStatus(list);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const saveConfig = async (next: Record<string, ServerSpec>) => {
    setConfig(next);
    await invoke("mcp_save_config", { config: { mcpServers: next } }).catch((err) =>
      setError(String(err))
    );
  };

  const connect = async (serverName: string) => {
    setBusy(serverName);
    setError("");
    try {
      await invoke("mcp_connect", { name: serverName });
      await refresh();
    } catch (err) {
      setError(`${serverName}: ${err}`);
    } finally {
      setBusy("");
    }
  };

  const disconnect = async (serverName: string) => {
    setBusy(serverName);
    try {
      await invoke("mcp_disconnect", { name: serverName });
      await refresh();
    } finally {
      setBusy("");
    }
  };

  const add = async () => {
    const trimmed = name.trim();
    const parsed = parseCommand(commandText);
    if (!trimmed || !parsed) {
      setError("名称和启动命令都要填，命令形如：dbx mcp-server --port 3000");
      return;
    }
    if (config[trimmed]) {
      setError(`已经有叫「${trimmed}」的 server`);
      return;
    }
    const next = { ...config, [trimmed]: parsed };
    await saveConfig(next);
    setName("");
    setCommandText("");
    setError("");
    // 加完顺手连上
    setBusy(trimmed);
    try {
      await invoke("mcp_connect", { name: trimmed });
      await refresh();
    } catch (err) {
      setError(`${trimmed}: ${err}`);
    } finally {
      setBusy("");
    }
  };

  const remove = async (serverName: string) => {
    await invoke("mcp_disconnect", { name: serverName }).catch(() => {});
    const next = { ...config };
    delete next[serverName];
    await saveConfig(next);
    await refresh();
  };

  const statusOf = (serverName: string) => status.find((s) => s.name === serverName);

  return (
    <div className="mcp-panel">
      <div className="field">
        <label>添加 MCP Server</label>
        <div className="schedule-row">
          <input
            className="mcp-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="名称，如 dbx"
            spellCheck={false}
          />
          <input
            className="mcp-command"
            value={commandText}
            onChange={(event) => setCommandText(event.target.value)}
            placeholder="启动命令，如 dbx mcp --stdio"
            spellCheck={false}
          />
          <button className="ghost-btn" onClick={() => void add()} disabled={busy === name.trim()}>
            添加并连接
          </button>
        </div>
        <span className="field-hint">
          填本地 MCP server 的启动命令（stdio 传输）。连接成功后它的工具会自动出现在「标准 / 放开」模式的工具列表里，工具名形如
          mcp__dbx__query。
        </span>
        {error && <span className="field-hint warn">{error}</span>}
      </div>

      <div className="mcp-list">
        {Object.keys(config).length === 0 && (
          <span className="field-hint">
            还没有配置 MCP server。配置保存在 %APPDATA%\xiaozhou\mcp.json，也可以直接编辑那个文件。
          </span>
        )}
        {Object.entries(config).map(([serverName, spec]) => {
          const st = statusOf(serverName);
          const connected = !!st;
          return (
            <div className="schedule-item" key={serverName}>
              <div className="schedule-main">
                <div className="schedule-head">
                  <span className={`schedule-dot ${connected ? "ok" : ""}`} />
                  <span className="schedule-name">{serverName}</span>
                  {connected && (
                    <span className="schedule-freq">{st!.tools.length} 个工具</span>
                  )}
                </div>
                <div className="schedule-prompt" title={spec.command}>
                  {spec.command} {(spec.args ?? []).join(" ")}
                </div>
                {connected && st!.tools.length > 0 && (
                  <div className="mcp-tools">
                    {st!.tools.map((tool) => (
                      <span className="msg-attachment" key={tool}>
                        {tool}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="schedule-ops">
                {connected ? (
                  <button onClick={() => void disconnect(serverName)} disabled={busy === serverName} type="button">
                    断开
                  </button>
                ) : (
                  <button onClick={() => void connect(serverName)} disabled={busy === serverName} type="button">
                    {busy === serverName ? "连接中…" : "连接"}
                  </button>
                )}
                <button className="danger" onClick={() => void remove(serverName)} disabled={busy === serverName} type="button">
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
