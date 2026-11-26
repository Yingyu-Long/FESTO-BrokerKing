import { useCallback, useEffect, useRef, useState } from "react";
import Panel from "../components/Panel";
import { api } from "../api";
import type { DeviceController } from "../dashboard/useDevice";
import { readStored, writeStored } from "../persistence";
import type { Language } from "../../translate";

type Connection = {
  protocol: "tcp" | "ssl";
  host: string;
  port: string;
  clientId: string;
  qos: "0" | "1" | "2";
  auth: "none" | "basic" | "certificates";
  username: string;
};
type Secrets = { password: string; ca: string; cert: string; key: string };
type Output = { topic: string; interval: string };
type MqttStatus = {
  enabled?: boolean;
  config: {
    brokerUrl: string;
    topic: string;
    interval: number;
    username: string;
    clientId: string;
    qos: number;
    auth: Connection["auth"];
  };
  status: "disconnected" | "connecting" | "connected" | "error";
  lastError: string | null;
  lastPublishedAt: number | null;
  publishedCount: number;
  dataReady: boolean;
};
const storageKey = "festo-c2m:mqtt-settings:v2";
const emptySecrets: Secrets = { password: "", ca: "", cert: "", key: "" };
const defaultConnection: Connection = {
  protocol: "tcp",
  host: "localhost",
  port: "1883",
  clientId: "",
  qos: "0",
  auth: "none",
  username: "",
};
const defaultOutput: Output = { topic: "ax/ei/+/+/+/+/+/+/+/+/+/pf/+", interval: "1000" };
function isConnection(value: unknown): value is Connection {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(defaultConnection).every((key) => typeof v[key] === "string") &&
    ["tcp", "ssl"].includes(String(v.protocol)) &&
    ["0", "1", "2"].includes(String(v.qos)) &&
    ["none", "basic", "certificates"].includes(String(v.auth))
  );
}
function isOutput(value: unknown): value is Output {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Output).topic === "string" &&
    typeof (value as Output).interval === "string"
  );
}
function initialSettings(): { connection: Connection; output: Output } {
  const saved = readStored(
    storageKey,
    (v): v is { connection: Connection; output: Output } =>
      !!v &&
      typeof v === "object" &&
      "connection" in v &&
      "output" in v &&
      isConnection(v.connection) &&
      isOutput(v.output),
  );
  if (saved) return saved;
  const old = readStored(
    "festo-c2m:mqtt-draft:v1",
    (v): v is Output & { brokerUrl: string; username: string } =>
      isOutput(v) &&
      "brokerUrl" in v &&
      typeof v.brokerUrl === "string" &&
      "username" in v &&
      typeof v.username === "string",
  );
  if (old) {
    try {
      const url = new URL(old.brokerUrl);
      return {
        connection: {
          ...defaultConnection,
          protocol: url.protocol === "mqtts:" ? "ssl" : "tcp",
          host: url.hostname,
          port: url.port || (url.protocol === "mqtts:" ? "8883" : "1883"),
          username: old.username,
          auth: old.username ? "basic" : "none",
        },
        output: { topic: old.topic, interval: old.interval },
      };
    } catch {
      /* Ignore an incomplete legacy draft. */
    }
  }
  return { connection: defaultConnection, output: defaultOutput };
}
function connectionBody(connection: Connection, secrets: Secrets) {
  const host =
    connection.host.includes(":") && !connection.host.startsWith("[")
      ? `[${connection.host}]`
      : connection.host;
  return {
    brokerUrl: `${connection.protocol === "ssl" ? "mqtts" : "mqtt"}://${host}:${connection.port}`,
    clientId: connection.clientId,
    qos: Number(connection.qos),
    auth: connection.auth,
    username: connection.auth === "basic" ? connection.username : "",
    ...(connection.auth === "basic" ? { password: secrets.password } : {}),
    ...(connection.auth === "certificates"
      ? { ca: secrets.ca, cert: secrets.cert, key: secrets.key }
      : {}),
  };
}

export default function MqttOutput({
  language,
  device,
  notify,
}: {
  language: Language;
  device: DeviceController;
  notify: (message: string) => void;
}) {
  const zh = language === "zh";
  const [initial] = useState(initialSettings);
  const [saved, setSaved] = useState(initial.connection);
  const [connection, setConnection] = useState(initial.connection);
  const [output, setOutput] = useState(initial.output);
  const [secrets, setSecrets] = useState(emptySecrets);
  const [savedSecrets, setSavedSecrets] = useState(emptySecrets);
  const [status, setStatus] = useState<MqttStatus | null>(null);
  const [outputEnabled, setOutputEnabled] = useState(false);
  const [busy, setBusy] = useState<"test" | "start" | "stop" | null>(null);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [testPassed, setTestPassed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const outputForm = useRef<HTMLFormElement>(null);
  const edited = useRef(false);
  const hydrated = useRef(false);
  const requestGeneration = useRef(0);
  const rememberStatus = useCallback((next: MqttStatus, requested?: boolean) => {
    setStatus(next);
    // Existing running backends may not expose enabled until their next restart.
    setOutputEnabled(
      (previous) =>
        next.enabled ??
        requested ??
        (next.status !== "disconnected" || !!next.lastError || previous),
    );
  }, []);
  useEffect(() => {
    if (busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const generation = requestGeneration.current;
      try {
        const next = await api<MqttStatus>("/mqtt/status");
        if (!cancelled && generation === requestGeneration.current) {
          rememberStatus(next);
          setUnavailable(false);
          // An active backend is authoritative when no local edits have been made.
          if (!hydrated.current && !edited.current && next.status !== "disconnected") {
            const url = new URL(next.config.brokerUrl);
            const active: Connection = {
              protocol: url.protocol === "mqtts:" ? "ssl" : "tcp",
              host: url.hostname,
              port: url.port || (url.protocol === "mqtts:" ? "8883" : "1883"),
              clientId: next.config.clientId || "",
              qos: String(next.config.qos ?? 0) as Connection["qos"],
              auth: next.config.auth || "none",
              username: next.config.username,
            };
            setSaved(active);
            setConnection(active);
            setOutput({ topic: next.config.topic, interval: String(next.config.interval) });
          }
          hydrated.current = true;
        }
      } catch {
        if (!cancelled && generation === requestGeneration.current) setUnavailable(true);
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 1000);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [busy, rememberStatus]);

  function updateConnection(patch: Partial<Connection>) {
    edited.current = true;
    setConnection({ ...connection, ...patch });
    setTestPassed(false);
    setConnectionError("");
  }
  function updateSecrets(patch: Partial<Secrets>) {
    edited.current = true;
    setSecrets({ ...secrets, ...patch });
    setTestPassed(false);
  }
  function save() {
    edited.current = true;
    setSaved(connection);
    setSavedSecrets(secrets);
    writeStored(storageKey, { connection, output });
    notify(zh ? "MQTT 配置已保存" : "MQTT settings saved");
  }
  function cancel() {
    setConnection(saved);
    setSecrets(savedSecrets);
    setConnectionError("");
    setTestPassed(false);
  }
  function updateOutput(patch: Partial<Output>) {
    edited.current = true;
    const next = { ...output, ...patch };
    setOutput(next);
    writeStored(storageKey, { connection: saved, output: next });
    setError("");
  }
  function message(e: unknown) {
    const text = e instanceof Error ? e.message : String(e);
    return text === "Method not allowed"
      ? zh
        ? "MQTT 服务暂不可用"
        : "MQTT service unavailable"
      : text;
  }
  async function testConnection() {
    if (!form.current?.reportValidity()) return;
    requestGeneration.current++;
    setBusy("test");
    setConnectionError("");
    setTestPassed(false);
    try {
      await api("/mqtt/test", connectionBody(connection, secrets));
      setTestPassed(true);
    } catch (e) {
      setConnectionError(message(e));
    } finally {
      requestGeneration.current++;
      setBusy(null);
    }
  }
  async function run(start: boolean) {
    requestGeneration.current++;
    setBusy(start ? "start" : "stop");
    setError("");
    try {
      const next = await api<MqttStatus>(
        start ? "/mqtt/connect" : "/mqtt/disconnect",
        start
          ? {
              ...connectionBody(saved, savedSecrets),
              topic: output.topic,
              interval: Number(output.interval),
            }
          : {},
      );
      rememberStatus(next, start);
      setUnavailable(false);
      notify(
        start
          ? zh
            ? "正在连接 MQTT"
            : "Connecting to MQTT"
          : zh
            ? "MQTT 输出已停止"
            : "MQTT output stopped",
      );
    } catch (e) {
      setError(message(e));
    } finally {
      requestGeneration.current++;
      setBusy(null);
    }
  }
  const dirty =
    JSON.stringify(connection) !== JSON.stringify(saved) ||
    JSON.stringify(secrets) !== JSON.stringify(savedSecrets);
  const labels = {
    disconnected: zh ? "未连接" : "Disconnected",
    connecting: zh ? "连接中" : "Connecting",
    connected: zh ? "已连接" : "Connected",
    error: zh ? "连接错误" : "Connection error",
  };
  const telemetry = device.dataReady ? device.backend?.telemetry : null;
  const payload = telemetry
    ? { rawAirFlow: telemetry.flow, rawAirPressure: telemetry.pressure }
    : null;
  return (
    <div className="mqtt-page">
      <Panel
        title={zh ? "MQTT 连接" : "MQTT Connection"}
        className="mqtt-connection-panel"
        extra={
          <span className="badge">
            {unavailable
              ? zh
                ? "服务未就绪"
                : "Service unavailable"
              : status
                ? labels[status.status]
                : zh
                  ? "加载中…"
                  : "Loading…"}
          </span>
        }
      >
        <form
          ref={form}
          className="mqtt-connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <fieldset className="mqtt-connection-fields" disabled={!!busy}>
            <div className="mqtt-address-row">
              <label className="field">
                <span>{zh ? "协议" : "Protocol"} *</span>
                <select
                  value={connection.protocol}
                  onChange={(e) =>
                    updateConnection({
                      protocol: e.target.value as Connection["protocol"],
                      ...(e.target.value === "tcp" && connection.auth === "certificates"
                        ? { auth: "none" }
                        : {}),
                    })
                  }
                >
                  <option value="tcp">tcp://</option>
                  <option value="ssl">ssl://</option>
                </select>
              </label>
              <label className="field">
                <span>{zh ? "主机" : "Host"} *</span>
                <input
                  required
                  value={connection.host}
                  pattern={String.raw`[a-zA-Z0-9.:\[\]\-]+`}
                  onChange={(e) => updateConnection({ host: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{zh ? "端口" : "Port"} *</span>
                <input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  step={1}
                  value={connection.port}
                  onChange={(e) => updateConnection({ port: e.target.value })}
                />
              </label>
            </div>
            <div className="mqtt-identity-row">
              <label className="field">
                <span>Client ID</span>
                <input
                  value={connection.clientId}
                  onChange={(e) => updateConnection({ clientId: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{zh ? "服务质量 (QoS)" : "Quality of service"}</span>
                <select
                  value={connection.qos}
                  onChange={(e) => updateConnection({ qos: e.target.value as Connection["qos"] })}
                >
                  <option value="0">0</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </label>
            </div>
            <fieldset className="mqtt-auth">
              <legend>{zh ? "认证方式" : "Authentication"}</legend>
              <div className="mqtt-auth-options">
                {(
                  [
                    ["basic", zh ? "账号密码" : "Basic Authentication"],
                    ["certificates", zh ? "证书" : "Certificates"],
                    ["none", zh ? "无认证" : "None"],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="mqtt-auth"
                      value={value}
                      checked={connection.auth === value}
                      onChange={() =>
                        updateConnection({
                          auth: value,
                          ...(value === "certificates" ? { protocol: "ssl" } : {}),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            {connection.auth === "basic" && (
              <div className="mqtt-credentials">
                <label className="field">
                  <span>{zh ? "用户名" : "Username"}</span>
                  <input
                    required
                    autoComplete="username"
                    value={connection.username}
                    onChange={(e) => updateConnection({ username: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{zh ? "密码" : "Password"}</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={secrets.password}
                    onChange={(e) => updateSecrets({ password: e.target.value })}
                  />
                </label>
              </div>
            )}
            {connection.auth === "certificates" && (
              <div className="mqtt-certificates">
                {(
                  [
                    ["ca", zh ? "CA 证书 (PEM，可选)" : "CA certificate (PEM, optional)"],
                    ["cert", zh ? "客户端证书 (PEM)" : "Client certificate (PEM)"],
                    ["key", zh ? "私钥 (PEM)" : "Private key (PEM)"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <textarea
                      required={key !== "ca"}
                      rows={3}
                      maxLength={32768}
                      value={secrets[key]}
                      spellCheck={false}
                      onChange={(e) => updateSecrets({ [key]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
            )}
            <div className="mqtt-test-row">
              <button
                type="button"
                className="button mqtt-test-button"
                onClick={() => void testConnection()}
              >
                {busy === "test"
                  ? zh
                    ? "测试中…"
                    : "Testing…"
                  : zh
                    ? "测试连接"
                    : "Test connection"}
              </button>
              {testPassed && (
                <span className="mqtt-test-success" role="status">
                  {zh ? "连接测试成功" : "Connection successful"}
                </span>
              )}
            </div>
            {connectionError && (
              <p className="mqtt-error" role="alert">
                {connectionError}
              </p>
            )}
          </fieldset>
          <div className="mqtt-save-actions">
            <button type="submit" className="button primary" disabled={!!busy}>
              {zh ? "保存" : "Save"}
            </button>
            <button type="button" className="button" disabled={!!busy} onClick={cancel}>
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </form>
      </Panel>
      <div className="mqtt-layout">
        <Panel title={zh ? "MQTT 输出" : "MQTT Output"}>
          <form ref={outputForm} onSubmit={(event) => event.preventDefault()}>
            <div className="form-grid mqtt-form">
              <label className="field mqtt-wide">
                <span>Topic</span>
                <input
                  required
                  pattern="[^+#]+"
                  value={output.topic}
                  disabled={!!busy}
                  onChange={(e) => {
                    e.target.setCustomValidity("");
                    updateOutput({ topic: e.target.value });
                  }}
                  onInvalid={(e) =>
                    e.currentTarget.setCustomValidity(
                      zh ? "请填写有效的发布 Topic" : "Enter a valid publish topic",
                    )
                  }
                />
              </label>
              <label className="field">
                <span>{zh ? "发送间隔 (ms)" : "Publish interval (ms)"}</span>
                <input
                  type="number"
                  required
                  min={100}
                  max={60000}
                  step={1}
                  disabled={!!busy}
                  value={output.interval}
                  onChange={(e) => updateOutput({ interval: e.target.value })}
                />
              </label>
            </div>
            {(error || (!unavailable && status?.lastError)) && (
              <p className="form-error" role="alert">
                {error || status?.lastError}
              </p>
            )}
            <div className="form-actions">
              {dirty && !outputEnabled && (
                <span>{zh ? "请先保存连接配置" : "Save the connection settings first"}</span>
              )}
              <div className="mqtt-output-toggle" data-enabled={outputEnabled}>
                <span className="mqtt-output-state" aria-live="polite">
                  {busy === "start"
                    ? zh
                      ? "开启中…"
                      : "Enabling…"
                    : busy === "stop"
                      ? zh
                        ? "关闭中…"
                        : "Disabling…"
                      : outputEnabled
                        ? zh
                          ? "已开启"
                          : "On"
                        : zh
                          ? "已关闭"
                          : "Off"}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={outputEnabled}
                  aria-label={zh ? "MQTT 输出" : "MQTT output"}
                  aria-busy={busy === "start" || busy === "stop"}
                  className="mqtt-output-switch"
                  disabled={!!busy || !status || unavailable || (!outputEnabled && dirty)}
                  onClick={() => {
                    if (outputEnabled || outputForm.current?.reportValidity())
                      void run(!outputEnabled);
                  }}
                >
                  <span className="mqtt-switch-thumb">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d={outputEnabled ? "m6 12 4 4 8-8" : "M8 12h8"} />
                    </svg>
                  </span>
                </button>
              </div>
            </div>
          </form>
        </Panel>
        <Panel title={zh ? "输出数据" : "Output data"}>
          <div className="mqtt-output-body">
            <div className="mqtt-table-scroll">
              <table className="mqtt-table">
                <thead>
                  <tr>
                    <th>{zh ? "字段" : "Field"}</th>
                    <th>{zh ? "当前值" : "Current value"}</th>
                    <th>{zh ? "单位" : "Unit"}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>rawAirFlow</code>
                    </td>
                    <td>{payload?.rawAirFlow ?? "—"}</td>
                    <td>l/min</td>
                  </tr>
                  <tr>
                    <td>
                      <code>rawAirPressure</code>
                    </td>
                    <td>{payload?.rawAirPressure ?? "—"}</td>
                    <td>bar</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {payload && <pre className="mqtt-preview">{JSON.stringify(payload, null, 2)}</pre>}
            {status && (
              <dl className="mqtt-details">
                <div>
                  <dt>{zh ? "已发送消息" : "Messages sent"}</dt>
                  <dd>{status.publishedCount}</dd>
                </div>
                <div>
                  <dt>{zh ? "最近发送" : "Last sent"}</dt>
                  <dd>
                    {status.lastPublishedAt
                      ? new Date(status.lastPublishedAt).toLocaleString(zh ? "zh-CN" : "en-US")
                      : "—"}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
