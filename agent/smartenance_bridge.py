"""Debug Agent Python bridge for Smartenance PostgreSQL analytics tools.

Runs the Smartenance IncidentService in agent/smartenance/services/incident_service.py
and automatically detects the latest synced account_key when SMARTENANCE_ACCOUNT_KEY
is empty or set to "auto".
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import asyncpg
from dotenv import load_dotenv

AGENT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = AGENT_ROOT.parent
if str(AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENT_ROOT))

# Load environment variables without overriding values explicitly passed by Broker King.
for candidate_env in (
    os.getenv("SMARTENANCE_ENV_FILE"),
    str(REPO_ROOT / ".env"),
):
    if candidate_env and Path(candidate_env).is_file():
        load_dotenv(candidate_env, override=False)

from smartenance.services.incident_service import IncidentService  # noqa: E402


async def _open_pool() -> asyncpg.Pool:
    dsn = os.getenv("DATABASE_URL", "").strip()
    if not dsn:
        raise RuntimeError("DATABASE_URL must be configured")
    return await asyncpg.create_pool(
        dsn=dsn,
        min_size=1,
        max_size=int(os.getenv("DATABASE_POOL_SIZE", "5")),
        command_timeout=30,
        server_settings={"application_name": "broker-king-debug-agent"},
    )


async def _list_accounts(pool: asyncpg.Pool) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
              m.account_key,
              COUNT(*)::int AS machine_count,
              COALESCE(SUM(m.incident_count), 0)::int AS total_incidents,
              MAX(m.synced_at) AS latest_synced_at
            FROM smartenance_machines m
            GROUP BY m.account_key
            ORDER BY MAX(m.synced_at) DESC NULLS LAST, m.account_key ASC
            """
        )
    return [
        {
            "account_key": row["account_key"],
            "machine_count": int(row["machine_count"]),
            "total_incidents": int(row["total_incidents"]),
            "latest_synced_at": row["latest_synced_at"].isoformat()
            if row["latest_synced_at"]
            else None,
        }
        for row in rows
    ]


async def _resolve_account_key(pool: asyncpg.Pool, requested_account: str | None) -> str:
    candidate = (requested_account or os.getenv("SMARTENANCE_ACCOUNT_KEY", "")).strip()
    if candidate and candidate.lower() != "auto":
        return candidate

    accounts = await _list_accounts(pool)
    if not accounts:
        raise RuntimeError(
            "No synchronized Smartenance machines found in PostgreSQL. "
            "Open the Smartenance module and click 'Sync all machines' first."
        )
    return accounts[0]["account_key"]


async def run_tool(tool: str, arguments: dict[str, Any], account_override: str | None = None) -> Any:
    pool = await _open_pool()
    try:
        if tool == "list_smartenance_accounts":
            accounts = await _list_accounts(pool)
            return {
                "accounts": accounts,
                "active_account_key": accounts[0]["account_key"] if accounts else None,
            }

        account = await _resolve_account_key(pool, account_override)
        service = IncidentService(pool, account)

        if tool == "get_machines":
            return await service.get_machines(
                arguments.get("search"),
                int(arguments.get("limit", 100)),
                int(arguments.get("offset", 0)),
            )
        if tool == "get_machine_details":
            return await service.get_machine_details(str(arguments["machine_id"]))
        if tool == "get_machine_statistics":
            return await service.get_machine_statistics()
        if tool == "get_machine_incident_history":
            return await service.get_machine_incident_history(
                str(arguments["machine_id"]),
                int(arguments.get("limit", 100)),
                arguments.get("state"),
            )
        if tool == "get_machine_maintenance_history":
            return await service.get_machine_maintenance_history(
                str(arguments["machine_id"]),
                int(arguments.get("limit", 100)),
            )
        if tool == "compare_machines":
            return await service.compare_machines([str(m) for m in arguments["machine_ids"]])
        if tool == "get_machine_health_score":
            return await service.get_machine_health_score(str(arguments["machine_id"]))
        if tool == "get_machine_risk_ranking":
            return await service.get_machine_risk_ranking(int(arguments.get("limit", 20)))
        if tool == "get_factory_overview":
            return await service.get_factory_overview(int(arguments.get("machine_limit", 10)))
        if tool == "get_factory_incident_summary":
            return await service.get_factory_incident_summary(
                arguments.get("lookback_days"),
                arguments.get("start_date"),
                arguments.get("end_date"),
                arguments.get("granularity", "month"),
                int(arguments.get("machine_limit", 20)),
            )
        if tool == "get_employee_work_hours":
            return await service.get_employee_work_hours(arguments.get("month"))
        raise ValueError(f"Unknown Smartenance tool: {tool}")
    finally:
        await pool.close()


def _json_default(value: Any) -> str:
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def main() -> int:
    try:
        request = json.load(sys.stdin)
        tool = request.get("tool")
        arguments = request.get("arguments") or {}
        account_override = request.get("account_key")
        if not isinstance(tool, str) or not isinstance(arguments, dict):
            raise ValueError("Expected JSON with 'tool' string and 'arguments' object")
        result = asyncio.run(run_tool(tool, arguments, account_override))
        json.dump({"result": result}, sys.stdout, ensure_ascii=False, default=_json_default)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:
        print(f"Smartenance query failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
