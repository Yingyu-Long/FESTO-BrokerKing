import { plainText } from "./plain-text.ts";

const fields = {
  repairContent: ["维修内容", "Repair content", "Repair work", "Maintenance content"],
  repairTime: ["维修时间", "Repair time", "Repair duration", "Maintenance time"],
  repairLaborHours: ["维修工时", "Repair labor hours", "Repair labour hours", "Repair working hours", "Maintenance man-hours"],
  downtime: ["停机时间", "Downtime", "Machine downtime"],
  repairRemarks: ["备注", "Remarks", "Notes", "Comment"],
  repairOwner: ["维修负责人", "Repair owner", "Repair responsible", "Person responsible", "Responsible person", "Maintenance responsible"],
  repairCollaborators: ["协作人员", "Collaborators", "Assistants", "Supporting personnel"],
} as const;

const normalize = (value: string) => value.toLowerCase().replace(/[\s_\-:：()（）]/g, "");

function readable(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return plainText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join("; ");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["name", "label", "value"]) {
      if (object[key] != null) return readable(object[key]);
    }
    return Object.entries(object).map(([key, item]) => `${key}: ${readable(item)}`).join("; ");
  }
  return "";
}

export function repairCustomFields(values: unknown[] | null | undefined) {
  const result = Object.fromEntries(Object.keys(fields).map(key => [key, ""])) as Record<keyof typeof fields, string>;
  for (const value of values ?? []) {
    if (!value || typeof value !== "object") continue;
    const field = value as Record<string, unknown>;
    // Match original and translated labels, independent of the requested API language.
    const translations = field.translations && typeof field.translations === "object"
      ? Object.values(field.translations).map(item => item && typeof item === "object" ? (item as Record<string, unknown>).title : null)
      : [];
    const labels = [field.label, field.defaultLanguageLabel, ...translations]
      .filter((label): label is string => typeof label === "string").map(normalize);
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      if (fields[key].some(alias => labels.includes(normalize(alias)))) {
        const text = readable(field.value);
        if (text) result[key] = result[key] ? `${result[key]}; ${text}` : text;
      }
    }
  }
  return result;
}
