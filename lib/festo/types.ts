export interface Machine {
  id: string;
  name: string | null;
  number: string | null;
  timeZone?: string | null;
}
export interface RepairTask {
  id: string;
  description?: string | null;
  result?: string;
  createdAt: string;
  createdBy?: string | null;
  modifiedAt?: string | null;
  modifiedBy?: string | null;
  comments?: unknown[] | null;
  customFields?: unknown[] | null;
}
export interface Incident {
  id: string;
  number?: number;
  logNumber?: number;
  type?: string | null;
  machineId?: string | null;
  summary?: string | null;
  description?: string | null;
  cause?: string | null;
  state?: string | null;
  occurredAt?: string;
  createdAt?: string;
  fixedDateTime?: string | null;
  repairTasks?: RepairTask[] | null;
}
export interface RepairRow {
  machineId: string;
  machineName: string;
  machineNumber: string;
  incidentId: string;
  incidentNumber: string;
  incidentSummary: string;
  incidentState: string;
  incidentOccurredAt: string;
  incidentFixedAt: string;
  incidentDescription: string;
  incidentCause: string;
  taskId: string;
  description: string;
  result: string;
  createdAt: string;
  createdBy: string;
  modifiedAt: string;
  modifiedBy: string;
  comments: string;
  repairContent: string;
  repairTime: string;
  repairLaborHours: string;
  downtime: string;
  repairRemarks: string;
  repairOwner: string;
  repairCollaborators: string;
}
export interface Filters {
  machineIds: string[];
  from: string;
  to: string;
}
export type Progress = {
  type: "progress";
  message: string;
  scanned: number;
  matched: number;
};
export type ExportEvent =
  | Progress
  | { type: "complete"; rows: RepairRow[]; scanned: number }
  | { type: "error"; message: string; status: number };
