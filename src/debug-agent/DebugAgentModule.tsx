"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  LoaderCircle,
  Play,
  Radio,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";

export type DebugAgentView = "chat" | "diagnostics" | "settings";

interface HermesConfigClient {
  provider: string;
  apiFormat: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  smartenanceAccountKey: string;
  temperature: number;
  maxToolSteps: number;
  systemPrompt: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  requiresApiKey: boolean;
  configured: boolean;
  source: "database" | "env";
}

interface ProviderPreset {
  id: string;
  label: string;
  apiFormat: "openai" | "anthropic";
  defaultBaseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
}

interface SmartenanceAccountInfo {
  account_key: string;
  machine_count: number;
  total_incidents: number;
  latest_synced_at: string | null;
}

interface HermesToolDefinition {
  name: string;
  category: "connector" | "smartenance" | "c2m";
  description: string;
}

interface ToolCallTrace {
  ok: boolean;
  tool: string;
  arguments: Record<string, unknown>;
  durationMs: number;
  result?: unknown;
  error?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallTrace[];
  model?: string;
  error?: boolean;
  createdAt: string;
}

interface ConnectorOverviewResult {
  configured: boolean;
  overallStatus: string;
  summary?: string;
  configurationId?: string;
  configurationUpdatedAt?: string | null;
  mqttBroker?: {
    protocol: string;
    host: string;
    port: number;
    clientId?: string;
    qos?: number;
    authType?: string;
    tcpReachability?: { reachable: boolean; latencyMs: number | null; error: string | null } | null;
  } | null;
  sources: Array<{
    id: string;
    protocol: string;
    host: string;
    port: number;
    readMode?: string | null;
    pollingMs?: number | null;
    pollerActive: boolean;
    pollingStatus: string;
    lastError?: string | null;
    configuredTopics: string[];
    tcpReachability?: { reachable: boolean; latencyMs: number | null; error: string | null } | null;
  }>;
  healthySourceCount?: number;
  totalSourceCount?: number;
  warnings: string[];
}

interface MqttSubscribeResult {
  ok: boolean;
  connected: boolean;
  brokerUrl?: string;
  connectLatencyMs?: number | null;
  firstMessageLatencyMs?: number | null;
  subscribedTopics?: string[];
  durationSeconds?: number;
  totalMessages?: number;
  uniqueTopicCount?: number;
  messagesPerSecond?: number;
  topicsSummary?: Array<{
    topic: string;
    messageCount: number;
    payloadType: string;
    validJson: boolean;
    cycleCounter?: unknown;
    populatedTimestamps?: number;
    anomalies?: string[];
    latestSample?: unknown;
    lastReceivedAt?: string;
  }>;
  warnings?: string[];
  diagnosis?: string;
  error?: string;
}

interface DebugAgentModuleProps {
  language: "en" | "zh";
  activeView: DebugAgentView;
  onViewChange: (view: DebugAgentView) => void;
}

function renderInlineMarkdown(text: string) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, idx) => {
    if (token.startsWith("`") && token.endsWith("`") && token.length >= 2) {
      return (
        <code key={idx} className="hermes-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith("**") && token.endsWith("**") && token.length >= 4) {
      return <strong key={idx}>{token.slice(2, -2)}</strong>;
    }
    return <span key={idx}>{token}</span>;
  });
}

function FormattedMessage({ content }: { content: string }) {
  const blocks = content.split(/```([\s\S]*?)```/g);
  return (
    <div className="hermes-markdown">
      {blocks.map((block, blockIdx) => {
        if (blockIdx % 2 === 1) {
          const firstNewline = block.indexOf("\n");
          const codeBody = firstNewline >= 0 ? block.slice(firstNewline + 1) : block;
          return (
            <pre key={blockIdx} className="hermes-code-block">
              <code>{codeBody.trimEnd()}</code>
            </pre>
          );
        }

        const lines = block.split("\n");
        const elements: React.ReactNode[] = [];
        let listItems: string[] = [];

        const flushList = (keyPrefix: string) => {
          if (listItems.length === 0) return;
          elements.push(
            <ul key={`${keyPrefix}-ul`} className="hermes-md-list">
              {listItems.map((item, idx) => (
                <li key={idx}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>,
          );
          listItems = [];
        };

        lines.forEach((rawLine, lineIdx) => {
          const line = rawLine.trimEnd();
          const trimmed = line.trim();
          if (!trimmed) {
            flushList(`${blockIdx}-${lineIdx}`);
            return;
          }
          if (/^#{1,4}\s+/.test(trimmed)) {
            flushList(`${blockIdx}-${lineIdx}`);
            const headingText = trimmed.replace(/^#{1,4}\s+/, "");
            elements.push(
              <h4 key={`${blockIdx}-${lineIdx}`} className="hermes-md-heading">
                {renderInlineMarkdown(headingText)}
              </h4>,
            );
            return;
          }
          if (/^[-*•]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
            listItems.push(trimmed.replace(/^(?:[-*•]|\d+\.)\s+/, ""));
            return;
          }
          flushList(`${blockIdx}-${lineIdx}`);
          elements.push(
            <p key={`${blockIdx}-${lineIdx}`} className="hermes-md-p">
              {renderInlineMarkdown(trimmed)}
            </p>,
          );
        });
        flushList(`${blockIdx}-end`);
        return <div key={blockIdx}>{elements}</div>;
      })}
    </div>
  );
}

function ToolTraceCard({ trace, zh }: { trace: ToolCallTrace; zh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const category =
    trace.tool.includes("mqtt") || trace.tool.includes("connector")
      ? "connector"
      : trace.tool.includes("c2m")
        ? "c2m"
        : "smartenance";

  return (
    <div className={`hermes-trace-item is-${category} ${trace.ok ? "is-ok" : "is-error"}`}>
      <button
        type="button"
        className="hermes-trace-header"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="hermes-trace-chevron">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="hermes-trace-name">{trace.tool}</span>
        <span className={`hermes-trace-badge ${trace.ok ? "is-ok" : "is-error"}`}>
          {trace.ok ? (zh ? "成功" : "OK") : zh ? "异常" : "Error"}
        </span>
        <span className="hermes-trace-time">{trace.durationMs} ms</span>
      </button>
      {expanded && (
        <div className="hermes-trace-body">
          {Object.keys(trace.arguments || {}).length > 0 && (
            <div className="hermes-trace-section">
              <div className="hermes-trace-label">{zh ? "调用参数" : "Arguments"}</div>
              <pre>{JSON.stringify(trace.arguments, null, 2)}</pre>
            </div>
          )}
          <div className="hermes-trace-section">
            <div className="hermes-trace-label">
              {trace.ok ? (zh ? "返回数据" : "Result") : zh ? "错误信息" : "Error"}
            </div>
            <pre>{trace.ok ? JSON.stringify(trace.result, null, 2) : trace.error}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DebugAgentModule({
  language,
  activeView,
  onViewChange,
}: DebugAgentModuleProps) {
  const zh = language === "zh";

  const [config, setConfig] = useState<HermesConfigClient | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [accounts, setAccounts] = useState<SmartenanceAccountInfo[]>([]);
  const [tools, setTools] = useState<HermesToolDefinition[]>([]);
  const [pythonBridge, setPythonBridge] = useState<{
    bridgeExists: boolean;
    pythonPath: string;
    usingVenv: boolean;
  } | null>(null);

  // Settings form state
  const [provider, setProvider] = useState("deepseek");
  const [apiFormat, setApiFormat] = useState<"openai" | "anthropic">("openai");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [model, setModel] = useState("deepseek-chat");
  const [smartenanceAccountKey, setSmartenanceAccountKey] = useState("auto");
  const [temperature, setTemperature] = useState("0.2");
  const [maxToolSteps, setMaxToolSteps] = useState("8");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [testingSettings, setTestingSettings] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<{
    type: "ok" | "error";
    text: string;
  } | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Direct quick diagnostics state (works with or without LLM API key)
  const [connectorDiag, setConnectorDiag] = useState<ConnectorOverviewResult | null>(null);
  const [connectorLoading, setConnectorLoading] = useState(false);
  const [mqttTopicInput, setMqttTopicInput] = useState("");
  const [mqttDuration, setMqttDuration] = useState(3);
  const [mqttDiag, setMqttDiag] = useState<MqttSubscribeResult | null>(null);
  const [mqttLoading, setMqttLoading] = useState(false);
  const [smartenanceDiag, setSmartenanceDiag] = useState<{
    accounts?: unknown;
    factory?: unknown;
    c2m?: unknown;
    error?: string;
  } | null>(null);
  const [smartenanceLoading, setSmartenanceLoading] = useState(false);

  const loadInitialState = useCallback(async () => {
    try {
      const [cfgRes, toolsRes] = await Promise.all([
        fetch("/api/debug-agent/config", { cache: "no-store" }),
        fetch("/api/debug-agent/tools", { cache: "no-store" }),
      ]);
      if (cfgRes.ok) {
        const data = (await cfgRes.json()) as {
          config: HermesConfigClient;
          presets: ProviderPreset[];
          accounts: SmartenanceAccountInfo[];
          pythonBridge: { bridgeExists: boolean; pythonPath: string; usingVenv: boolean };
        };
        setConfig(data.config);
        setPresets(data.presets ?? []);
        setAccounts(data.accounts ?? []);
        setPythonBridge(data.pythonBridge ?? null);

        setProvider(data.config.provider);
        setApiFormat(data.config.apiFormat);
        setBaseUrl(data.config.baseUrl);
        setModel(data.config.model);
        setSmartenanceAccountKey(data.config.smartenanceAccountKey || "auto");
        setTemperature(String(data.config.temperature ?? 0.2));
        setMaxToolSteps(String(data.config.maxToolSteps ?? 8));
        setSystemPrompt(data.config.systemPrompt ?? "");
      }
      if (toolsRes.ok) {
        const data = (await toolsRes.json()) as { tools: HermesToolDefinition[] };
        setTools(data.tools ?? []);
      }
    } catch {
      // Ignore initial load errors; user can retry in settings.
    }
  }, []);

  useEffect(() => {
    void loadInitialState();
  }, [loadInitialState]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const selectPreset = (preset: ProviderPreset) => {
    setProvider(preset.id);
    setApiFormat(preset.apiFormat);
    setBaseUrl(preset.defaultBaseUrl);
    setModel(preset.defaultModel);
    setSettingsNotice(null);
  };

  async function handleSaveSettings(event: React.FormEvent) {
    event.preventDefault();
    setSavingSettings(true);
    setSettingsNotice(null);
    try {
      const res = await fetch("/api/debug-agent/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiFormat,
          baseUrl,
          ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
          model,
          smartenanceAccountKey,
          temperature: Number(temperature),
          maxToolSteps: Number(maxToolSteps),
          systemPrompt,
        }),
      });
      const data = (await res.json()) as {
        saved?: boolean;
        config?: HermesConfigClient;
        error?: string;
      };
      if (!res.ok || !data.config) {
        throw new Error(data.error || "Failed to save Debug Agent configuration");
      }
      setConfig(data.config);
      setApiKeyDraft("");
      setSettingsNotice({
        type: "ok",
        text: zh
          ? "配置已保存到共享 PostgreSQL 数据库，立即生效。"
          : "Configuration saved to shared PostgreSQL database and activated.",
      });
    } catch (err) {
      setSettingsNotice({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleClearApiKey() {
    setSavingSettings(true);
    setSettingsNotice(null);
    try {
      const res = await fetch("/api/debug-agent/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearApiKey: true }),
      });
      const data = (await res.json()) as { config?: HermesConfigClient; error?: string };
      if (!res.ok || !data.config) throw new Error(data.error || "Failed to clear API key");
      setConfig(data.config);
      setApiKeyDraft("");
      setSettingsNotice({
        type: "ok",
        text: zh ? "已清除保存的 API Key。" : "Saved API key cleared.",
      });
    } catch (err) {
      setSettingsNotice({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleTestConnection() {
    setTestingSettings(true);
    setSettingsNotice(null);
    try {
      const res = await fetch("/api/debug-agent/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiFormat,
          baseUrl,
          ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
          model,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        model?: string;
        latencyMs?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Connection test failed");
      }
      setSettingsNotice({
        type: "ok",
        text: zh
          ? `模型连接成功：${data.model}（耗时 ${data.latencyMs} ms）`
          : `Model connected: ${data.model} (${data.latencyMs} ms)`,
      });
    } catch (err) {
      setSettingsNotice({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingSettings(false);
    }
  }

  async function sendMessage(promptText?: string) {
    const content = (promptText ?? input).trim();
    if (!content || sending) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    if (!promptText) setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/debug-agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          messages: nextHistory.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = (await res.json()) as {
        reply?: string;
        toolCalls?: ToolCallTrace[];
        model?: string;
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Debug Agent failed to respond.");
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: data.reply || (zh ? "（未返回文本内容）" : "(Empty response)"),
          toolCalls: data.toolCalls ?? [],
          model: data.model,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: err instanceof Error ? err.message : String(err),
          error: true,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function runConnectorDiagnostic() {
    setConnectorLoading(true);
    try {
      const res = await fetch("/api/debug-agent/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "get_connector_overview",
          arguments: { check_reachability: true },
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        result?: ConnectorOverviewResult;
        error?: string;
      };
      if (data.result) setConnectorDiag(data.result);
    } finally {
      setConnectorLoading(false);
    }
  }

  async function runMqttSample() {
    setMqttLoading(true);
    try {
      const topics = mqttTopicInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await fetch("/api/debug-agent/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "subscribe_connector_mqtt",
          arguments: {
            duration_seconds: mqttDuration,
            ...(topics.length > 0 ? { topics } : {}),
          },
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        result?: MqttSubscribeResult;
        error?: string;
      };
      if (data.result) {
        setMqttDiag(data.result);
      } else {
        setMqttDiag({ ok: false, connected: false, error: data.error || "Sampling failed" });
      }
    } finally {
      setMqttLoading(false);
    }
  }

  async function runSmartenanceAndC2mCheck() {
    setSmartenanceLoading(true);
    try {
      const [acctRes, factoryRes, c2mRes] = await Promise.all([
        fetch("/api/debug-agent/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "list_smartenance_accounts", arguments: {} }),
        }),
        fetch("/api/debug-agent/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "get_factory_overview", arguments: { machine_limit: 5 } }),
        }),
        fetch("/api/debug-agent/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "get_c2m_overview", arguments: {} }),
        }),
      ]);
      const acctData = (await acctRes.json()) as { ok: boolean; result?: unknown };
      const factoryData = (await factoryRes.json()) as {
        ok: boolean;
        result?: unknown;
        error?: string;
      };
      const c2mData = (await c2mRes.json()) as { ok: boolean; result?: unknown };
      setSmartenanceDiag({
        accounts: acctData.result,
        factory: factoryData.ok ? factoryData.result : undefined,
        c2m: c2mData.result,
        error: factoryData.ok ? undefined : factoryData.error,
      });
    } finally {
      setSmartenanceLoading(false);
    }
  }

  const quickPrompts = zh
    ? [
        {
          label: "全面检查 Connector 与 MQTT 推流",
          prompt:
            "请帮我全面检查当前 Connector 的配置和运行状态，并订阅已配置的 MQTT Topic 采样 3 秒，判断 PLC 轮询和 66 气缸数据推流是否正常。",
        },
        {
          label: "Smartenance 工厂概览与风险排行",
          prompt:
            "请查询 Smartenance 数据库的工厂概览与设备风险排行，总结当前最需要关注的未闭环故障机台。",
        },
        {
          label: "统计上月维修人员工时",
          prompt:
            "请统计 Smartenance 中上个月各维修人员的维修工时分配情况，并指出任何数据缺失或异常。",
        },
        {
          label: "检查 MSE6-C2M 气源与漏气状态",
          prompt:
            "请检查 MSE6-C2M 当前的供气压力、实时流量、能耗累计和漏气状态，以及 MQTT 转发是否正常。",
        },
      ]
    : [
        {
          label: "Diagnose Connector & MQTT Stream",
          prompt:
            "Inspect all saved Connector PLC & MQTT configurations, check poller status, and subscribe to the configured MQTT topics for 3 seconds to verify cylinder data publishing.",
        },
        {
          label: "Smartenance Factory Risk Ranking",
          prompt:
            "Query the Smartenance PostgreSQL snapshot for the factory overview and top risk-ranked machines with active incidents.",
        },
        {
          label: "Employee Repair Work Hours",
          prompt:
            "Summarize recorded Smartenance repair-task work hours by employee for the previous calendar month and flag any missing hours.",
        },
        {
          label: "Inspect MSE6-C2M Telemetry",
          prompt:
            "Check live MSE6-C2M supply pressure, airflow, leak status, and MQTT output telemetry.",
        },
      ];

  return (
    <div className="unified-module-container hermes-scope">
      <div className="unified-module-header">
        <div className="unified-module-title-group">
          <h1>
            Debug Agent
            <span>{config ? `${config.provider} · ${config.model}` : "Debug & Analytics"}</span>
          </h1>
        </div>
        <div className="unified-module-controls">
          <span className={`unified-status-pill ${config?.configured ? "is-connected" : ""}`}>
            <i />
            {config?.configured
              ? zh
                ? "模型已就绪"
                : "Model Ready"
              : zh
                ? "未配置 API Key"
                : "API Key Needed"}
          </span>
          <button
            type="button"
            className="hermes-header-btn"
            onClick={() => onViewChange(activeView === "settings" ? "chat" : "settings")}
          >
            <Settings2 size={15} />
            {activeView === "settings"
              ? zh
                ? "返回对话"
                : "Back to Chat"
              : zh
                ? "模型与 Key 设置"
                : "Model Settings"}
          </button>
        </div>
      </div>

      {/* VIEW 1: HERMES CHAT WORKSPACE */}
      {activeView === "chat" && (
        <div className="hermes-chat-layout">
          {config && !config.configured && (
            <div className="hermes-setup-banner">
              <div className="hermes-setup-banner-text">
                <ShieldAlert size={18} />
                <div>
                  <strong>{zh ? "尚未配置大模型 API Key" : "No LLM API Key configured yet"}</strong>
                  <p>
                    {zh
                      ? "你可以点击右侧配置客户专属的模型（DeepSeek / OpenAI / 通义千问 / 本地 Ollama），或先直接进入「实时巡检」免费运行 Connector / MQTT / Smartenance 诊断工具。"
                      : "Configure a customer model (DeepSeek / OpenAI / Qwen / local Ollama) in Model Settings, or open Quick Diagnostics to run live Connector, MQTT & Smartenance tools immediately."}
                  </p>
                </div>
              </div>
              <div className="hermes-setup-banner-actions">
                <button
                  type="button"
                  className="hermes-btn-secondary"
                  onClick={() => onViewChange("diagnostics")}
                >
                  <Zap size={14} />
                  {zh ? "前往实时巡检" : "Quick Diagnostics"}
                </button>
                <button
                  type="button"
                  className="hermes-btn-primary"
                  onClick={() => onViewChange("settings")}
                >
                  <Settings2 size={14} />
                  {zh ? "去配置模型" : "Configure Model"}
                </button>
              </div>
            </div>
          )}

          <div className="hermes-chat-card">
            <div className="hermes-chat-topbar">
              <div className="hermes-chat-meta">
                <Bot size={17} />
                <span>
                  {zh
                    ? `已挂载 ${tools.length || 15} 个实时工具（Smartenance 数据库 + Connector / MQTT 订阅 + MSE6-C2M）`
                    : `${tools.length || 15} live tools attached (Smartenance DB + Connector / MQTT + MSE6-C2M)`}
                </span>
              </div>
              {messages.length > 0 && (
                <button
                  type="button"
                  className="hermes-icon-text-btn"
                  onClick={() => setMessages([])}
                  disabled={sending}
                >
                  <Trash2 size={14} />
                  {zh ? "清空对话" : "Clear"}
                </button>
              )}
            </div>

            <div className="hermes-chat-messages">
              {messages.length === 0 ? (
                <div className="hermes-empty-state">
                  <div className="hermes-empty-badge">
                    <Sparkles size={24} />
                  </div>
                  <h3>
                    {zh
                      ? "Debug Agent 工业边缘与维保诊断助手"
                      : "Debug Agent · Edge & Maintenance Assistant"}
                  </h3>
                  <p>
                    {zh
                      ? "直接提问或选择下方快捷诊断任务，Debug Agent 将自动调用 PostgreSQL 维保分析工具、检查 PLC 轮询器并实时订阅 MQTT 数据流。"
                      : "Ask anything or choose a preset below. Debug Agent automatically queries Smartenance PostgreSQL analytics, checks PLC pollers, and samples live MQTT topics."}
                  </p>
                  <div className="hermes-quick-prompts">
                    {quickPrompts.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className="hermes-prompt-chip"
                        disabled={sending}
                        onClick={() => void sendMessage(item.prompt)}
                      >
                        <Sparkles size={14} />
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={`hermes-msg-row is-${msg.role}`}>
                    <div className={`hermes-msg-bubble ${msg.error ? "is-error" : ""}`}>
                      {msg.role === "assistant" && (
                        <div className="hermes-msg-role-head">
                          <span className="hermes-msg-role-tag">
                            <Bot size={13} /> Debug Agent
                          </span>
                          {msg.model && <span className="hermes-msg-model">{msg.model}</span>}
                        </div>
                      )}
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className="hermes-trace-list">
                          {msg.toolCalls.map((trace, idx) => (
                            <ToolTraceCard key={`${msg.id}-t-${idx}`} trace={trace} zh={zh} />
                          ))}
                        </div>
                      )}
                      {msg.role === "assistant" ? (
                        <FormattedMessage content={msg.content} />
                      ) : (
                        <div className="hermes-user-text">{msg.content}</div>
                      )}
                    </div>
                  </div>
                ))
              )}

              {sending && (
                <div className="hermes-msg-row is-assistant">
                  <div className="hermes-msg-bubble is-thinking">
                    <LoaderCircle size={16} className="spin" />
                    <span>
                      {zh
                        ? "Debug Agent 正在调用工具并分析实时数据…"
                        : "Debug Agent is calling tools and analyzing live data…"}
                    </span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <form
              className="hermes-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void sendMessage();
              }}
            >
              <textarea
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={
                  zh
                    ? "输入诊断问题，例如：检查当前 Connector 是否正常推送 66 气缸数据，或分析 Smartenance 高风险设备…"
                    : "Ask Debug Agent to inspect Connector MQTT streams, PLC pollers, C2M telemetry, or Smartenance incidents…"
                }
                disabled={sending}
              />
              <button type="submit" className="hermes-send-btn" disabled={sending || !input.trim()}>
                {sending ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
                <span>{zh ? "发送" : "Send"}</span>
              </button>
            </form>
          </div>
        </div>
      )}

      {/* VIEW 2: DIRECT LIVE DIAGNOSTICS WORKBENCH */}
      {activeView === "diagnostics" && (
        <div className="hermes-diag-grid">
          {/* Panel A: Connector Status & TCP Reachability */}
          <section className="hermes-panel">
            <div className="hermes-panel-head">
              <div className="hermes-panel-title">
                <Cpu size={18} />
                <h2>
                  {zh ? "Connector 运行态与 PLC 连通性检查" : "Connector & PLC Runtime Check"}
                </h2>
              </div>
              <button
                type="button"
                className="hermes-btn-primary"
                disabled={connectorLoading}
                onClick={() => void runConnectorDiagnostic()}
              >
                {connectorLoading ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Play size={15} />
                )}
                {zh ? "立即巡检" : "Run Check"}
              </button>
            </div>

            {connectorDiag && (
              <div className="hermes-diag-body">
                <div className="hermes-stat-strip">
                  <div className="hermes-stat-box">
                    <span>{zh ? "整体状态" : "Overall"}</span>
                    <strong
                      className={`hermes-pill is-${connectorDiag.overallStatus.toLowerCase()}`}
                    >
                      {connectorDiag.overallStatus}
                    </strong>
                  </div>
                  <div className="hermes-stat-box">
                    <span>MQTT Broker</span>
                    <strong>
                      {connectorDiag.mqttBroker
                        ? `${connectorDiag.mqttBroker.host}:${connectorDiag.mqttBroker.port}`
                        : zh
                          ? "未配置"
                          : "Not configured"}
                    </strong>
                    {connectorDiag.mqttBroker?.tcpReachability && (
                      <small>
                        {connectorDiag.mqttBroker.tcpReachability.reachable
                          ? `${zh ? "TCP 可达" : "Reachable"} (${connectorDiag.mqttBroker.tcpReachability.latencyMs} ms)`
                          : connectorDiag.mqttBroker.tcpReachability.error}
                      </small>
                    )}
                  </div>
                  <div className="hermes-stat-box">
                    <span>{zh ? "PLC 数据源" : "PLC Sources"}</span>
                    <strong>
                      {connectorDiag.healthySourceCount ?? 0} /{" "}
                      {connectorDiag.totalSourceCount ?? 0} {zh ? "正常" : "Healthy"}
                    </strong>
                  </div>
                </div>

                {connectorDiag.warnings.length > 0 && (
                  <div className="hermes-warning-box">
                    {connectorDiag.warnings.map((w, idx) => (
                      <div key={idx}>• {w}</div>
                    ))}
                  </div>
                )}

                {connectorDiag.sources.length > 0 && (
                  <div className="hermes-table-wrap">
                    <table className="hermes-table">
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>{zh ? "协议" : "Protocol"}</th>
                          <th>{zh ? "地址" : "Endpoint"}</th>
                          <th>{zh ? "轮询状态" : "Poller"}</th>
                          <th>TCP</th>
                          <th>Topics</th>
                        </tr>
                      </thead>
                      <tbody>
                        {connectorDiag.sources.map((src) => (
                          <tr key={`${src.protocol}-${src.id}`}>
                            <td>
                              <strong>{src.id}</strong>
                            </td>
                            <td>{src.protocol}</td>
                            <td>
                              <code>
                                {src.host}:{src.port}
                              </code>
                            </td>
                            <td>
                              <span className={`hermes-pill is-${src.pollingStatus.toLowerCase()}`}>
                                {src.pollingStatus}
                              </span>
                            </td>
                            <td>
                              {src.tcpReachability
                                ? src.tcpReachability.reachable
                                  ? `${src.tcpReachability.latencyMs} ms`
                                  : src.tcpReachability.error
                                : "—"}
                            </td>
                            <td>{src.configuredTopics.length}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Panel B: Live MQTT Subscription Sampler */}
          <section className="hermes-panel">
            <div className="hermes-panel-head">
              <div className="hermes-panel-title">
                <Radio size={18} />
                <h2>{zh ? "MQTT 实时订阅采样与气缸数据校验" : "Live MQTT Subscription Sampler"}</h2>
              </div>
              <button
                type="button"
                className="hermes-btn-primary"
                disabled={mqttLoading}
                onClick={() => void runMqttSample()}
              >
                {mqttLoading ? <LoaderCircle size={15} className="spin" /> : <Radio size={15} />}
                {mqttLoading
                  ? zh
                    ? `采样中 (${mqttDuration}s)…`
                    : `Sampling (${mqttDuration}s)…`
                  : zh
                    ? "开始订阅采样"
                    : "Subscribe & Sample"}
              </button>
            </div>

            <div className="hermes-inline-controls">
              <label className="hermes-field-inline">
                <span>
                  {zh
                    ? "自定义 Topic（留空自动读取 Connector 配置）"
                    : "Custom Topic Filter (blank = auto from Connector)"}
                </span>
                <input
                  type="text"
                  value={mqttTopicInput}
                  onChange={(e) => setMqttTopicInput(e.target.value)}
                  placeholder="festo-ax/pni/#, festo/plc/#"
                />
              </label>
              <label className="hermes-field-inline is-compact">
                <span>{zh ? "采样时长 (秒)" : "Duration (s)"}</span>
                <select
                  value={mqttDuration}
                  onChange={(e) => setMqttDuration(Number(e.target.value))}
                >
                  <option value={2}>2s</option>
                  <option value={3}>3s</option>
                  <option value={5}>5s</option>
                  <option value={8}>8s</option>
                </select>
              </label>
            </div>

            {mqttDiag && (
              <div className="hermes-diag-body">
                <div
                  className={`hermes-diagnosis-banner ${mqttDiag.ok && (mqttDiag.totalMessages ?? 0) > 0 ? "is-ok" : "is-warn"}`}
                >
                  <strong>{mqttDiag.diagnosis || mqttDiag.error}</strong>
                </div>

                {mqttDiag.connected && (
                  <div className="hermes-stat-strip">
                    <div className="hermes-stat-box">
                      <span>Broker</span>
                      <strong>{mqttDiag.brokerUrl}</strong>
                      <small>
                        {zh ? "连接耗时" : "Connect"}: {mqttDiag.connectLatencyMs ?? "—"} ms
                      </small>
                    </div>
                    <div className="hermes-stat-box">
                      <span>{zh ? "收到消息数" : "Messages"}</span>
                      <strong>
                        {mqttDiag.totalMessages ?? 0} ({mqttDiag.messagesPerSecond ?? 0} msg/s)
                      </strong>
                    </div>
                    <div className="hermes-stat-box">
                      <span>{zh ? "活跃 Topic 数" : "Active Topics"}</span>
                      <strong>{mqttDiag.uniqueTopicCount ?? 0}</strong>
                    </div>
                  </div>
                )}

                {mqttDiag.topicsSummary && mqttDiag.topicsSummary.length > 0 && (
                  <div className="hermes-topic-samples">
                    {mqttDiag.topicsSummary.map((item) => (
                      <details key={item.topic} className="hermes-topic-sample-item">
                        <summary>
                          <code>{item.topic}</code>
                          <span className="hermes-topic-meta">
                            {item.payloadType} · {item.messageCount} msg
                            {item.cycleCounter !== undefined
                              ? ` · cycle=${String(item.cycleCounter)}`
                              : ""}
                            {item.populatedTimestamps !== undefined
                              ? ` · ts=${item.populatedTimestamps}/6`
                              : ""}
                          </span>
                        </summary>
                        <pre>{JSON.stringify(item.latestSample, null, 2)}</pre>
                      </details>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Panel C: Smartenance Database & MSE6-C2M Snapshot */}
          <section className="hermes-panel">
            <div className="hermes-panel-head">
              <div className="hermes-panel-title">
                <Database size={18} />
                <h2>
                  {zh
                    ? "Smartenance 数据库与 MSE6-C2M 快照检查"
                    : "Smartenance DB & MSE6-C2M Snapshot"}
                </h2>
              </div>
              <button
                type="button"
                className="hermes-btn-primary"
                disabled={smartenanceLoading}
                onClick={() => void runSmartenanceAndC2mCheck()}
              >
                {smartenanceLoading ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Activity size={15} />
                )}
                {zh ? "检测快照" : "Inspect Snapshot"}
              </button>
            </div>

            {smartenanceDiag && (
              <div className="hermes-diag-body">
                {smartenanceDiag.error && (
                  <div className="hermes-warning-box">{smartenanceDiag.error}</div>
                )}
                <pre className="hermes-json-preview">
                  {JSON.stringify(
                    {
                      smartenanceAccounts: smartenanceDiag.accounts,
                      smartenanceOverview: smartenanceDiag.factory,
                      mse6C2m: smartenanceDiag.c2m,
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>
            )}
          </section>
        </div>
      )}

      {/* VIEW 3: MULTI-CUSTOMER MODEL & API KEY SETTINGS */}
      {activeView === "settings" && (
        <div className="hermes-settings-grid">
          <form className="hermes-panel" onSubmit={handleSaveSettings}>
            <div className="hermes-panel-head">
              <div className="hermes-panel-title">
                <Settings2 size={18} />
                <h2>{zh ? "模型与 API Key 配置" : "Model & API Key Configuration"}</h2>
              </div>
            </div>

            <div className="hermes-preset-grid">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`hermes-preset-card ${provider === preset.id ? "is-selected" : ""}`}
                  onClick={() => selectPreset(preset)}
                >
                  <strong>{preset.label}</strong>
                </button>
              ))}
            </div>

            <div className="hermes-form-grid">
              <label className="hermes-field">
                <span>Base URL</span>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                  required
                />
              </label>

              <label className="hermes-field">
                <span>{zh ? "模型名称 (Model)" : "Model Name"}</span>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat / gpt-4o / qwen2.5:14b"
                  required
                />
              </label>

              <label className="hermes-field">
                <span>
                  API Key{" "}
                  {config?.hasApiKey && (
                    <em className="hermes-saved-key-tag">
                      ({zh ? "已保存" : "Saved"}: {config.apiKeyMasked})
                    </em>
                  )}
                </span>
                <div className="hermes-key-row">
                  <input
                    type="password"
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    placeholder={
                      config?.hasApiKey
                        ? zh
                          ? "留空保持现有 Key，或输入新 Key 覆盖"
                          : "Leave blank to keep saved key, or enter new key"
                        : "sk-..."
                    }
                    autoComplete="off"
                  />
                  {config?.hasApiKey && (
                    <button
                      type="button"
                      className="hermes-btn-secondary"
                      onClick={() => void handleClearApiKey()}
                      disabled={savingSettings}
                    >
                      {zh ? "清除" : "Clear"}
                    </button>
                  )}
                </div>
              </label>

              <label className="hermes-field">
                <span>{zh ? "接口协议格式" : "API Format"}</span>
                <select
                  value={apiFormat}
                  onChange={(e) => setApiFormat(e.target.value as "openai" | "anthropic")}
                >
                  <option value="openai">OpenAI Compatible (/chat/completions)</option>
                  <option value="anthropic">Anthropic Messages (/messages)</option>
                </select>
              </label>

              <label className="hermes-field">
                <span>{zh ? "Smartenance 账号范围" : "Smartenance Account Scope"}</span>
                <select
                  value={smartenanceAccountKey}
                  onChange={(e) => setSmartenanceAccountKey(e.target.value)}
                >
                  <option value="auto">
                    {zh
                      ? "auto（自动选择最新同步的客户账号）"
                      : "auto (Auto-detect latest synced account)"}
                  </option>
                  {accounts.map((acct) => (
                    <option key={acct.account_key} value={acct.account_key}>
                      {acct.account_key.slice(0, 12)}… ({acct.machine_count}{" "}
                      {zh ? "台设备" : "machines"})
                    </option>
                  ))}
                </select>
              </label>

              <div className="hermes-field-pair">
                <label className="hermes-field">
                  <span>Temperature</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                  />
                </label>
                <label className="hermes-field">
                  <span>{zh ? "最大工具调用轮数" : "Max Tool Steps"}</span>
                  <input
                    type="number"
                    min="1"
                    max="16"
                    value={maxToolSteps}
                    onChange={(e) => setMaxToolSteps(e.target.value)}
                  />
                </label>
              </div>
            </div>

            <label className="hermes-field hermes-field-full">
              <span>
                {zh
                  ? "附加系统提示词（可选，定制客户现场规则）"
                  : "Additional System Instructions (Optional)"}
              </span>
              <textarea
                rows={3}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={
                  zh
                    ? "例如：重点关注 1 号产线 66 个气缸的压降与行程异常，报告中请附带设备编号…"
                    : "Optional site-specific instructions for Debug Agent…"
                }
              />
            </label>

            {settingsNotice && (
              <div className={`hermes-settings-notice is-${settingsNotice.type}`}>
                {settingsNotice.type === "ok" ? (
                  <CheckCircle2 size={16} />
                ) : (
                  <ShieldAlert size={16} />
                )}
                <span>{settingsNotice.text}</span>
              </div>
            )}

            <div className="hermes-form-actions">
              <button
                type="button"
                className="hermes-btn-secondary"
                disabled={testingSettings || savingSettings}
                onClick={() => void handleTestConnection()}
              >
                {testingSettings ? <LoaderCircle size={15} className="spin" /> : <Zap size={15} />}
                {zh ? "测试模型连接" : "Test Connection"}
              </button>
              <button type="submit" className="hermes-btn-primary" disabled={savingSettings}>
                {savingSettings ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Database size={15} />
                )}
                {zh ? "保存到数据库" : "Save Settings"}
              </button>
            </div>
          </form>

          {/* Runtime & Registered Tools Inventory */}
          <aside className="hermes-panel">
            <div className="hermes-panel-head">
              <div className="hermes-panel-title">
                <Wrench size={18} />
                <h2>{zh ? "已挂载工具与运行环境" : "Registered Tools & Runtime"}</h2>
              </div>
            </div>

            {pythonBridge && (
              <div className="hermes-runtime-info">
                <div>
                  <span>Python Bridge</span>
                  <code>{pythonBridge.pythonPath}</code>
                </div>
                <div>
                  <span>{zh ? "已同步 Smartenance 账号" : "Synced Smartenance Accounts"}</span>
                  <strong>{accounts.length}</strong>
                </div>
              </div>
            )}

            <div className="hermes-tools-list">
              {tools.map((tool) => (
                <div key={tool.name} className="hermes-tool-row">
                  <div className="hermes-tool-row-top">
                    <code>{tool.name}</code>
                    <span className={`hermes-cat-tag is-${tool.category}`}>{tool.category}</span>
                  </div>
                  <p>{tool.description}</p>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
