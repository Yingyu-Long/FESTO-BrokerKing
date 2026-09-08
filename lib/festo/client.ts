import type { Machine, Incident, RepairRow, Filters, Progress } from "./types.ts";
import { dateBounds, UUID } from "./shared.ts";
export const API_BASE = "https://api.festo.com/apps/smartenance/v1";
export const AUTH_POLICIES = ["b2c_1_apisignin_ropc", "b2c_1_ropc_apisignin"] as const;
export class FestoError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "FestoError";
    this.status = status;
  }
}
export function errorMessage(error: unknown) {
  return error instanceof FestoError
    ? error.message
    : error instanceof Error && error.name === "AbortError"
      ? "Query cancelled."
      : "The connection was interrupted or the response was invalid. Please try again.";
}
export function validateToken(value: unknown) {
  if (typeof value !== "string") throw new FestoError("Enter an API access token.", 400);
  const token = value.trim().replace(/^Bearer\s+/i, "");
  if (!token || token.length > 16000 || /[\s\r\n]/.test(token))
    throw new FestoError("The access token format is invalid.", 400);
  return token;
}
export class FestoClient {
  private token: string;
  private fetcher: typeof fetch;
  private signal?: AbortSignal;
  constructor(token: string, options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}) {
    this.token = validateToken(token);
    this.fetcher = options.fetcher ?? fetch;
    this.signal = options.signal;
  }
  async get(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    this.signal?.throwIfAborted();
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const timeout = AbortSignal.timeout(30000);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "SMRTNC-LANGUAGE": "en",
        },
        redirect: "manual",
        cache: "no-store",
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      });
    } catch (error) {
      this.signal?.throwIfAborted();
      throw new FestoError(
        error instanceof Error && error.name === "TimeoutError"
          ? "Festo did not respond in time. Please try again."
          : "Unable to connect to Festo. Check the connection and try again.",
      );
    }
    // Workerd supports manual redirects, but not redirect: 'error'.
    // Never follow a redirect with the user's bearer token.
    if (response.status >= 300 && response.status < 400)
      throw new FestoError(
        "Festo returned an unexpected redirect. The request was stopped to protect your credentials.",
      );
    if (!response.ok) {
      const retry = response.headers.get("X-Retry-After") ?? response.headers.get("Retry-After");
      const wait =
        retry && /^\d+$/.test(retry)
          ? ` Please wait at least ${retry} seconds before trying again.`
          : "";
      // Festo explicitly warns against retrying an invalid access token.
      if (response.status === 401)
        throw new FestoError(
          "The access token has expired or is invalid. Reconnect to continue. This request will not be retried automatically.",
          401,
        );
      if (response.status === 403)
        throw new FestoError(
          `Festo denied access. Check API account permissions or access restrictions.${wait}`,
          403,
        );
      if (response.status === 429)
        throw new FestoError(
          `Festo has limited the request rate.${wait || " Please try again later."}`,
          429,
        );
      if (response.status === 404)
        throw new FestoError("A machine or incident no longer exists. Run the query again.", 404);
      throw new FestoError(
        `Festo returned an error (${response.status}). No results were exported.`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new FestoError("Festo returned an unreadable response. No results were exported.");
    }
  }
  async *pages<T extends { id: string }>(
    path: string,
    params: Record<string, string | number> = {},
    limit = 200,
  ): AsyncGenerator<T[]> {
    let offset = 0,
      expectedTotal: number | undefined;
    const seen = new Set<string>();
    while (true) {
      const page = (await this.get(path, { ...params, offset, limit })) as {
        items?: T[] | null;
        total?: number;
        offset?: number;
      };
      if (page?.items === null && page.total === 0) page.items = [];
      if (
        !page ||
        !Array.isArray(page.items) ||
        !Number.isInteger(page.total) ||
        page.total! < 0 ||
        page.offset !== offset
      )
        throw new FestoError(
          "The Festo pagination response is invalid. The query stopped to avoid missing records.",
        );
      if (expectedTotal !== undefined && expectedTotal !== page.total)
        throw new FestoError(
          "The record count changed during the query. Run it again to obtain complete results.",
        );
      expectedTotal = page.total;
      if (
        offset + page.items.length > expectedTotal! ||
        (!page.items.length && offset < expectedTotal!)
      )
        throw new FestoError("Festo returned an incomplete page. Run the query again.");
      for (const item of page.items) {
        if (!item || typeof item.id !== "string" || !UUID.test(item.id) || seen.has(item.id))
          throw new FestoError(
            "A page contains duplicate or invalid records. Run the query again.",
          );
        seen.add(item.id);
      }
      if (seen.size > 100000)
        throw new FestoError(
          "This machine has more than 100,000 records. Contact your administrator to use the bulk export API.",
          413,
        );
      yield page.items;
      offset += page.items.length;
      if (offset >= expectedTotal!) return;
    }
  }
  async machines(): Promise<Machine[]> {
    // Festo explicitly supports limit=-1 for all machines, ignoring offset.
    // Incident pagination remains separate and retains its page size.
    const response = (await this.get("/machines", { limit: -1 })) as {
      items?: Machine[] | null;
      total?: number;
    };
    const items = response?.items === null && response.total === 0 ? [] : response?.items;
    if (
      !Array.isArray(items) ||
      !Number.isInteger(response?.total) ||
      response.total !== items.length
    )
      throw new FestoError(
        "Festo did not return the complete machine list. Reconnect to try again.",
      );
    const ids = new Set<string>();
    for (const machine of items) {
      if (
        !machine ||
        typeof machine.id !== "string" ||
        !UUID.test(machine.id) ||
        ids.has(machine.id)
      )
        throw new FestoError(
          "Festo returned duplicate or invalid machines. Reconnect to try again.",
        );
      ids.add(machine.id);
    }
    return items;
  }
}
export async function loginAccount(
  username: unknown,
  password: unknown,
  policy: unknown,
  fetcher: typeof fetch = fetch,
) {
  if (
    typeof username !== "string" ||
    !username.trim() ||
    username.length > 500 ||
    typeof password !== "string" ||
    !password ||
    password.length > 4000
  )
    throw new FestoError("Enter your Smartenance Premium API username and password.", 400);
  if (typeof policy !== "string" || !(AUTH_POLICIES as readonly string[]).includes(policy))
    throw new FestoError("The authentication policy is invalid.", 400);
  const body = new URLSearchParams({
    grant_type: "password",
    scope:
      "offline_access https://smartenance.onmicrosoft.com/f10ca0d5-d3ce-47d0-92fa-5c73a3ed6436/access",
    client_id: "9601ab4b-7c37-43b9-8b58-ffc5cf7cc642",
    response_type: "token",
    username: username.trim(),
    password,
  });
  let response: Response;
  try {
    response = await fetcher(
      `https://smartenance.b2clogin.com/smartenance.onmicrosoft.com/oauth2/v2.0/token?p=${policy}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch {
    throw new FestoError(
      "Unable to connect to the Smartenance sign-in service. Check the connection.",
    );
  }
  // Do not forward account credentials to a redirected destination.
  if (response.status >= 300 && response.status < 400)
    throw new FestoError(
      "The Smartenance sign-in service returned an unexpected redirect. Sign-in was stopped.",
    );
  if (!response.ok)
    throw new FestoError(
      `Smartenance sign-in failed (${response.status}). Check your API username, password and authentication policy, or use an access token.`,
      response.status === 429 ? 429 : 401,
    );
  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  return {
    token: validateToken(data.access_token),
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
  };
}
export async function collectRepairs(
  client: FestoClient,
  filters: Filters,
  onProgress: (event: Progress) => void = () => {},
  signal?: AbortSignal,
) {
  const { start, end } = dateBounds(filters.from, filters.to);
  const machines = await client.machines();
  const selected = filters.machineIds.map((id) => machines.find((m) => m.id === id));
  if (selected.some((m) => !m))
    throw new FestoError(
      "A selected machine no longer exists or is inaccessible. Reconnect to reload machines.",
      400,
    );
  const rows: RepairRow[] = [];
  let scanned = 0;
  const taskIds = new Set<string>();
  for (const machine of selected as Machine[]) {
    onProgress({
      type: "progress",
      message: `Reading incidents for ${machine.name || machine.id}…`,
      scanned,
      matched: rows.length,
    });
    // Do not apply incident from/to filters: a repair can be created long after its incident.
    for await (const logs of client.pages<Incident>("/incidents", {
      machineId: machine.id,
    })) {
      for (const log of logs) {
        signal?.throwIfAborted();
        if (log.machineId !== machine.id)
          throw new FestoError(
            "Festo returned an incident for a different machine. The query was stopped.",
          );
        // The list may also contain maintenance/information logs.
        if (log.type && log.type !== "Incident") continue;
        const incident = (await client.get(`/incidents/${encodeURIComponent(log.id)}`)) as Incident;
        if (
          !incident ||
          incident.id !== log.id ||
          (incident.machineId && incident.machineId !== machine.id) ||
          (incident.repairTasks != null && !Array.isArray(incident.repairTasks))
        )
          throw new FestoError(
            "The incident details are invalid. The query stopped to avoid missing tasks.",
          );
        for (const task of incident.repairTasks ?? []) {
          const created = Date.parse(task.createdAt);
          if (
            !UUID.test(task.id) ||
            !Number.isFinite(created) ||
            !/(Z|[+-]\d{2}:\d{2})$/i.test(task.createdAt)
          )
            throw new FestoError(
              "A repair task has an invalid ID or creation time and cannot be filtered reliably.",
            );
          if (created < start || created >= end) continue;
          if (taskIds.has(task.id))
            throw new FestoError("Festo returned a duplicate repair task. Run the query again.");
          taskIds.add(task.id);
          rows.push({
            machineId: machine.id,
            machineName: machine.name ?? "",
            machineNumber: machine.number ?? "",
            incidentId: log.id,
            incidentNumber: String(incident.logNumber ?? log.number ?? ""),
            incidentSummary: incident.summary ?? "",
            incidentState: incident.state ?? "",
            incidentOccurredAt: incident.occurredAt ?? "",
            incidentFixedAt: incident.fixedDateTime ?? "",
            incidentDescription: incident.description ?? "",
            incidentCause: incident.cause ?? "",
            taskId: task.id,
            description: task.description ?? "",
            result: task.result ?? "Unknown",
            createdAt: task.createdAt,
            createdBy: task.createdBy ?? "",
            modifiedAt: task.modifiedAt ?? "",
            modifiedBy: task.modifiedBy ?? "",
            comments: JSON.stringify(task.comments ?? []),
            customFields: JSON.stringify(task.customFields ?? []),
          });
          if (rows.length > 100000)
            throw new FestoError(
              "More than 100,000 tasks matched. Select fewer machines or a shorter date range.",
              413,
            );
        }
        scanned++;
        onProgress({
          type: "progress",
          message: `Checked ${scanned} incidents. Found ${rows.length} matching repair tasks.`,
          scanned,
          matched: rows.length,
        });
      }
    }
  }
  rows.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.taskId.localeCompare(b.taskId),
  );
  return { rows, scanned };
}
