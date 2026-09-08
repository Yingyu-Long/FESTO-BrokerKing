import type { Filters, RepairRow } from "./types.ts";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;
export function dateBounds(from: string, to: string) {
  function parse(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Select valid start and end dates.");
    const utc = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value)
      throw new Error("This date does not exist. Choose another date.");
    return utc - 8 * 3600000;
  }
  const start = parse(from),
    end = parse(to) + DAY;
  if (start >= end) throw new Error("The start date cannot be after the end date.");
  return { start, end };
}
export function validateFilters(value: unknown): Filters {
  const v = value as Partial<Filters> | null;
  if (
    !v ||
    !Array.isArray(v.machineIds) ||
    !v.machineIds.length ||
    !v.machineIds.every((id) => typeof id === "string" && UUID.test(id))
  )
    throw new Error("Select at least one valid machine.");
  if (typeof v.from !== "string" || typeof v.to !== "string")
    throw new Error("Select a start and end date.");
  dateBounds(v.from, v.to);
  return { machineIds: [...new Set(v.machineIds)], from: v.from, to: v.to };
}
export function chinaDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function formatTime(value: string) {
  if (!value) return "";
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ")
    : value;
}
export const resultLabels: Record<string, string> = {
  Unknown: "Not recorded",
  Success: "Success",
  Failure: "Failure",
};
export const CSV_COLUMNS: {
  key: keyof RepairRow;
  label: string;
  time?: boolean;
}[] = [
  { key: "machineName", label: "Machine name" },
  { key: "machineNumber", label: "Machine number" },
  { key: "machineId", label: "Machine ID" },
  { key: "incidentNumber", label: "Incident number" },
  { key: "incidentId", label: "Incident ID" },
  { key: "incidentSummary", label: "Incident summary" },
  { key: "incidentState", label: "Incident status" },
  {
    key: "incidentOccurredAt",
    label: "Incident occurred at (UTC+8)",
    time: true,
  },
  { key: "incidentFixedAt", label: "Incident fixed at (UTC+8)", time: true },
  { key: "incidentDescription", label: "Incident description" },
  { key: "incidentCause", label: "Incident cause" },
  { key: "taskId", label: "Repair task ID" },
  { key: "description", label: "Repair task description" },
  { key: "result", label: "Repair result" },
  { key: "createdAt", label: "Task created at (UTC+8)", time: true },
  { key: "createdBy", label: "Task created by" },
  { key: "modifiedAt", label: "Task modified at (UTC+8)", time: true },
  { key: "modifiedBy", label: "Task modified by" },
  { key: "comments", label: "Task comments (JSON)" },
  { key: "repairContent", label: "Repair content" },
  { key: "repairTime", label: "Repair time" },
  { key: "repairLaborHours", label: "Repair labor hours" },
  { key: "downtime", label: "Downtime" },
  { key: "repairRemarks", label: "Remarks" },
  { key: "repairOwner", label: "Repair owner" },
  { key: "repairCollaborators", label: "Collaborators" },
];
export function csvCell(value: string) {
  // Quoting alone does not stop spreadsheet formula execution.
  const safe =
    /^[\s\p{Cc}]*[=+\-@＝＋－＠]/u.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function toCsv(rows: RepairRow[]) {
  return (
    "\uFEFF" +
    [
      CSV_COLUMNS.map((c) => csvCell(c.label)).join(","),
      ...rows.map((row) =>
        CSV_COLUMNS.map((c) =>
          csvCell(
            c.time
              ? formatTime(row[c.key])
              : c.key === "result"
                ? (resultLabels[row.result] ?? row.result)
                : row[c.key],
          ),
        ).join(","),
      ),
    ].join("\r\n") +
    "\r\n"
  );
}
