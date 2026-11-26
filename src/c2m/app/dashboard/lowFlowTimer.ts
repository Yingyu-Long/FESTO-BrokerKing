// The C2M delay parameter is in minutes; timestamps come from device polling.
export function remainingLowFlowSeconds(
  delayMinutes: number,
  startedAt: number | null | undefined,
  timestamp: number,
): number | null {
  if (startedAt == null) return null;
  return Math.max(0, Math.ceil((startedAt + delayMinutes * 60_000 - timestamp) / 1000));
}
