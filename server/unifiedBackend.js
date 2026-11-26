import { query } from "./database.js";
import { closeAllMqttClients, testMqttConnection } from "./connector/mqttPublisher.js";
import { browseOpcuaNodes, testOpcuaConnection } from "./connector/plc/opcuaClient.js";
import {
  ModbusConfigurationError,
  normalizeModbusConfig,
  modbusErrorMessage,
} from "./connector/plc/modbusClient.js";
import {
  getModbusPollerStatus,
  startModbusPoller,
  stopAllModbusPollers,
  stopModbusPoller,
  testModbusPollerConnection,
} from "./connector/plc/modbusPoller.js";
import {
  restoreModbusPollersFromDatabase,
  syncModbusPollersWithConfiguration,
} from "./connector/plc/modbusBootstrap.js";
import {
  normalizeOpcuaDataBlocks,
  startOpcuaPoller,
  stopOpcuaPoller,
} from "./connector/plc/opcuaPoller.js";
import { CUSTOMISED_ENDPOINT, normaliseCustomisedConfig } from "../shared/modbusCustomised.js";
import {
  getCustomisedModbusPollerStatus,
  startCustomisedModbusPoller,
  stopCustomisedModbusPoller,
  testCustomisedModbusPollerConnection,
} from "./connector/plc/modbusCustomisedPoller.js";
import {
  getSiemensPollerStatus,
  startSiemensPoller,
  stopSiemensPoller,
} from "./connector/plc/poller.js";
import { loadConfig } from "./c2m/config.js";
import { DeviceService } from "./c2m/device.js";
import { MqttOutputService } from "./c2m/mqtt.js";
import {
  HERMES_PROVIDER_PRESETS,
  loadHermesConfig,
  maskHermesConfigForClient,
  saveHermesConfig,
  testHermesLlmConnection,
} from "./debug-agent/configStore.js";
import { executeHermesTool, listHermesTools, runHermesChat } from "./debug-agent/agentEngine.js";
import {
  getPythonBridgeStatus,
  listSmartenanceAccountsFromDb,
} from "./debug-agent/smartenanceTools.js";

const NO_STORE = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: NO_STORE,
  });
}

function isConnectorConfiguration(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    Array.isArray(value.messageSources) &&
    value.mqttMessageHandler &&
    typeof value.mqttMessageHandler === "object",
  );
}

function hasOpcuaEndpoint(config) {
  return Boolean(config?.host && config?.port);
}

function modbusErrorResponse(error) {
  const invalidConfiguration = error instanceof ModbusConfigurationError;
  return jsonResponse(
    {
      connected: false,
      error: modbusErrorMessage(error),
    },
    invalidConfiguration ? 400 : 502,
  );
}

function opcuaErrorResponse(error) {
  return jsonResponse(
    {
      connected: false,
      error: error instanceof Error ? error.message : "Unable to connect to OPC UA server",
    },
    502,
  );
}

function c2mErrorResponse(error) {
  const status =
    error?.status || (["VALIDATION", "ERR_INVALID_ARG_TYPE"].includes(error?.code) ? 400 : 502);
  return jsonResponse(
    {
      error: {
        code: error?.code || "REQUEST_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    },
    status,
  );
}

const globalState = globalThis;

async function getUnifiedServices() {
  if (!globalState.__festoUnifiedServicesPromise) {
    globalState.__festoUnifiedServicesPromise = (async () => {
      const c2mConfig = await loadConfig();
      const c2mDevice = new DeviceService(c2mConfig);
      const c2mMqtt = new MqttOutputService(c2mDevice);

      // Auto-restore saved Connector Modbus pollers from the shared PostgreSQL database.
      const restorePromise = restoreModbusPollersFromDatabase({
        queryFn: query,
        retryAttempts: 3,
        retryDelayMs: 1500,
      }).catch((error) => {
        console.error("Failed to auto-restore Modbus pollers on startup", error);
      });

      if (!globalState.__festoShutdownRegistered) {
        globalState.__festoShutdownRegistered = true;
        const cleanup = async () => {
          try {
            c2mDevice.stopPolling();
            c2mDevice.client.close();
            c2mMqtt.stop();
            await stopAllModbusPollers();
            closeAllMqttClients();
          } catch {
            // Best-effort cleanup on shutdown.
          }
        };
        process.once("SIGINT", () => void cleanup());
        process.once("SIGTERM", () => void cleanup());
      }

      return { c2mDevice, c2mMqtt, restorePromise };
    })();
  }
  return globalState.__festoUnifiedServicesPromise;
}

async function readJsonObject(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), {
      status: 400,
      code: "VALIDATION",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Expected JSON object"), {
      status: 400,
      code: "VALIDATION",
    });
  }
  return parsed;
}

export async function handleUnifiedApiRequest(request, preParsedBody) {
  const { c2mDevice, c2mMqtt } = await getUnifiedServices();
  const url = new URL(request.url, "http://127.0.0.1:3000");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  // 1. Unified Health Check
  if (
    method === "GET" &&
    (pathname === "/api/health" ||
      pathname === "/api/connector/health" ||
      pathname === "/api/c2m/health")
  ) {
    try {
      await query("SELECT 1 FROM public.connector_configurations LIMIT 0");
      return jsonResponse({
        ok: true,
        database: true,
        connector: true,
        c2m: true,
        smartenance: true,
        hermes: true,
      });
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          database: false,
          error: error instanceof Error ? error.message : "Database unavailable",
        },
        503,
      );
    }
  }

  // 2. Connector Configuration (Shared PostgreSQL database)
  if (pathname === "/api/configuration" || pathname === "/api/connector/configuration") {
    if (method === "GET") {
      try {
        const result = await query(
          `
          SELECT configuration
          FROM connector_configurations
          ORDER BY updated_at DESC
          LIMIT 1
          `,
        );
        return jsonResponse(result.rows[0]?.configuration ?? null);
      } catch (error) {
        console.error("Unable to load configuration", error);
        return jsonResponse({ error: "Unable to load configuration" }, 500);
      }
    }
    if (method === "PUT") {
      let configuration;
      try {
        configuration = preParsedBody ?? (await readJsonObject(request));
      } catch {
        return jsonResponse({ error: "Invalid connector configuration" }, 400);
      }
      if (!isConnectorConfiguration(configuration)) {
        return jsonResponse({ error: "Invalid connector configuration" }, 400);
      }
      try {
        await query(
          `
          INSERT INTO connector_configurations
            (id, configuration, updated_at)
          VALUES
            ($1, $2::jsonb, NOW())
          ON CONFLICT (id)
          DO UPDATE SET
            configuration = EXCLUDED.configuration,
            updated_at = NOW()
          `,
          [configuration.id, JSON.stringify(configuration)],
        );
        void syncModbusPollersWithConfiguration(configuration).catch((error) => {
          console.error("Failed to sync Modbus pollers after configuration update", error);
        });
        return jsonResponse({ saved: true, id: configuration.id });
      } catch (error) {
        console.error("Unable to save configuration", error);
        return jsonResponse({ error: "Unable to save configuration" }, 500);
      }
    }
  }

  const deleteSourceMatch = pathname.match(
    /^\/api\/(?:connector\/)?configuration\/message-sources\/([^/]+)$/,
  );
  if (deleteSourceMatch && method === "DELETE") {
    const uniqueKey = decodeURIComponent(deleteSourceMatch[1]);
    try {
      const result = await query(
        `
        UPDATE connector_configurations
        SET
          configuration = jsonb_set(
            configuration,
            '{messageSources}',
            COALESCE(
              (
                SELECT jsonb_agg(source)
                FROM jsonb_array_elements(configuration->'messageSources') AS source
                WHERE source->>'uniqueKey' <> $1
              ),
              '[]'::jsonb
            ),
            true
          ),
          updated_at = NOW()
        WHERE id = (
          SELECT id
          FROM connector_configurations
          ORDER BY updated_at DESC
          LIMIT 1
        )
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(configuration->'messageSources') AS source
          WHERE source->>'uniqueKey' = $1
        )
        RETURNING configuration
        `,
        [uniqueKey],
      );

      if (result.rowCount === 0) {
        return jsonResponse({ error: "Message source not found" }, 404);
      }

      void syncModbusPollersWithConfiguration(result.rows[0].configuration).catch((error) => {
        console.error("Failed to sync Modbus pollers after deleting message source", error);
      });

      return jsonResponse({
        deleted: true,
        configuration: result.rows[0].configuration,
      });
    } catch (error) {
      console.error("Unable to delete message source", error);
      return jsonResponse({ error: "Unable to delete message source" }, 500);
    }
  }

  // 3. Connector PLC Routes: Siemens S7
  if (pathname === "/api/plcs/siemens/connect" && method === "POST") {
    const config = preParsedBody ?? (await readJsonObject(request).catch(() => null));
    if (!config?.id || !config?.host || !Array.isArray(config.dataBlocks)) {
      return jsonResponse({ connected: false, error: "Invalid Siemens configuration" }, 400);
    }
    try {
      if (config.previousId && String(config.previousId) !== String(config.id)) {
        stopSiemensPoller(config.previousId);
      }
      await startSiemensPoller(config);
      return jsonResponse({ connected: true, plcId: config.id });
    } catch (error) {
      return jsonResponse(
        {
          connected: false,
          plcId: config.id,
          error: error instanceof Error ? error.message : "Unable to connect to Siemens PLC",
        },
        502,
      );
    }
  }

  const siemensStatusMatch = pathname.match(/^\/api\/plcs\/siemens\/([^/]+)\/status$/);
  if (siemensStatusMatch && method === "GET") {
    return jsonResponse(getSiemensPollerStatus(decodeURIComponent(siemensStatusMatch[1])));
  }

  const siemensDeleteMatch = pathname.match(/^\/api\/plcs\/siemens\/([^/]+)$/);
  if (siemensDeleteMatch && method === "DELETE") {
    stopSiemensPoller(decodeURIComponent(siemensDeleteMatch[1]));
    return new Response(null, { status: 204 });
  }

  // 4. Connector PLC Routes: Modbus TCP
  if (pathname === "/api/plcs/modbus/test" && method === "POST") {
    try {
      const body = preParsedBody ?? (await readJsonObject(request));
      const sample = await testModbusPollerConnection(body);
      return jsonResponse({ connected: true, sample });
    } catch (error) {
      return modbusErrorResponse(error);
    }
  }

  if (pathname === "/api/plcs/modbus/connect" && method === "POST") {
    try {
      const body = preParsedBody ?? (await readJsonObject(request));
      const config = normalizeModbusConfig(body);
      const result = await startModbusPoller(config);
      if (config.previousId && String(config.previousId) !== config.id) {
        await stopModbusPoller(config.previousId);
      }
      return jsonResponse({ connected: true, plcId: config.id, ...result });
    } catch (error) {
      return modbusErrorResponse(error);
    }
  }

  const modbusStatusMatch = pathname.match(/^\/api\/plcs\/modbus\/([^/]+)\/status$/);
  if (modbusStatusMatch && method === "GET") {
    return jsonResponse(getModbusPollerStatus(decodeURIComponent(modbusStatusMatch[1])));
  }

  const modbusDeleteMatch = pathname.match(/^\/api\/plcs\/modbus\/([^/]+)$/);
  if (modbusDeleteMatch && method === "DELETE") {
    await stopModbusPoller(decodeURIComponent(modbusDeleteMatch[1]));
    return new Response(null, { status: 204 });
  }

  // 5. Connector PLC Routes: Customised Modbus compatibility endpoints
  if (
    (pathname === `${CUSTOMISED_ENDPOINT}/test` || pathname === `${CUSTOMISED_ENDPOINT}/connect`) &&
    method === "POST"
  ) {
    let config;
    try {
      const body = preParsedBody ?? (await readJsonObject(request));
      config = normaliseCustomisedConfig(body);
    } catch (error) {
      return jsonResponse({ connected: false, error: modbusErrorMessage(error) }, 400);
    }
    try {
      if (pathname.endsWith("/test")) {
        const sample = await testCustomisedModbusPollerConnection(config);
        return jsonResponse({ connected: true, sample });
      }
      if (config.previousId && String(config.previousId) !== config.id) {
        await stopCustomisedModbusPoller(config.previousId);
      }
      const result = await startCustomisedModbusPoller(config);
      return jsonResponse({ connected: true, plcId: config.id, ...result });
    } catch (error) {
      return jsonResponse({ connected: false, error: modbusErrorMessage(error) }, 502);
    }
  }

  const customStatusMatch = pathname.match(/^\/api\/plcs\/modbus-customised\/([^/]+)\/status$/);
  if (customStatusMatch && method === "GET") {
    return jsonResponse(getCustomisedModbusPollerStatus(decodeURIComponent(customStatusMatch[1])));
  }

  const customDeleteMatch = pathname.match(/^\/api\/plcs\/modbus-customised\/([^/]+)$/);
  if (customDeleteMatch && method === "DELETE") {
    await stopCustomisedModbusPoller(decodeURIComponent(customDeleteMatch[1]));
    return new Response(null, { status: 204 });
  }

  // 6. Connector PLC Routes: OPC UA
  if (pathname === "/api/plcs/opcua/test" && method === "POST") {
    const body = preParsedBody ?? (await readJsonObject(request).catch(() => null));
    if (!hasOpcuaEndpoint(body)) {
      return jsonResponse({ connected: false, error: "OPC UA host and port are required" }, 400);
    }
    try {
      await testOpcuaConnection(body);
      return jsonResponse({ connected: true });
    } catch (error) {
      return opcuaErrorResponse(error);
    }
  }

  if (pathname === "/api/plcs/opcua/browse" && method === "POST") {
    const body = preParsedBody ?? (await readJsonObject(request).catch(() => null));
    if (!hasOpcuaEndpoint(body)) {
      return jsonResponse({ error: "OPC UA host and port are required" }, 400);
    }
    try {
      const nodes = await browseOpcuaNodes(body, body.nodeId);
      return jsonResponse({ nodes });
    } catch (error) {
      return opcuaErrorResponse(error);
    }
  }

  if (pathname === "/api/plcs/opcua/connect" && method === "POST") {
    const config = preParsedBody ?? (await readJsonObject(request).catch(() => null));
    if (!hasOpcuaEndpoint(config) || !config?.id) {
      return jsonResponse({ connected: false, error: "OPC UA id and endpoint are required" }, 400);
    }
    let dataBlocks;
    try {
      dataBlocks = normalizeOpcuaDataBlocks(config);
    } catch (error) {
      return jsonResponse(
        {
          connected: false,
          error: error instanceof Error ? error.message : "Invalid OPC UA Datablocks",
        },
        400,
      );
    }
    try {
      if (config.previousId && String(config.previousId) !== String(config.id)) {
        await stopOpcuaPoller(config.previousId);
      }
      await startOpcuaPoller({ ...config, dataBlocks });
      return jsonResponse({ connected: true, plcId: config.id });
    } catch (error) {
      return opcuaErrorResponse(error);
    }
  }

  const opcuaDeleteMatch = pathname.match(/^\/api\/plcs\/opcua\/([^/]+)$/);
  if (opcuaDeleteMatch && method === "DELETE") {
    await stopOpcuaPoller(decodeURIComponent(opcuaDeleteMatch[1]));
    return new Response(null, { status: 204 });
  }

  // 7. Connector vs C2M MQTT Connect disambiguation
  if (pathname === "/api/connector/mqtt/connect" && method === "POST") {
    try {
      const body = preParsedBody ?? (await readJsonObject(request));
      await testMqttConnection(body);
      return jsonResponse({ connected: true });
    } catch (error) {
      return jsonResponse(
        {
          connected: false,
          error: error instanceof Error ? error.message : "Unable to connect to MQTT broker",
        },
        502,
      );
    }
  }

  if (pathname === "/api/mqtt/connect" && method === "POST") {
    let body;
    try {
      body = preParsedBody ?? (await readJsonObject(request));
    } catch (error) {
      return c2mErrorResponse(error);
    }
    // C2M passes { brokerUrl, topic, interval, ... }, whereas Connector passes { host, port, protocol, ... }
    if (typeof body.brokerUrl === "string") {
      try {
        return jsonResponse(c2mMqtt.start(body));
      } catch (error) {
        return c2mErrorResponse(error);
      }
    }
    try {
      await testMqttConnection(body);
      return jsonResponse({ connected: true });
    } catch (error) {
      return jsonResponse(
        {
          connected: false,
          error: error instanceof Error ? error.message : "Unable to connect to MQTT broker",
        },
        502,
      );
    }
  }

  // 8. MSE6-C2M Routes (supports both /api/c2m/* and legacy /api/*)
  const c2mPath = pathname.startsWith("/api/c2m/")
    ? `/api/${pathname.slice("/api/c2m/".length)}`
    : pathname;

  if (method === "GET" && c2mPath === "/api/status") {
    return jsonResponse(c2mDevice.snapshot());
  }

  if (method === "GET" && c2mPath === "/api/mqtt/status") {
    return jsonResponse(c2mMqtt.snapshot());
  }

  if (method === "GET" && c2mPath === "/api/configuration" && pathname.startsWith("/api/c2m/")) {
    try {
      const result = await query(
        "SELECT configuration FROM c2m_configurations ORDER BY updated_at DESC LIMIT 1",
      );
      return jsonResponse(result.rows[0]?.configuration ?? null);
    } catch {
      return jsonResponse({ error: "Unable to load C2M configuration" }, 500);
    }
  }

  if (method === "PUT" && c2mPath === "/api/configuration" && pathname.startsWith("/api/c2m/")) {
    try {
      const body = preParsedBody ?? (await readJsonObject(request));
      const id = typeof body.id === "string" ? body.id : "default";
      await query(
        `
        INSERT INTO c2m_configurations (id, configuration, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET configuration = EXCLUDED.configuration, updated_at = NOW()
        `,
        [id, JSON.stringify(body)],
      );
      return jsonResponse({ saved: true, id });
    } catch {
      return jsonResponse({ error: "Unable to save C2M configuration" }, 500);
    }
  }

  if (
    [
      "/api/mqtt/test",
      "/api/mqtt/connect",
      "/api/mqtt/disconnect",
      "/api/connect",
      "/api/disconnect",
      "/api/control",
      "/api/parameters/read",
      "/api/parameters",
    ].includes(c2mPath)
  ) {
    if (method !== "POST") {
      return jsonResponse(
        {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: "Method not allowed",
          },
        },
        405,
      );
    }
    try {
      const body = preParsedBody ?? (await readJsonObject(request));
      let result;
      switch (c2mPath) {
        case "/api/mqtt/test":
          result = await c2mMqtt.testConnection(body);
          break;
        case "/api/mqtt/connect":
          result = c2mMqtt.start(body);
          break;
        case "/api/mqtt/disconnect":
          result = c2mMqtt.stop();
          break;
        case "/api/connect":
          result = await c2mDevice.connect(body);
          break;
        case "/api/disconnect":
          result = await c2mDevice.disconnect();
          break;
        case "/api/control":
          result = await c2mDevice.control(body);
          break;
        case "/api/parameters/read":
          result = await c2mDevice.refreshParameters();
          break;
        case "/api/parameters":
          result = await c2mDevice.applyParameters(body);
          break;
      }
      return jsonResponse(result);
    } catch (error) {
      return c2mErrorResponse(error);
    }
  }

  // 9. Debug Agent Routes (Multi-customer LLM settings, live Connector/MQTT/C2M & Smartenance tools)
  const agentPath = pathname.startsWith("/api/debug-agent")
    ? `/api/hermes${pathname.slice("/api/debug-agent".length)}`
    : pathname;

  if (agentPath === "/api/hermes/config") {
    if (method === "GET") {
      try {
        const [{ config, source }, accounts] = await Promise.all([
          loadHermesConfig({ queryFn: query }),
          listSmartenanceAccountsFromDb(query),
        ]);
        return jsonResponse({
          config: maskHermesConfigForClient(config, source),
          presets: HERMES_PROVIDER_PRESETS,
          accounts,
          pythonBridge: getPythonBridgeStatus(),
        });
      } catch (error) {
        return jsonResponse(
          {
            error:
              error instanceof Error ? error.message : "Unable to load Debug Agent configuration",
          },
          500,
        );
      }
    }
    if (method === "PUT") {
      try {
        const body = preParsedBody ?? (await readJsonObject(request));
        const { config, source } = await saveHermesConfig(body, { queryFn: query });
        return jsonResponse({
          saved: true,
          config: maskHermesConfigForClient(config, source),
        });
      } catch (error) {
        return jsonResponse(
          {
            error:
              error instanceof Error ? error.message : "Unable to save Debug Agent configuration",
          },
          error?.status || 500,
        );
      }
    }
  }

  if (agentPath === "/api/hermes/config/test" && method === "POST") {
    try {
      const body = preParsedBody ?? (await readJsonObject(request));
      const result = await testHermesLlmConnection(body, { queryFn: query });
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Model connection test failed",
        },
        error?.status || 502,
      );
    }
  }

  if (agentPath === "/api/hermes/tools" && method === "GET") {
    return jsonResponse({ tools: listHermesTools() });
  }

  if (agentPath === "/api/hermes/tool" && method === "POST") {
    try {
      const body = preParsedBody ?? (await readJsonObject(request));
      if (typeof body.tool !== "string" || !body.tool.trim()) {
        return jsonResponse({ ok: false, error: "Tool name is required" }, 400);
      }
      const { config } = await loadHermesConfig({ queryFn: query });
      const execution = await executeHermesTool(body.tool.trim(), body.arguments ?? {}, {
        queryFn: query,
        c2mDevice,
        c2mMqtt,
        accountKey:
          typeof body.accountKey === "string" && body.accountKey.trim()
            ? body.accountKey.trim()
            : config.smartenanceAccountKey,
      });
      return jsonResponse(execution, execution.ok ? 200 : 502);
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Failed to execute Debug Agent tool",
        },
        error?.status || 500,
      );
    }
  }

  if (agentPath === "/api/hermes/chat" && method === "POST") {
    try {
      const body = preParsedBody ?? (await readJsonObject(request));
      const { config } = await loadHermesConfig({ queryFn: query });
      const result = await runHermesChat({
        messages: body.messages,
        language: body.language === "en" ? "en" : "zh",
        config,
        context: {
          queryFn: query,
          c2mDevice,
          c2mMqtt,
        },
      });
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "Debug Agent request failed",
          code: error?.code || "HERMES_CHAT_FAILED",
        },
        error?.status || 500,
      );
    }
  }

  return jsonResponse(
    {
      error: {
        code: "NOT_FOUND",
        message: `Unknown API endpoint: ${method} ${pathname}`,
      },
    },
    404,
  );
}
