import { spawn, spawnSync } from "node:child_process";
import pg from "pg";

async function canConnectToDatabase(connectionString) {
  if (!connectionString) return false;
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function ensureDatabaseReady() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.warn(
      "DATABASE_URL is not configured in .env; PostgreSQL features will stay in standby.",
    );
    return;
  }

  // 1. If the configured PostgreSQL (external, Docker, or already-running local) is reachable,
  //    just make sure the unified schema (db/schema.sql) is initialized.
  if (await canConnectToDatabase(databaseUrl)) {
    spawnSync(process.execPath, ["--env-file-if-exists=.env", "scripts/db-init.mjs"], {
      stdio: "inherit",
    });
    return;
  }

  // 2. If DATABASE_URL targets localhost / 127.0.0.1 and nothing is listening yet,
  //    automatically start the bundled local PostgreSQL instance.
  let isLoopback = false;
  try {
    const parsed = new URL(databaseUrl);
    isLoopback = ["127.0.0.1", "localhost"].includes(parsed.hostname);
  } catch {
    isLoopback = false;
  }

  if (isLoopback) {
    const result = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "scripts/local-db.mjs", "start"],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      console.warn(
        "Unable to auto-start local PostgreSQL. Check DATABASE_URL in .env or .local/postgres.log.",
      );
    }
  } else {
    console.warn(
      "Configured remote PostgreSQL is currently unreachable. Check DATABASE_URL in .env.",
    );
  }
}

await ensureDatabaseReady();

const child = spawn(
  process.execPath,
  ["--env-file-if-exists=.env", "node_modules/vinext/dist/cli.js", "dev"],
  {
    env: { ...process.env },
    stdio: "inherit",
  },
);

function stop(signal = "SIGTERM") {
  if (child.exitCode === null) child.kill(signal);
}

child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
