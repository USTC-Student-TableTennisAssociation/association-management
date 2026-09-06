export type CompilationFileRunStatus =
  | "idle"
  | "queued"
  | "running"
  | "ready"
  | "failed";

export type CompilationFileGate = "ready" | "pending" | "failed";

/**
 * A later compilation phase may start only after every run in the current
 * scope is ready. A failure takes precedence over pending work so the job can
 * stop and expose an explicit retry action instead of silently skipping it.
 */
export function compilationFileGate(
  statuses: readonly CompilationFileRunStatus[],
): CompilationFileGate {
  if (statuses.includes("failed")) return "failed";
  if (statuses.some((status) => status !== "ready")) return "pending";
  return "ready";
}
