import mqtt from "mqtt";
import { createSecureContext } from "node:tls";

export const defaultMqttConfig = {
  brokerUrl: "mqtt://localhost:1883",
  topic: "ax/ei/+/+/+/+/+/+/+/+/+/pf/+",
  username: "",
  clientId: "",
  qos: 0,
  auth: "none",
  interval: 1000,
};

function invalid(message) {
  throw Object.assign(new Error(message), { code: "VALIDATION", status: 400 });
}

export function mqttConnectionConfig(body) {
  if (!body || typeof body !== "object") invalid("Invalid MQTT configuration");
  let url;
  try {
    url = new URL(body.brokerUrl?.replace(/^tcp:/, "mqtt:").replace(/^ssl:/, "mqtts:"));
  } catch {
    invalid("Invalid MQTT broker URL");
  }
  if (
    !["mqtt:", "mqtts:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    invalid("Use mqtt://host:port or mqtts://host:port; enter credentials separately");
  if (url.port === "0") invalid("Invalid MQTT port");
  for (const key of ["username", "password", "clientId"])
    if (
      body[key] !== undefined &&
      (typeof body[key] !== "string" ||
        Buffer.byteLength(body[key]) > 4096 ||
        body[key].includes("\0") ||
        !body[key].isWellFormed())
    )
      invalid(`Invalid MQTT ${key}`);
  const qos = body.qos ?? 0;
  if (![0, 1, 2].includes(qos)) invalid("Invalid MQTT QoS");
  const auth = body.auth ?? (body.username || body.password ? "basic" : "none");
  if (!["none", "basic", "certificates"].includes(auth)) invalid("Invalid MQTT authentication");
  const tls = {};
  if (auth === "certificates") {
    if (url.protocol !== "mqtts:") invalid("Certificate authentication requires TLS");
    for (const key of ["ca", "cert", "key"])
      if (typeof body[key] !== "string" || Buffer.byteLength(body[key]) > 32768)
        invalid(`Invalid MQTT ${key}`);
    if (!body.cert || !body.key) invalid("Client certificate and private key are required");
    Object.assign(tls, { ca: body.ca || undefined, cert: body.cert, key: body.key });
    try {
      createSecureContext(tls);
    } catch {
      invalid("Invalid MQTT certificate or private key");
    }
  }
  return {
    brokerUrl: url.href,
    clientId: body.clientId || "",
    qos,
    auth,
    username: auth === "basic" ? body.username || "" : "",
    password: auth === "basic" ? body.password || "" : "",
    ...tls,
  };
}

export function mqttConfig(body) {
  const connection = mqttConnectionConfig(body);
  if (
    typeof body.topic !== "string" ||
    !body.topic.trim() ||
    Buffer.byteLength(body.topic) > 65535 ||
    /[+#]/u.test(body.topic) ||
    body.topic.includes("\0") ||
    !body.topic.isWellFormed()
  )
    invalid(
      "Publish topic must be nonempty and contain no +, # or null characters. Replace template placeholders first.",
    );
  if (!Number.isInteger(body.interval) || body.interval < 100 || body.interval > 60000)
    invalid("MQTT interval must be 100–60000 ms");
  return {
    ...connection,
    topic: body.topic,
    interval: body.interval,
  };
}

function clientOptions(config) {
  return {
    clientId: config.clientId || undefined,
    username: config.username || undefined,
    password: config.password || undefined,
    ca: config.ca,
    cert: config.cert,
    key: config.key,
    rejectUnauthorized: true,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 10000,
    queueQoSZero: false,
  };
}

export function outputPayload(snapshot) {
  const data = snapshot.telemetry;
  if (
    snapshot.status !== "connected" ||
    !snapshot.fresh ||
    !data ||
    !Number.isFinite(data.flow) ||
    !Number.isFinite(data.pressure)
  )
    return null;
  // DeviceService already converts its process data to l/min and bar.
  return { rawAirFlow: data.flow, rawAirPressure: data.pressure };
}

export class MqttOutputService {
  constructor(device, connect = mqtt.connect) {
    this.device = device;
    this.connectClient = connect;
    this.config = { ...defaultMqttConfig };
    this.status = "disconnected";
    this.lastError = null;
    this.lastPublishedAt = null;
    this.lastPayload = null;
    this.publishedCount = 0;
  }

  snapshot() {
    return {
      config: { ...this.config },
      status: this.status,
      enabled: !!this.client,
      lastError: this.lastError,
      lastPublishedAt: this.lastPublishedAt,
      lastPayload: this.lastPayload,
      publishedCount: this.publishedCount,
      dataReady: outputPayload(this.device.snapshot()) !== null,
    };
  }

  start(body) {
    const connection = mqttConfig(body);
    const config = Object.fromEntries(
      Object.entries(connection).filter(
        ([key]) => !["password", "ca", "cert", "key"].includes(key),
      ),
    );
    this.stop();
    this.config = config;
    this.status = "connecting";
    this.lastError = null;
    this.lastPublishedAt = null;
    this.lastPayload = null;
    this.publishedCount = 0;
    let client;
    try {
      client = this.connectClient(config.brokerUrl, clientOptions(connection));
    } catch (error) {
      this.status = "error";
      this.lastError = error.message;
      throw error;
    }
    this.client = client;
    const current = () => this.client === client;
    client.on("connect", () => {
      if (!current()) return;
      this.status = "connected";
      this.lastError = null;
      this.publish();
    });
    client.on("reconnect", () => {
      if (current()) this.status = "connecting";
    });
    client.on("close", () => {
      if (current()) {
        this.status = "disconnected";
        if (this.config.qos === 0) this.pending = false;
      }
    });
    client.on("error", (error) => {
      if (!current()) return;
      this.status = "error";
      this.lastError = error.message;
    });
    this.timer = setInterval(() => this.publish(), config.interval);
    this.timer.unref?.();
    return this.snapshot();
  }

  publish() {
    const client = this.client;
    if (!client?.connected || this.pending) return;
    const sample = this.device.snapshot();
    const payload = outputPayload(sample);
    const sampleKey = JSON.stringify([
      sample.connection,
      sample.telemetry?.timestamp,
      sample.telemetry?.tick,
    ]);
    if (!payload || this.lastSample === sampleKey) return;
    this.pending = true;
    // Keep at most one message in flight; QoS 1/2 complete after broker acknowledgment.
    const done = (error) => {
      if (this.client !== client) return;
      this.pending = false;
      if (error) {
        this.lastError = error.message;
        return;
      }
      this.lastSample = sampleKey;
      this.lastError = null;
      this.lastPublishedAt = Date.now();
      this.lastPayload = payload;
      this.publishedCount++;
    };
    try {
      client.publish(
        this.config.topic,
        JSON.stringify(payload),
        { qos: this.config.qos, retain: false },
        done,
      );
    } catch (error) {
      done(error);
    }
  }

  async testConnection(body) {
    const config = mqttConnectionConfig(body);
    if (
      this.client &&
      config.clientId &&
      config.clientId === this.config.clientId &&
      config.brokerUrl === this.config.brokerUrl
    )
      invalid("Stop output before testing the same client ID");
    return new Promise((resolve, reject) => {
      let client;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client?.end(true);
        if (error) reject(error);
        else resolve({ ok: true });
      };
      const timer = setTimeout(() => finish(new Error("MQTT connection timed out")), 10000);
      try {
        client = this.connectClient(config.brokerUrl, {
          ...clientOptions(config),
          reconnectPeriod: 0,
        });
        client.once("connect", () => finish());
        client.on("error", finish);
        client.once("close", () => finish(new Error("MQTT connection closed")));
      } catch (error) {
        finish(error);
      }
    });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    const client = this.client;
    this.client = null;
    this.pending = false;
    this.lastSample = null;
    this.status = "disconnected";
    this.lastError = null;
    client?.end(true);
    return this.snapshot();
  }
}
