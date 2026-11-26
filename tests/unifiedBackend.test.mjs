import assert from "node:assert/strict";
import test from "node:test";

test("unifiedBackend serves Connector, MSE6-C2M, and shared PostgreSQL configuration endpoints on one backend", async (t) => {
  const savedRows = [];
  t.mock.module(new URL("../server/database.js", import.meta.url).href, {
    namedExports: {
      query: async (sql, params) => {
        if (sql.includes("SELECT 1 FROM public.connector_configurations")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO connector_configurations")) {
          const cfg = JSON.parse(params[1]);
          savedRows[0] = { configuration: cfg };
          return { rows: [{ id: params[0] }], rowCount: 1 };
        }
        if (sql.includes("SELECT configuration") && sql.includes("FROM connector_configurations")) {
          return { rows: savedRows, rowCount: savedRows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  });

  const { handleUnifiedApiRequest } = await import("../server/unifiedBackend.js");

  // 1. Unified health check
  const healthRes = await handleUnifiedApiRequest(new Request("http://127.0.0.1:3000/api/health"));
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.database, true);
  assert.equal(health.connector, true);
  assert.equal(health.c2m, true);
  assert.equal(health.smartenance, true);

  // 2. Connector configuration save & load via shared PostgreSQL database
  const sampleConfig = {
    id: "unified-cfg-1",
    mqttMessageHandler: {
      clientId: "festo-edge-1",
      uri: "tcp://:1883",
      qos: 1,
      anonymousAuthentication: {},
    },
    messageSources: [],
  };
  const putRes = await handleUnifiedApiRequest(
    new Request("http://127.0.0.1:3000/api/configuration", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampleConfig),
    }),
  );
  assert.equal(putRes.status, 200);
  assert.deepEqual(await putRes.json(), { saved: true, id: "unified-cfg-1" });

  const getRes = await handleUnifiedApiRequest(
    new Request("http://127.0.0.1:3000/api/configuration"),
  );
  assert.equal(getRes.status, 200);
  assert.deepEqual(await getRes.json(), sampleConfig);

  // 3. MSE6-C2M status & MQTT status served on the same unified backend
  const c2mStatusRes = await handleUnifiedApiRequest(
    new Request("http://127.0.0.1:3000/api/c2m/status"),
  );
  assert.equal(c2mStatusRes.status, 200);
  const c2mStatus = await c2mStatusRes.json();
  assert.equal(c2mStatus.status, "disconnected");

  const c2mMqttRes = await handleUnifiedApiRequest(
    new Request("http://127.0.0.1:3000/api/c2m/mqtt/status"),
  );
  assert.equal(c2mMqttRes.status, 200);
  const c2mMqtt = await c2mMqttRes.json();
  assert.equal(c2mMqtt.status, "disconnected");

  // 4. Hermes Agent endpoints served on the same unified backend
  const hermesToolsRes = await handleUnifiedApiRequest(
    new Request("http://127.0.0.1:3000/api/debug-agent/tools"),
  );
  assert.equal(hermesToolsRes.status, 200);
  const hermesToolsData = await hermesToolsRes.json();
  assert.ok(Array.isArray(hermesToolsData.tools));
  assert.ok(hermesToolsData.tools.some((tool) => tool.name === "subscribe_connector_mqtt"));
  assert.ok(hermesToolsData.tools.some((tool) => tool.name === "get_factory_overview"));

  const hermesCfgRes = await handleUnifiedApiRequest(
    new Request("http://127.0.0.1:3000/api/debug-agent/config"),
  );
  assert.equal(hermesCfgRes.status, 200);
  const hermesCfg = await hermesCfgRes.json();
  assert.ok(Array.isArray(hermesCfg.presets));
  assert.equal(typeof hermesCfg.config.model, "string");
});
