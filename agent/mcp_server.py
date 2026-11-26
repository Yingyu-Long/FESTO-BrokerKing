"""Lightweight JSON-RPC stdio MCP server for external AI Agent CLIs.

Exposes Broker King's unified diagnostic tools (Smartenance DB analytics +
Connector status + live MQTT subscription sampling + MSE6-C2M telemetry).

Usage in MCP config:
  mcp_servers:
    broker-king:
      command: python3
      args: ["/path/to/BrokerKing/agent/mcp_server.py"]
      env:
        BROKER_KING_URL: "http://127.0.0.1:3000"
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

BROKER_KING_URL = os.getenv("BROKER_KING_URL", "http://127.0.0.1:3000").rstrip("/")


def _http_json(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    url = f"{BROKER_KING_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=70) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Broker King API HTTP {exc.code}: {body}") from exc


def _send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _handle_request(msg: dict[str, Any]) -> dict[str, Any] | None:
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "notifications/initialized":
        return None

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "broker-king-debug-agent", "version": "1.0.0"},
            },
        }

    if method == "tools/list":
        data = _http_json("GET", "/api/debug-agent/tools")
        tools = [
            {
                "name": item["name"],
                "description": item["description"],
                "inputSchema": item["parameters"],
            }
            for item in data.get("tools", [])
        ]
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": tools}}

    if method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments") or {}
        data = _http_json(
            "POST",
            "/api/debug-agent/tool",
            {"tool": tool_name, "arguments": arguments},
        )
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(data.get("result", data), ensure_ascii=False, indent=2),
                    }
                ],
                "isError": not bool(data.get("ok", True)),
            },
        }

    if msg_id is None:
        return None
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        msg_id = None
        try:
            msg = json.loads(line)
            msg_id = msg.get("id")
            response = _handle_request(msg)
            if response is not None:
                _send(response)
        except Exception as exc:
            if msg_id is not None:
                _send(
                    {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "error": {"code": -32000, "message": str(exc)},
                    }
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
