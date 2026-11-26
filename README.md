# Broker King

Unified industrial edge, energy efficiency, maintenance, and AI diagnostics platform integrating **Connector**, **MSE6-C2M**, **Smartenance**, and **Debug Agent** into a single application with one shared Node.js backend and PostgreSQL database.

## Modules

- **Connector** (`src/connector/`, `server/connector/`) — PLC (Modbus TCP, Siemens S7, OPC UA, Beckhoff, Rockwell) and MQTT data acquisition & publishing, including automatic database restoration on cold boot, cycle-consistent 66-cylinder datablock publishing, single-flight MQTT connection deduplication, and hot-reload of MQTT/PLC configurations.
- **MSE6-C2M** (`src/c2m/`, `server/c2m/`) — MSE6-C2M (CPX-FB36) energy efficiency module telemetry, automatic/manual pressure & valve control, parameter configuration, and MQTT telemetry output.
- **Smartenance** (`app/page.tsx`, `lib/festo/`) — Repair task query, PostgreSQL synchronization, and CSV export.
- **Debug Agent** (`src/debug-agent/`, `server/debug-agent/`, `agent/`) — Built-in AI diagnostics & maintenance assistant supporting multi-customer LLM configuration (DeepSeek, OpenAI, Qwen, Anthropic, OpenRouter, local Ollama), live Connector & PLC health checks, real-time MQTT topic subscription sampling (66-cylinder 6-timestamp verification), MSE6-C2M telemetry inspection, and Smartenance PostgreSQL analytics (`agent/smartenance/services/incident_service.py`).

## Project Structure

```text
BrokerKing/
├── app/                     # Unified application shell (page.tsx, layout.tsx) & API routes
├── components/              # Shared UI primitives
├── src/                     # Modular frontend workspaces
│   ├── connector/           # PLC & MQTT Connector UI
│   ├── c2m/                 # MSE6-C2M configuration & telemetry UI
│   └── debug-agent/         # Debug Agent chat, quick diagnostics & model settings UI
├── server/                  # Unified Node.js backend runtime
│   ├── unifiedBackend.js    # Unified API gateway
│   ├── database.js          # Shared PostgreSQL pool bridge
│   ├── connector/           # MQTT publisher & PLC pollers (Modbus, S7, OPC UA)
│   ├── c2m/                 # MSE6-C2M Modbus & MQTT backend
│   └── debug-agent/         # Debug Agent engine, config store & live diagnostics
├── agent/                   # Python analytics tools (Smartenance DB service & MCP server)
├── lib/                     # Smartenance sync/export engine & shared PostgreSQL pool
├── shared/                  # Shared Modbus datablock, layout & MQTT topic helpers
├── db/                      # Unified PostgreSQL schema (schema.sql)
├── scripts/                 # Dev startup & local PostgreSQL management scripts
├── deploy/                  # Offline Docker deployment package (docker-compose.yml & .tar)
├── docs/                    # Project documentation
├── public/                  # Static assets
├── tests/                   # Unit & integration test suite
├── Dockerfile               # Production image build
└── docker-compose.yml       # Local Docker Compose definition
```

## Quick Start

```sh
npm run dev
```

This automatically verifies or starts PostgreSQL, initializes `db/schema.sql`, and starts **Broker King** at **http://127.0.0.1:3000**.
