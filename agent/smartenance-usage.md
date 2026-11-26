# Agent usage guidance

Use the Smartenance tools for facts about the connected account. The tools read
the latest successfully synchronized database snapshot; they do not call Festo
or trigger a sync.

## Tool selection

- `get_machines`: list machines or find one by its name/number. Use `limit` and
  `offset` to page through large accounts; `total` is the number matching the
  search before pagination.
- `get_machine_details`: retrieve a machine's stored metadata and sync time.
- `get_machine_statistics`: compare incident counts across machines.
- `get_machine_incident_history`: inspect incidents for a particular machine;
  use the optional exact `state` filter when the user asks for open/closed or
  another specific state.
- `get_machine_maintenance_history`: inspect repair tasks and their timestamps.
- `compare_machines`: compare two or more identified machines.
- `get_machine_health_score`: explain one machine's heuristic score.
- `get_machine_risk_ranking`: find machines that may need attention first.
- `get_factory_overview`: get account-wide machine and incident counts, snapshot
  completeness, sync range, and the machines with the most active incidents.
- `get_factory_incident_summary`: summarize incidents for a rolling number of
  days or an explicit date range, with daily, weekly, or monthly trend buckets.
- `get_employee_work_hours`: total recorded repair-task work hours by assigned
  employee for a calendar month. It defaults to the previous full month in
  `Asia/Shanghai`; provide `month` as `YYYY-MM` for another month.

Use `get_factory_incident_summary` with `lookback_days` for a rolling view (for
example, 30 or 60 days), or `start_date` and `end_date` for a specific range.
Do not ask for fixed one-month or two-month tool variants; this tool accepts any
window. Date ranges are UTC, start-inclusive, and end-exclusive. Its date basis
is incident `occurredAt`, falling back to `createdAt`.
Rows without either usable timestamp are excluded from the requested range and
reported as `undated_incident_count_in_snapshot`.
Here, “factory” means all machines in the configured account because the
database schema has no separate factory entity.

Employee work-hour summaries use `repairTask.createdAt` and the custom fields
`维修工时`, `维修负责人`, and `协作人员` in the latest incident snapshot. The
`维修工时` field is total team labor hours, so the tool splits it equally among
the distinct responsible person and collaborators listed on each task. It
reports tasks with missing hours, unattributed hours, and mismatches between
recorded hours and the listed crew size. Only employees listed on repair tasks
in the selected month are included; employees with no such task are not implied
to have zero hours. The snapshot does not retain removed or historical task
versions.

Prefer a machine number or UUID when names are duplicated. If a lookup is
ambiguous, ask for a machine number or UUID rather than guessing. Mention the
snapshot's `synced_at` when freshness matters. Check `snapshot_complete`; if it
is false, the stored incident rows do not match the machine's recorded count.
Do not describe a missing incident as proof that no incident ever occurred:
the database only contains the latest successful synchronized snapshot.
The schema keeps the latest machine and incident snapshot, not a history of
past snapshots. A date-range summary counts incident rows in that current
snapshot; it cannot reconstruct machine state as it appeared on a past date.

Health scores are heuristics, not certified safety assessments. The API returns
the formula with each score: start at 100, subtract 20 per active incident
(maximum 60), and subtract 5 per incident from the last 90 days (maximum 25),
then clamp to zero. An incident is considered active unless its state is
`Closed`. Explain this formula when reporting a score or ranking.

Incident-history `total` reflects the filtered result when `state` is supplied.
Maintenance history is extracted from each incident's embedded `repairTasks`.
All Smartenance tools are read-only. Do not claim to create, edit, close, or
synchronize machines, incidents, or repair tasks.
