# Broker King · Debug Agent Python Analytics

This directory contains the Python analytics runtime used by Broker King's built-in **Debug Agent**:

- `smartenance_bridge.py` — JSON stdin/stdout bridge invoked by `server/debug-agent/smartenanceTools.js`, supporting automatic customer `account_key` detection.
- `smartenance/services/incident_service.py` — Read-only Smartenance PostgreSQL analytics service (factory overview, incident summaries, employee work hours, machine health scoring & risk ranking).
- `smartenance/database/db.py` — Async PostgreSQL connection helpers.
- `mcp_server.py` — Optional stdio MCP server exposing all Broker King diagnostic tools to external AI CLIs.
- `requirements.txt` — Minimal Python dependencies (`asyncpg`, `python-dotenv`).
