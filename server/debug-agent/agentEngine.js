import { query as defaultQuery } from "../database.js";
import {
  getC2mOverview,
  getConnectorOverview,
  subscribeConnectorMqtt,
} from "./connectorDiagnostics.js";
import { SMARTENANCE_TOOL_NAMES, runSmartenanceBridgeTool } from "./smartenanceTools.js";

export const HERMES_TOOLS = [
  // --- Connector & MQTT Diagnostic Tools ---
  {
    name: "get_connector_overview",
    category: "connector",
    description:
      "Inspect saved Connector configurations from PostgreSQL (PLC connections, Modbus 66-cylinder datablocks, Siemens S7, OPC UA, MQTT broker), live poller runtime status, and TCP reachability.",
    parameters: {
      type: "object",
      properties: {
        check_reachability: {
          type: "boolean",
          description:
            "Whether to actively TCP-probe configured PLC and MQTT broker endpoints (default true).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "subscribe_connector_mqtt",
    category: "connector",
    description:
      "Connect to the configured Connector MQTT broker, subscribe to configured Connector topics (or specified topics) for a short sampling window, and diagnose message flow, publish frequency, and 66-cylinder 6-timestamp JSON payload health.",
    parameters: {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of MQTT topics or wildcards (e.g. ['festo-ax/pni/#', 'festo/plc/#']). Omit to auto-subscribe to all topics configured in Connector.",
        },
        duration_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Sampling duration in seconds (1–10, default 3).",
        },
        max_messages: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum messages to capture before stopping early (default 40).",
        },
      },
      additionalProperties: false,
    },
  },
  // --- MSE6-C2M Telemetry Tool ---
  {
    name: "get_c2m_overview",
    category: "c2m",
    description:
      "Inspect live MSE6-C2M (CPX-FB36) telemetry (flow, pressure, consumption, leak detection delta, valve status), C2M MQTT output status, and saved C2M configuration.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  // --- Smartenance PostgreSQL Analytics Tools (bridged from openclaw/smartenance-agent) ---
  {
    name: "list_smartenance_accounts",
    category: "smartenance",
    description:
      "List Smartenance accounts currently synchronized in PostgreSQL, along with machine counts, total incidents, and latest sync timestamps.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_factory_overview",
    category: "smartenance",
    description:
      "Summarize the Smartenance factory snapshot: total machines, incidents by state, snapshot completeness, sync range, and machines with the most active incidents.",
    parameters: {
      type: "object",
      properties: {
        machine_limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum top machines to include (default 10).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_factory_incident_summary",
    category: "smartenance",
    description:
      "Summarize Smartenance incidents over a rolling lookback_days window (e.g. 30 or 60) or an explicit ISO-8601 start_date/end_date range with day, week, or month trend buckets.",
    parameters: {
      type: "object",
      properties: {
        lookback_days: {
          type: "integer",
          minimum: 1,
          maximum: 36500,
          description: "Rolling window length in days ending now in UTC.",
        },
        start_date: {
          type: "string",
          description: "Inclusive ISO-8601 start date or timestamp.",
        },
        end_date: {
          type: "string",
          description: "Exclusive ISO-8601 end date or timestamp.",
        },
        granularity: {
          type: "string",
          enum: ["day", "week", "month"],
          description: "Trend aggregation bucket (default month).",
        },
        machine_limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_machines",
    category: "smartenance",
    description:
      "List Smartenance machines, optionally searching by name, machine number, or UUID.",
    parameters: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Optional machine name, number, or UUID substring.",
        },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0, maximum: 10000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_details",
    category: "smartenance",
    description: "Get Smartenance machine metadata, incident count, and last sync time.",
    parameters: {
      type: "object",
      properties: {
        machine_id: { type: "string", description: "Machine UUID, number, or exact name." },
      },
      required: ["machine_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_statistics",
    category: "smartenance",
    description:
      "Compare incident counts across all machines in the synchronized Smartenance account.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_incident_history",
    category: "smartenance",
    description:
      "List recorded incidents for a machine, newest first, optionally filtered by exact state.",
    parameters: {
      type: "object",
      properties: {
        machine_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        state: {
          type: "string",
          description: "Optional exact state filter such as Open or Closed.",
        },
      },
      required: ["machine_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_maintenance_history",
    category: "smartenance",
    description: "List maintenance repair tasks recorded for a specific machine, newest first.",
    parameters: {
      type: "object",
      properties: {
        machine_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["machine_id"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_machines",
    category: "smartenance",
    description:
      "Compare 2 to 20 Smartenance machines by incident counts and heuristic health score.",
    parameters: {
      type: "object",
      properties: {
        machine_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 20,
        },
      },
      required: ["machine_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_health_score",
    category: "smartenance",
    description:
      "Calculate heuristic health score (100 - 20*active(max 60) - 5*recent90d(max 25)) for a machine.",
    parameters: {
      type: "object",
      properties: {
        machine_id: { type: "string" },
      },
      required: ["machine_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_risk_ranking",
    category: "smartenance",
    description: "Rank Smartenance machines from highest to lowest heuristic maintenance risk.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_employee_work_hours",
    category: "smartenance",
    description:
      "Summarize repair-task work hours by assigned employee for a calendar month (YYYY-MM). Defaults to the previous full month in Asia/Shanghai.",
    parameters: {
      type: "object",
      properties: {
        month: {
          type: "string",
          description: "Optional calendar month in YYYY-MM format.",
        },
      },
      additionalProperties: false,
    },
  },
];

export function listHermesTools() {
  return HERMES_TOOLS;
}

export async function executeHermesTool(toolName, args = {}, context = {}) {
  const {
    queryFn = defaultQuery,
    c2mDevice = null,
    c2mMqtt = null,
    accountKey = "auto",
    smartenanceRunner = runSmartenanceBridgeTool,
    mqttConnect,
    probeTcp,
  } = context;

  const startedAt = Date.now();
  try {
    let result;
    if (toolName === "get_connector_overview") {
      result = await getConnectorOverview({
        queryFn,
        checkReachability: args?.check_reachability !== false,
        ...(probeTcp ? { probeTcp } : {}),
      });
    } else if (toolName === "subscribe_connector_mqtt") {
      result = await subscribeConnectorMqtt({
        queryFn,
        args: args ?? {},
        ...(mqttConnect ? { mqttConnect } : {}),
      });
    } else if (toolName === "get_c2m_overview") {
      result = await getC2mOverview({ queryFn, c2mDevice, c2mMqtt });
    } else if (SMARTENANCE_TOOL_NAMES.has(toolName)) {
      result = await smartenanceRunner(toolName, args ?? {}, { accountKey, queryFn });
    } else {
      throw new Error(`Unknown Hermes tool: ${toolName}`);
    }

    return {
      ok: true,
      tool: toolName,
      arguments: args ?? {},
      durationMs: Date.now() - startedAt,
      result,
    };
  } catch (error) {
    return {
      ok: false,
      tool: toolName,
      arguments: args ?? {},
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSystemPrompt(language = "zh", customPrompt = "") {
  const basePrompt = `You are Debug Agent, the embedded industrial diagnostics & maintenance assistant inside Broker King.
You have live, read-only access to three unified subsystems sharing one backend and PostgreSQL database:
1. Connector (PLC & MQTT): Use get_connector_overview to inspect saved PLC configurations, active Modbus/Siemens poller statuses, and TCP reachability. Use subscribe_connector_mqtt to subscribe to the configured MQTT broker & topics for live payload sampling (including 66-cylinder 6-timestamp cycle verification).
2. MSE6-C2M (CPX-FB36 energy efficiency): Use get_c2m_overview to check live air flow, pressure, consumption, leak detection delta, valve state, and MQTT output.
3. Smartenance (PostgreSQL snapshot): Use the Smartenance tools (get_factory_overview, get_machine_risk_ranking, get_factory_incident_summary, get_employee_work_hours, get_machines, get_machine_incident_history, get_machine_maintenance_history, etc.) to analyze machines, incidents, and repair work hours.

Guidelines:
- Always call the relevant tools to inspect live facts before answering; never invent PLC statuses, MQTT messages, or maintenance metrics.
- When diagnosing Connector health, combine get_connector_overview AND subscribe_connector_mqtt so you verify both poller state and actual MQTT delivery.
- For Smartenance health scores, note that scores are heuristic (100 - 20*active[max 60] - 5*last90d[max 25]) and reflect the latest synchronized PostgreSQL snapshot.
- Be clear, structured, and concise. Use Markdown headings, bullet points, or compact tables when reporting diagnostics.
- Respond in ${language === "zh" ? "Chinese (简体中文)" : "English"} unless the user explicitly writes in another language.`;

  return customPrompt
    ? `${basePrompt}\n\nAdditional customer instructions:\n${customPrompt}`
    : basePrompt;
}

function truncateToolOutputForModel(payload, maxChars = 16000) {
  const serialized = JSON.stringify(payload);
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}... [truncated ${serialized.length - maxChars} chars]`;
}

function parseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === "object") return rawArgs;
  try {
    const parsed = JSON.parse(String(rawArgs));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function runOpenAiToolLoop({ messages, config, systemPrompt, context, fetchFn }) {
  const tools = HERMES_TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const conversation = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content ?? ""),
    })),
  ];

  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const toolCallsTrace = [];
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (let step = 0; step < config.maxToolSteps; step++) {
    const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        messages: conversation,
        tools,
        tool_choice: "auto",
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data?.error?.message || data?.message || `LLM API error (HTTP ${response.status})`;
      throw Object.assign(new Error(message), { status: 502 });
    }

    if (data.usage) {
      totalUsage.prompt_tokens += Number(data.usage.prompt_tokens ?? 0);
      totalUsage.completion_tokens += Number(data.usage.completion_tokens ?? 0);
      totalUsage.total_tokens += Number(data.usage.total_tokens ?? 0);
    }

    const assistantMsg = data?.choices?.[0]?.message;
    if (!assistantMsg) {
      throw Object.assign(new Error("LLM returned an empty response."), { status: 502 });
    }

    const toolCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];
    if (toolCalls.length === 0) {
      return {
        reply: String(assistantMsg.content ?? "").trim(),
        model: data.model || config.model,
        toolCalls: toolCallsTrace,
        usage: totalUsage,
      };
    }

    conversation.push({
      role: "assistant",
      content: assistantMsg.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const fnName = call?.function?.name;
      const parsedArgs = parseToolArgs(call?.function?.arguments);
      const execution = await executeHermesTool(fnName, parsedArgs, {
        ...context,
        accountKey: config.smartenanceAccountKey,
      });
      toolCallsTrace.push(execution);
      conversation.push({
        role: "tool",
        tool_call_id: call.id || `call_${step}_${fnName}`,
        content: truncateToolOutputForModel(
          execution.ok ? execution.result : { error: execution.error },
        ),
      });
    }
  }

  return {
    reply:
      "Reached the maximum tool execution steps. Please review the tool execution trace above or increase Max Tool Steps in Model Settings.",
    model: config.model,
    toolCalls: toolCallsTrace,
    usage: totalUsage,
  };
}

async function runAnthropicToolLoop({ messages, config, systemPrompt, context, fetchFn }) {
  const tools = HERMES_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const conversation = messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content ?? ""),
  }));

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
  };

  const toolCallsTrace = [];
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (let step = 0; step < config.maxToolSteps; step++) {
    const response = await fetchFn(`${config.baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2048,
        temperature: config.temperature,
        system: systemPrompt,
        messages: conversation,
        tools,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data?.error?.message || data?.message || `Anthropic API error (HTTP ${response.status})`;
      throw Object.assign(new Error(message), { status: 502 });
    }

    if (data.usage) {
      const inputTokens = Number(data.usage.input_tokens ?? 0);
      const outputTokens = Number(data.usage.output_tokens ?? 0);
      totalUsage.prompt_tokens += inputTokens;
      totalUsage.completion_tokens += outputTokens;
      totalUsage.total_tokens += inputTokens + outputTokens;
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const toolUses = blocks.filter((b) => b?.type === "tool_use");

    if (toolUses.length === 0) {
      const text = blocks
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return {
        reply: text,
        model: data.model || config.model,
        toolCalls: toolCallsTrace,
        usage: totalUsage,
      };
    }

    conversation.push({ role: "assistant", content: blocks });

    const toolResults = [];
    for (const use of toolUses) {
      const execution = await executeHermesTool(use.name, use.input ?? {}, {
        ...context,
        accountKey: config.smartenanceAccountKey,
      });
      toolCallsTrace.push(execution);
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: truncateToolOutputForModel(
          execution.ok ? execution.result : { error: execution.error },
        ),
        is_error: !execution.ok,
      });
    }
    conversation.push({ role: "user", content: toolResults });
  }

  return {
    reply:
      "Reached the maximum tool execution steps. Please review the tool execution trace above or increase Max Tool Steps in Model Settings.",
    model: config.model,
    toolCalls: toolCallsTrace,
    usage: totalUsage,
  };
}

export async function runHermesChat({
  messages,
  language = "zh",
  config,
  context = {},
  fetchFn = fetch,
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error("At least one user message is required."), { status: 400 });
  }
  const requiresKey = !["ollama", "custom"].includes(config.provider);
  if (requiresKey && !config.apiKey) {
    throw Object.assign(
      new Error(
        "Debug Agent API Key is not configured yet. Open Model Settings to enter your API key or configure a local Ollama endpoint.",
      ),
      { status: 400, code: "HERMES_NOT_CONFIGURED" },
    );
  }

  const systemPrompt = buildSystemPrompt(language, config.systemPrompt);
  if (config.apiFormat === "anthropic") {
    return runAnthropicToolLoop({ messages, config, systemPrompt, context, fetchFn });
  }
  return runOpenAiToolLoop({ messages, config, systemPrompt, context, fetchFn });
}
