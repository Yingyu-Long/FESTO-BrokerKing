import net from "node:net";
import mqtt from "mqtt";
import { query as defaultQuery } from "../database.js";
import {
  extractModbusSourcesFromConfiguration,
  extractMqttConfigFromConfiguration,
} from "../connector/plc/modbusBootstrap.js";
import { getModbusPollerStatus, listActiveModbusPollers } from "../connector/plc/modbusPoller.js";
import { getCustomisedModbusPollerStatus } from "../connector/plc/modbusCustomisedPoller.js";
import { getSiemensPollerStatus } from "../connector/plc/poller.js";
import { CUSTOMISED_PROTOCOL } from "../../shared/modbusCustomised.js";

const SIX_TIMESTAMPS = [
  "timestamp_DI_IPos_ON",
  "timestamp_DI_IPos_OFF",
  "timestamp_DI_EPos_ON",
  "timestamp_DI_EPos_OFF",
  "timestamp_DO_MCtrl12_ON",
  "timestamp_DO_MCtrl12_OFF",
];

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clamp(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

export function probeTcpReachability(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const cleanHost = String(host ?? "").trim();
    const numericPort = Number(port);
    if (!cleanHost || !Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
      resolve({ reachable: false, latencyMs: null, error: "Invalid host or port" });
      return;
    }

    const startedAt = Date.now();
    let settled = false;
    const socket = net.createConnection({ host: cleanHost, port: numericPort });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish({ reachable: true, latencyMs: Date.now() - startedAt, error: null });
    });
    socket.once("timeout", () => {
      finish({
        reachable: false,
        latencyMs: Date.now() - startedAt,
        error: `TCP timeout after ${timeoutMs}ms`,
      });
    });
    socket.once("error", (error) => {
      finish({
        reachable: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

function getMqttBrokerUrl(mqttConfig) {
  const protocol = ["tcp://", "tcp:", "mqtt://", "mqtt:"].includes(mqttConfig.protocol)
    ? "mqtt://"
    : (mqttConfig.protocol ?? "mqtt://");
  return `${protocol}${mqttConfig.host}:${mqttConfig.port}`;
}

function defaultPortForProtocol(protocol) {
  if (protocol.startsWith("modbus")) return 502;
  if (protocol.startsWith("siemens") || protocol === "s7") return 102;
  if (protocol.startsWith("opc")) return 4840;
  if (protocol.startsWith("rockwell")) return 44818;
  if (protocol.startsWith("beckhoff")) return 48898;
  return 502;
}

function extractTopicsForSource(source, protocol, pollerStatus) {
  const topics = new Set();
  if (Array.isArray(pollerStatus?.mqttTopics)) {
    for (const t of pollerStatus.mqttTopics) {
      if (typeof t === "string" && t.trim()) topics.add(t.trim());
    }
  }
  if (typeof pollerStatus?.mqttTopic === "string" && pollerStatus.mqttTopic.trim()) {
    topics.add(pollerStatus.mqttTopic.trim());
  }
  if (Array.isArray(pollerStatus?.dataBlocks)) {
    for (const block of pollerStatus.dataBlocks) {
      const candidate = block?.topic || block?.mqttTopic;
      if (typeof candidate === "string" && candidate.trim()) topics.add(candidate.trim());
    }
  }

  const raw = isRecord(source?.configuration)
    ? source.configuration
    : isRecord(source?.[`${protocol}Configuration`])
      ? source[`${protocol}Configuration`]
      : {};

  if (Array.isArray(raw.blockTopics)) {
    for (const entry of raw.blockTopics) {
      if (typeof entry === "string" && entry.trim()) {
        topics.add(entry.trim());
      } else if (isRecord(entry) && typeof entry.topic === "string" && entry.topic.trim()) {
        topics.add(entry.topic.trim());
      }
    }
  }
  if (typeof raw.mqttTopic === "string" && raw.mqttTopic.trim()) {
    topics.add(raw.mqttTopic.trim());
  }
  if (topics.size === 0 && typeof source?.id === "string" && source.id.trim()) {
    if (protocol === "modbus.tcp" && raw.readMode !== "Read by Datablocks") {
      topics.add(`festo/plc/${source.id.trim()}`);
    }
  }
  return Array.from(topics);
}

export async function loadSavedConnectorConfiguration(queryFn = defaultQuery) {
  const result = await queryFn(
    `
    SELECT id, configuration, updated_at
    FROM public.connector_configurations
    ORDER BY updated_at DESC
    LIMIT 1
    `,
  );
  if (!result.rows[0]) return null;
  return {
    id: result.rows[0].id,
    updatedAt: result.rows[0].updated_at ?? null,
    configuration: result.rows[0].configuration,
  };
}

export async function getConnectorOverview({
  queryFn = defaultQuery,
  checkReachability = true,
  probeTcp = probeTcpReachability,
} = {}) {
  const saved = await loadSavedConnectorConfiguration(queryFn);
  const activeModbusPollers = listActiveModbusPollers();

  if (!saved?.configuration) {
    return {
      configured: false,
      overallStatus: "NOT_CONFIGURED",
      summary: "No Connector configuration has been saved in PostgreSQL yet.",
      mqttBroker: null,
      sources: [],
      activeModbusPollerCount: activeModbusPollers.length,
      warnings: ["Configure an MQTT broker and at least one PLC in the Connector module first."],
    };
  }

  const cfg = saved.configuration;
  const mqttConfig = extractMqttConfigFromConfiguration(cfg);
  const normalizedModbusSources = extractModbusSourcesFromConfiguration(cfg);
  const modbusTopicLookup = new Map();
  for (const entry of normalizedModbusSources) {
    const key = `${entry.namespace}:${entry.id}`;
    const topics =
      entry.config.readMode === "Read by Datablocks"
        ? (entry.config.blockTopics ?? [])
            .map((t) => (typeof t === "string" ? t : t?.topic))
            .filter(Boolean)
        : [entry.config.mqttTopic || `festo/plc/${entry.id}`];
    modbusTopicLookup.set(key, topics);
  }

  let mqttReachability = null;
  if (mqttConfig && checkReachability) {
    mqttReachability = await probeTcp(mqttConfig.host, mqttConfig.port);
  }

  const rawSources = Array.isArray(cfg.messageSources) ? cfg.messageSources : [];
  const sources = [];
  const warnings = [];

  if (!mqttConfig) {
    warnings.push("MQTT broker host is not configured in mqttMessageHandler.uri.");
  } else if (mqttReachability && !mqttReachability.reachable) {
    warnings.push(
      `MQTT broker ${mqttConfig.host}:${mqttConfig.port} is unreachable (${mqttReachability.error}).`,
    );
  }

  for (const source of rawSources) {
    if (!isRecord(source)) continue;
    let parsedUri = null;
    try {
      if (typeof source.uri === "string") parsedUri = new URL(source.uri);
    } catch {
      parsedUri = null;
    }

    const protocol = parsedUri
      ? parsedUri.protocol.replace(":", "")
      : String(source.type ?? "unknown");
    const id = String(source.id ?? source.uniqueKey ?? "unknown").trim();
    const rawCfg = isRecord(source.configuration)
      ? source.configuration
      : isRecord(source[`${protocol}Configuration`])
        ? source[`${protocol}Configuration`]
        : {};
    const host = parsedUri?.hostname || String(rawCfg.host ?? "").trim();
    const port = Number(parsedUri?.port || rawCfg.port || defaultPortForProtocol(protocol));

    let pollerStatus = null;
    let pollerActive = false;
    if (protocol === "modbus.tcp") {
      pollerStatus = getModbusPollerStatus(id, "modbus");
      pollerActive = activeModbusPollers.some((p) => p.namespace === "modbus" && p.id === id);
    } else if (protocol === CUSTOMISED_PROTOCOL) {
      pollerStatus = getCustomisedModbusPollerStatus(id);
      pollerActive = activeModbusPollers.some((p) => p.namespace === "customised" && p.id === id);
    } else if (protocol.includes("siemens") || protocol === "s7") {
      pollerStatus = getSiemensPollerStatus(id);
      pollerActive = pollerStatus?.pollingStatus === "HEALTHY";
    }

    const reachability = checkReachability && host ? await probeTcp(host, port) : null;
    const topics = Array.from(
      new Set([
        ...extractTopicsForSource(source, protocol, pollerStatus),
        ...(modbusTopicLookup.get(
          `${protocol === CUSTOMISED_PROTOCOL ? "customised" : "modbus"}:${id}`,
        ) ?? []),
      ]),
    );

    const statusLabel = pollerStatus?.pollingStatus ?? "UNKNOWN";
    if (statusLabel === "UNHEALTHY") {
      warnings.push(
        `PLC "${id}" (${host}:${port}) poller is UNHEALTHY${pollerStatus?.error ? `: ${pollerStatus.error}` : ""}.`,
      );
    } else if (statusLabel === "MQTT_NOT_CONFIGURED") {
      warnings.push(`PLC "${id}" is reading data, but MQTT publishing is not configured.`);
    } else if (statusLabel === "NOT_CONNECTED") {
      warnings.push(`PLC "${id}" (${host}:${port}) poller is currently NOT_CONNECTED.`);
    }
    if (reachability && !reachability.reachable) {
      warnings.push(
        `PLC "${id}" endpoint ${host}:${port} failed TCP probe (${reachability.error}).`,
      );
    }

    sources.push({
      id,
      uniqueKey: source.uniqueKey ?? null,
      protocol,
      host,
      port,
      readMode: rawCfg.readMode ?? null,
      pollingMs: rawCfg.polling ?? null,
      blockCount: rawCfg.registerCount ?? rawCfg.blockCount ?? null,
      pollerActive,
      pollingStatus: statusLabel,
      lastError: pollerStatus?.error ?? null,
      lastUpdatedAt: pollerStatus?.updatedAt
        ? new Date(pollerStatus.updatedAt).toISOString()
        : null,
      dataBlockCount: Array.isArray(pollerStatus?.dataBlocks) ? pollerStatus.dataBlocks.length : 0,
      registerCount: Array.isArray(pollerStatus?.registers) ? pollerStatus.registers.length : 0,
      configuredTopics: topics,
      tcpReachability: reachability,
    });
  }

  const healthyCount = sources.filter((s) => s.pollingStatus === "HEALTHY").length;
  const unhealthyCount = sources.filter((s) => s.pollingStatus === "UNHEALTHY").length;

  let overallStatus = "HEALTHY";
  if (sources.length === 0) {
    overallStatus =
      mqttConfig && (!mqttReachability || mqttReachability.reachable) ? "IDLE" : "DEGRADED";
  } else if (unhealthyCount > 0 || (mqttReachability && !mqttReachability.reachable)) {
    overallStatus = healthyCount > 0 ? "DEGRADED" : "UNHEALTHY";
  } else if (healthyCount < sources.length) {
    overallStatus = "DEGRADED";
  }

  return {
    configured: true,
    configurationId: saved.id,
    configurationUpdatedAt: saved.updatedAt,
    overallStatus,
    mqttBroker: mqttConfig
      ? {
          protocol: mqttConfig.protocol,
          host: mqttConfig.host,
          port: mqttConfig.port,
          clientId: mqttConfig.clientId,
          qos: mqttConfig.qos,
          authType: mqttConfig.authType,
          username: mqttConfig.username ?? null,
          hasPassword: Boolean(mqttConfig.password),
          tcpReachability: mqttReachability,
        }
      : null,
    sources,
    activeModbusPollerCount: activeModbusPollers.length,
    healthySourceCount: healthyCount,
    totalSourceCount: sources.length,
    warnings,
  };
}

function inspectPayload(rawText) {
  let parsed = null;
  let validJson = false;
  try {
    parsed = JSON.parse(rawText);
    validJson = true;
  } catch {
    return {
      validJson: false,
      payloadType: "raw_text",
      preview: rawText.slice(0, 200),
      anomalies: ["Payload is not valid JSON"],
    };
  }

  if (!isRecord(parsed)) {
    return {
      validJson: true,
      payloadType: Array.isArray(parsed) ? "json_array" : typeof parsed,
      preview: rawText.slice(0, 200),
      anomalies: [],
    };
  }

  const keys = Object.keys(parsed);
  const anomalies = [];

  // Check Festo 66-cylinder 6-timestamp cycle payload
  const matchedTimestamps = SIX_TIMESTAMPS.filter((field) => field in parsed);
  if (matchedTimestamps.length > 0) {
    const missingTimestamps = SIX_TIMESTAMPS.filter((field) => !(field in parsed));
    const zeroTimestamps = matchedTimestamps.filter((field) => {
      const val = parsed[field];
      return val === 0 || val === "0" || val === null || val === "" || val === undefined;
    });
    if (missingTimestamps.length > 0) {
      anomalies.push(`Missing cylinder timestamps: ${missingTimestamps.join(", ")}`);
    }
    if (zeroTimestamps.length === matchedTimestamps.length) {
      anomalies.push("All cylinder stroke timestamps are zero/empty");
    }
    return {
      validJson: true,
      payloadType: "modbus_cylinder_datablock",
      cycleCounter: parsed.cycle_counter ?? null,
      partNumber: parsed.part_number ?? null,
      populatedTimestamps: matchedTimestamps.length - zeroTimestamps.length,
      totalExpectedTimestamps: SIX_TIMESTAMPS.length,
      sample: parsed,
      anomalies,
    };
  }

  // Check MSE6-C2M telemetry payload
  if ("rawAirFlow" in parsed || "rawAirPressure" in parsed) {
    return {
      validJson: true,
      payloadType: "mse6_c2m_telemetry",
      sample: parsed,
      anomalies,
    };
  }

  // Check Siemens MIP / generic PLC payload
  if ("cylinderId" in parsed || "valveId" in parsed || "valveTerminalId" in parsed) {
    return {
      validJson: true,
      payloadType: "siemens_mip",
      sample: parsed,
      anomalies,
    };
  }

  return {
    validJson: true,
    payloadType: "json_object",
    fieldCount: keys.length,
    sample: Object.fromEntries(keys.slice(0, 12).map((k) => [k, parsed[k]])),
    anomalies,
  };
}

function deriveDefaultSubscriptionTopics(overview) {
  const configured = new Set();
  for (const src of overview.sources ?? []) {
    for (const topic of src.configuredTopics ?? []) {
      if (topic && typeof topic === "string") configured.add(topic.trim());
    }
  }
  if (configured.size > 0 && configured.size <= 80) {
    return Array.from(configured);
  }
  if (configured.size > 80) {
    // Derive common prefix wildcards to keep subscription concise.
    const prefixes = new Set();
    for (const topic of configured) {
      const parts = topic.split("/").filter(Boolean);
      if (parts.length >= 2) prefixes.add(`${parts[0]}/${parts[1]}/#`);
      else if (parts.length === 1) prefixes.add(`${parts[0]}/#`);
    }
    if (prefixes.size > 0) return Array.from(prefixes);
  }
  return ["festo/#", "festo-ax/#", "ax/#"];
}

export async function subscribeConnectorMqtt({
  queryFn = defaultQuery,
  args = {},
  mqttConnect = mqtt.connect,
} = {}) {
  const saved = await loadSavedConnectorConfiguration(queryFn);
  const savedMqtt = saved?.configuration
    ? extractMqttConfigFromConfiguration(saved.configuration)
    : null;

  const brokerConfig = {
    protocol: args.protocol || savedMqtt?.protocol || "tcp://",
    host: String(args.host || savedMqtt?.host || "").trim(),
    port: Number(args.port || savedMqtt?.port || 1883),
    username: args.username !== undefined ? args.username : (savedMqtt?.username ?? undefined),
    password: args.password !== undefined ? args.password : (savedMqtt?.password ?? undefined),
  };

  if (!brokerConfig.host) {
    return {
      ok: false,
      connected: false,
      error:
        "No MQTT broker host is configured in Connector (connector_configurations) and none was provided in tool arguments.",
      diagnosis: "Configure an MQTT Broker in the Connector -> MQTT Broker tab first.",
    };
  }

  const durationSeconds = clamp(args.duration_seconds ?? args.durationSeconds, 3, 1, 10);
  const maxMessages = Math.round(clamp(args.max_messages ?? args.maxMessages, 40, 1, 200));

  let topics = [];
  if (Array.isArray(args.topics)) {
    topics = args.topics.map((t) => String(t).trim()).filter(Boolean);
  } else if (typeof args.topic === "string" && args.topic.trim()) {
    topics = [args.topic.trim()];
  }
  if (topics.length === 0) {
    const overview = await getConnectorOverview({ queryFn, checkReachability: false });
    topics = deriveDefaultSubscriptionTopics(overview);
  }

  const brokerUrl = getMqttBrokerUrl(brokerConfig);
  const connectTimeoutMs = 4000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const client = mqttConnect(brokerUrl, {
      clientId: `hermes-debug-${Math.random().toString(16).slice(2, 10)}`,
      username: brokerConfig.username || undefined,
      password: brokerConfig.password || undefined,
      connectTimeout: connectTimeoutMs,
      reconnectPeriod: 0,
      clean: true,
    });

    let settled = false;
    let connectedAt = null;
    let firstMessageAt = null;
    let samplingTimer = null;
    let connectTimer = null;
    let totalMessages = 0;
    const topicStats = new Map();
    const allAnomalies = new Set();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (samplingTimer) clearTimeout(samplingTimer);
      if (connectTimer) clearTimeout(connectTimer);
      try {
        client.end(true);
      } catch {
        // Ignore cleanup errors.
      }
      resolve(result);
    };

    const buildSuccessResult = () => {
      const elapsedSec = Math.max(0.1, (Date.now() - (connectedAt ?? startedAt)) / 1000);
      const topicsSummary = Array.from(topicStats.entries())
        .slice(0, 30)
        .map(([topic, stat]) => ({
          topic,
          messageCount: stat.count,
          payloadType: stat.lastInspection.payloadType,
          validJson: stat.lastInspection.validJson,
          cycleCounter: stat.lastInspection.cycleCounter ?? undefined,
          partNumber: stat.lastInspection.partNumber ?? undefined,
          populatedTimestamps: stat.lastInspection.populatedTimestamps ?? undefined,
          anomalies: stat.lastInspection.anomalies,
          latestSample: stat.lastInspection.sample ?? stat.lastInspection.preview,
          lastReceivedAt: stat.lastReceivedAt,
        }));

      const warnings = Array.from(allAnomalies);
      let diagnosis = "";
      if (totalMessages === 0) {
        warnings.push(
          `Connected to MQTT broker ${brokerUrl}, but received 0 messages on [${topics.slice(0, 5).join(", ")}${topics.length > 5 ? ", ..." : ""}] within ${durationSeconds}s.`,
        );
        diagnosis =
          "Broker connection succeeded, but no messages arrived during the sampling window. Possible causes: PLC pollers are stopped/offline, datablock values have not changed since the last cycle (change-only publishing), or the subscribed topics do not match the published topics.";
      } else if (warnings.length > 0) {
        diagnosis = `Received ${totalMessages} messages across ${topicStats.size} topic(s), with ${warnings.length} payload anomaly warning(s) detected.`;
      } else {
        diagnosis = `Healthy: received ${totalMessages} valid message(s) across ${topicStats.size} topic(s) at ${(totalMessages / elapsedSec).toFixed(2)} msg/s.`;
      }

      return {
        ok: true,
        connected: true,
        brokerUrl,
        connectLatencyMs: connectedAt ? connectedAt - startedAt : null,
        firstMessageLatencyMs: connectedAt && firstMessageAt ? firstMessageAt - connectedAt : null,
        subscribedTopics: topics,
        durationSeconds,
        totalMessages,
        uniqueTopicCount: topicStats.size,
        messagesPerSecond: Number((totalMessages / elapsedSec).toFixed(2)),
        topicsSummary,
        warnings,
        diagnosis,
      };
    };

    connectTimer = setTimeout(() => {
      finish({
        ok: false,
        connected: false,
        brokerUrl,
        subscribedTopics: topics,
        error: `MQTT connection timed out after ${connectTimeoutMs}ms`,
        diagnosis: `Unable to reach MQTT broker at ${brokerUrl}. Check broker host/port, network routing, and firewall.`,
      });
    }, connectTimeoutMs);

    client.once("connect", () => {
      if (settled) return;
      clearTimeout(connectTimer);
      connectedAt = Date.now();
      client.subscribe(topics, { qos: 0 }, (err) => {
        if (err) {
          finish({
            ok: false,
            connected: true,
            brokerUrl,
            subscribedTopics: topics,
            error: `MQTT subscribe failed: ${err.message}`,
            diagnosis:
              "Connected to broker, but subscription was rejected (check ACL/credentials or topic syntax).",
          });
          return;
        }
        samplingTimer = setTimeout(() => {
          finish(buildSuccessResult());
        }, durationSeconds * 1000);
      });
    });

    client.on("message", (topic, payloadBuffer) => {
      if (settled) return;
      if (!firstMessageAt) firstMessageAt = Date.now();
      totalMessages += 1;
      const rawText = payloadBuffer.toString("utf8");
      const inspection = inspectPayload(rawText);
      for (const anomaly of inspection.anomalies) {
        allAnomalies.add(`${topic}: ${anomaly}`);
      }
      const existing = topicStats.get(topic);
      if (existing) {
        existing.count += 1;
        existing.lastInspection = inspection;
        existing.lastReceivedAt = new Date().toISOString();
      } else {
        topicStats.set(topic, {
          count: 1,
          lastInspection: inspection,
          lastReceivedAt: new Date().toISOString(),
        });
      }
      if (totalMessages >= maxMessages) {
        finish(buildSuccessResult());
      }
    });

    client.once("error", (error) => {
      finish({
        ok: false,
        connected: Boolean(connectedAt),
        brokerUrl,
        subscribedTopics: topics,
        error: error instanceof Error ? error.message : String(error),
        diagnosis: `MQTT broker error on ${brokerUrl}: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });
}

export async function getC2mOverview({ queryFn = defaultQuery, c2mDevice, c2mMqtt } = {}) {
  let savedConfig = null;
  try {
    const res = await queryFn(
      "SELECT configuration, updated_at FROM public.c2m_configurations ORDER BY updated_at DESC LIMIT 1",
    );
    if (res.rows[0]) {
      savedConfig = {
        updatedAt: res.rows[0].updated_at,
        configuration: res.rows[0].configuration,
      };
    }
  } catch {
    savedConfig = null;
  }

  return {
    device: c2mDevice ? c2mDevice.snapshot() : null,
    mqttOutput: c2mMqtt ? c2mMqtt.snapshot() : null,
    savedConfiguration: savedConfig,
  };
}
