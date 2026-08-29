// The approval record's closed value sets.
//
// `type` selects a lifecycle, not a subject. Each of the three has one creator:
// the action engine writes `action_execution`, and the inbox app writes
// `outgoing_message` and `person_mapping`. Leaving the column a bare string
// invited callers — and fixtures — to invent kinds nothing downstream knows how
// to resolve.
//
// `person_mapping` is the lifecycle for approving a link (docs/concepts/
// people.md#link). It keeps its name because it is a persisted column value: a
// rename would strand every stored row.

// Defined in @rome-os/app-runtime — the SDK apps compile against, and therefore
// the only place that can constrain the two lifecycles apps create. Re-exported
// here so core and the dashboard import their contracts from one module.
export {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  type ApprovalStatus,
  type ApprovalType,
} from "@rome-os/app-runtime";

/** Set only for `action_execution`: the queued run's progress after approval.
 *  `idle` covers both "not approved yet" and "approved, nothing queued". */
export const APPROVAL_EXECUTION_STATES = [
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export type ApprovalExecutionState = (typeof APPROVAL_EXECUTION_STATES)[number];
