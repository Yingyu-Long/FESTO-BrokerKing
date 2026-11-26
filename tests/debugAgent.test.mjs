import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  loadHermesConfig,
  maskHermesConfigForClient,
  saveHermesConfig,
} from "../server/debug-agent/configStore.js";
import {
  getConnectorOverview,
  subscribeConnectorMqtt,
} from "../server/debug-agent/connectorDiagnostics.js";
import {
  executeHermesTool,
  listHermesTools,
  runHermesChat,
} from "../server/debug-agent/agentEngine.js";

test("Hermes configStore persists multi-customer settings, masks API keys, and preserves saved keys on partial update", async () => {
  let savedRow = null;
  const queryFn = async (sql, params) => {
    if (sql.includes("CREATE TABLE")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.hermes_configurations")) {
      savedRow = { configuration: JSON.parse(params[1]) };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT configuration") && sql.includes("hermes_configurations")) {
      return { rows: savedRow ? [savedRow] : [], rowCount: savedRow ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  // Initial load falls back to env defaults.
  const initial = await loadHermesConfig({
    queryFn,
    env: { HERMES_PROVIDER: "ollama", HERMES_MODEL: "qwen2.5:14b" },
  });
  assert.equal(initial.source, "env");
  assert.equal(initial.config.provider, "ollama");
  assert.equal(initial.config.model, "qwen2.5:14b");

  // Save a customer DeepSeek config with API key.
  const saved = await saveHermesConfig(
    {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "sk-customer-secret-12345678",
      model: "deepseek-chat",
      smartenanceAccountKey: "auto",
    },
    { queryFn, env: {} },
  );
  assert.equal(saved.source, "database");
  assert.equal(saved.config.baseUrl, "https://api.deepseek.com/v1");

  const masked = maskHermesConfigForClient(saved.config, saved.source);
  assert.equal(masked.hasApiKey, true);
  assert.equal(masked.apiKeyMasked, "sk-c••••5678");
  assert.equal("apiKey" in masked, false);

  // Partial update without apiKey keeps the previously stored secret intact.
  const updated = await saveHermesConfig(
    { model: "deepseek-reasoner", temperature: 0.4 },
    { queryFn, env: {} },
  );
  assert.equal(updated.config.apiKey, "sk-customer-secret-12345678");
  assert.equal(updated.config.model, "deepseek-reasoner");
  assert.equal(updated.config.temperature, 0.4);
});

test("Connector diagnostics inspect saved Modbus/MQTT config and sample live 66-cylinder MQTT topics", async () => {
  const savedConnectorConfig = {
    id: "cfg-line-1",
    mqttMessageHandler: {
      clientId: "broker-king-edge",
      uri: "tcp://10.0.0.50:1883",
      qos: 1,
      basicAuthentication: { username: "edge", password: "secret" },
    },
    messageSources: [
      {
        id: "Line1_PLC",
        uniqueKey: "modbus-line1",
        uri: "modbus.tcp://10.0.0.10:502",
        configuration: {
          readMode: "Read by Datablocks",
          polling: 500,
          registerCount: 2,
          startAddress: 0,
          blockTopics: ["festo-ax/pni/line1/cyl1", "festo-ax/pni/line1/cyl2"],
        },
      },
    ],
  };

  const queryFn = async (sql) => {
    if (sql.includes("FROM public.connector_configurations")) {
      return {
        rows: [
          {
            id: savedConnectorConfig.id,
            updated_at: new Date("2026-11-23T05:00:00Z"),
            configuration: savedConnectorConfig,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };

  // 1. Connector overview with mocked TCP reachability
  const overview = await getConnectorOverview({
    queryFn,
    checkReachability: true,
    probeTcp: async (host, port) => ({
      reachable: host === "10.0.0.50" || port === 502,
      latencyMs: 12,
      error: null,
    }),
  });
  assert.equal(overview.configured, true);
  assert.equal(overview.mqttBroker.host, "10.0.0.50");
  assert.equal(overview.mqttBroker.hasPassword, true);
  assert.equal("password" in overview.mqttBroker, false);
  assert.equal(overview.sources.length, 1);
  assert.deepEqual(overview.sources[0].configuredTopics, [
    "festo-ax/pni/line1/cyl1",
    "festo-ax/pni/line1/cyl2",
  ]);

  // 2. Live MQTT subscription sampling with fake MQTT client emitting cylinder 6-timestamp JSON
  let subscribedTopics = [];
  const fakeMqttConnect = () => {
    const emitter = new EventEmitter();
    emitter.subscribe = (topics, _opts, cb) => {
      subscribedTopics = Array.isArray(topics) ? topics : [topics];
      cb(null);
      setTimeout(() => {
        emitter.emit(
          "message",
          "festo-ax/pni/line1/cyl1",
          Buffer.from(
            JSON.stringify({
              timestamp_DI_IPos_ON: 1001,
              timestamp_DI_IPos_OFF: 1050,
              timestamp_DI_EPos_ON: 1120,
              timestamp_DI_EPos_OFF: 1200,
              timestamp_DO_MCtrl12_ON: 1000,
              timestamp_DO_MCtrl12_OFF: 1100,
              cycle_counter: 42,
              part_number: 8001,
            }),
          ),
        );
      }, 20);
    };
    emitter.end = () => {};
    setTimeout(() => emitter.emit("connect"), 10);
    return emitter;
  };

  const sample = await subscribeConnectorMqtt({
    queryFn,
    args: { duration_seconds: 1, max_messages: 1 },
    mqttConnect: fakeMqttConnect,
  });

  assert.equal(sample.ok, true);
  assert.equal(sample.connected, true);
  assert.deepEqual(subscribedTopics, ["festo-ax/pni/line1/cyl1", "festo-ax/pni/line1/cyl2"]);
  assert.equal(sample.totalMessages, 1);
  assert.equal(sample.topicsSummary[0].payloadType, "modbus_cylinder_datablock");
  assert.equal(sample.topicsSummary[0].populatedTimestamps, 6);
  assert.equal(sample.topicsSummary[0].cycleCounter, 42);
  assert.equal(sample.warnings.length, 0);
});

test("Hermes Agent executes multi-step OpenAI tool-calling loop across Connector and Smartenance tools", async () => {
  assert.ok(listHermesTools().length >= 15);

  const queryFn = async (sql) => {
    if (sql.includes("FROM public.connector_configurations")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  let llmCallCount = 0;
  const mockFetch = async () => {
    llmCallCount += 1;
    if (llmCallCount === 1) {
      return new Response(
        JSON.stringify({
          model: "deepseek-chat",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "get_connector_overview",
                      arguments: JSON.stringify({ check_reachability: false }),
                    },
                  },
                  {
                    id: "call_2",
                    type: "function",
                    function: {
                      name: "get_factory_overview",
                      arguments: JSON.stringify({ machine_limit: 5 }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        model: "deepseek-chat",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Diagnostic complete: Smartenance has 12 machines and Connector is idle.",
            },
          },
        ],
        usage: { prompt_tokens: 180, completion_tokens: 25, total_tokens: 205 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await runHermesChat({
    messages: [{ role: "user", content: "Check connector and factory overview" }],
    language: "en",
    config: {
      provider: "deepseek",
      apiFormat: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test-key",
      model: "deepseek-chat",
      smartenanceAccountKey: "auto",
      temperature: 0.2,
      maxToolSteps: 5,
      systemPrompt: "",
    },
    context: {
      queryFn,
      smartenanceRunner: async (tool) => ({
        tool,
        total_machines: 12,
        active_incidents: 2,
      }),
    },
    fetchFn: mockFetch,
  });

  assert.equal(llmCallCount, 2);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].tool, "get_connector_overview");
  assert.equal(result.toolCalls[0].ok, true);
  assert.equal(result.toolCalls[1].tool, "get_factory_overview");
  assert.equal(result.toolCalls[1].result.total_machines, 12);
  assert.match(result.reply, /12 machines/);

  // Direct tool execution also reports unknown tools cleanly
  const unknown = await executeHermesTool("nonexistent_tool", {}, { queryFn });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown Hermes tool/);
});
