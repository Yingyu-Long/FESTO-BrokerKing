import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query as defaultQuery } from "../database.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const BRIDGE_SCRIPT = path.join(REPO_ROOT, "agent", "smartenance_bridge.py");
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 60_000;

export const SMARTENANCE_TOOL_NAMES = new Set([
  "list_smartenance_accounts",
  "get_machines",
  "get_machine_details",
  "get_machine_statistics",
  "get_machine_incident_history",
  "get_machine_maintenance_history",
  "compare_machines",
  "get_machine_health_score",
  "get_machine_risk_ranking",
  "get_factory_overview",
  "get_factory_incident_summary",
  "get_employee_work_hours",
]);

export function resolvePythonExecutable(env = process.env) {
  const candidates = [
    env.DEBUG_AGENT_PYTHON_PATH,
    env.HERMES_PYTHON_PATH,
    path.join(REPO_ROOT, "agent", ".venv", "bin", "python"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

export function getPythonBridgeStatus(env = process.env) {
  const pythonPath = resolvePythonExecutable(env);
  return {
    bridgeExists: existsSync(BRIDGE_SCRIPT),
    bridgePath: BRIDGE_SCRIPT,
    pythonPath,
    usingVenv: pythonPath !== "python3",
  };
}

export async function listSmartenanceAccountsFromDb(queryFn = defaultQuery) {
  try {
    const result = await queryFn(`
      SELECT
        account_key,
        COUNT(*)::int AS machine_count,
        COALESCE(SUM(incident_count), 0)::int AS total_incidents,
        MAX(synced_at) AS latest_synced_at
      FROM smartenance_machines
      GROUP BY account_key
      ORDER BY MAX(synced_at) DESC NULLS LAST, account_key ASC
    `);
    return result.rows.map((row) => ({
      account_key: String(row.account_key),
      machine_count: Number(row.machine_count ?? 0),
      total_incidents: Number(row.total_incidents ?? 0),
      latest_synced_at: row.latest_synced_at ? new Date(row.latest_synced_at).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

export async function runSmartenanceBridgeTool(
  tool,
  argumentsObj = {},
  { accountKey = "auto", queryFn = defaultQuery, env = process.env } = {},
) {
  if (!SMARTENANCE_TOOL_NAMES.has(tool)) {
    throw new Error(`Unsupported Smartenance tool: ${tool}`);
  }

  // Fast SQL path for listing synced Smartenance accounts without spawning Python.
  if (tool === "list_smartenance_accounts") {
    const accounts = await listSmartenanceAccountsFromDb(queryFn);
    return {
      accounts,
      active_account_key: accounts[0]?.account_key ?? null,
    };
  }

  if (!existsSync(BRIDGE_SCRIPT)) {
    throw new Error(`Smartenance Python bridge script not found at ${BRIDGE_SCRIPT}`);
  }

  const pythonPath = resolvePythonExecutable(env);
  const databaseUrl = String(env.DATABASE_URL ?? "").trim();
  const childEnv = {
    ...env,
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    ...(accountKey && accountKey !== "auto" ? { SMARTENANCE_ACCOUNT_KEY: accountKey } : {}),
  };

  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(pythonPath, [BRIDGE_SCRIPT], {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishError(new Error(`Smartenance tool "${tool}" timed out after ${TOOL_TIMEOUT_MS}ms.`));
    }, TOOL_TIMEOUT_MS);

    function finishError(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectResult(error);
    }

    child.once("error", (error) => {
      finishError(
        new Error(
          `Could not start Hermes Python Smartenance bridge (${pythonPath}): ${error.message}`,
        ),
      );
    });

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finishError(new Error("Smartenance tool output exceeded the 2 MiB limit."));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
    });

    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finishError(new Error(detail || `Smartenance Python bridge exited with code ${code}.`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        if (!Object.hasOwn(parsed, "result")) {
          throw new Error("Smartenance Python bridge returned no result field.");
        }
        settled = true;
        resolveResult(parsed.result);
      } catch (error) {
        finishError(
          new Error(
            `Could not parse Smartenance bridge response: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });

    child.stdin.end(
      JSON.stringify({
        tool,
        arguments: argumentsObj ?? {},
        account_key: accountKey && accountKey !== "auto" ? accountKey : null,
      }),
    );
  });
}
