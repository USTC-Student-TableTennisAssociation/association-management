import { toolPolicy, type ToolEffect } from "@/ai/tool-policy";

export type CapabilityExecution = {
  toolName: string;
  declaredEffect: ToolEffect;
  success: boolean;
  outcome: "read" | "proposal" | "commit" | "no_effect" | "unknown" | "failed";
};

export type CapabilityLedgerSnapshot = {
  exposedTools: string[];
  executions: CapabilityExecution[];
  successfulReads: string[];
  pendingProposals: string[];
  committedWrites: string[];
};

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** Request-local record of capabilities actually exposed and executed. */
export class CapabilityLedger {
  private readonly exposed = new Set<string>();
  private readonly executions: CapabilityExecution[] = [];

  recordExposure(toolNames: readonly string[]): void {
    toolNames.forEach((name) => this.exposed.add(name));
  }

  recordExecution(
    toolName: string,
    success: boolean,
    output?: unknown,
    declaredEffectOverride?: ToolEffect,
  ): void {
    const declaredEffect = declaredEffectOverride ?? toolPolicy(toolName).effect;
    this.executions.push({
      toolName,
      declaredEffect,
      success,
      outcome: executionOutcome(declaredEffect, success, output),
    });
  }

  snapshot(): CapabilityLedgerSnapshot {
    const successful = this.executions.filter((item) => item.success);
    return {
      exposedTools: [...this.exposed],
      executions: this.executions.map((item) => ({ ...item })),
      successfulReads: unique(successful.flatMap((item) =>
        item.outcome === "read" ? [item.toolName] : []
      )),
      pendingProposals: unique(successful.flatMap((item) =>
        item.outcome === "proposal" ? [item.toolName] : []
      )),
      committedWrites: unique(successful.flatMap((item) =>
        item.outcome === "commit" ? [item.toolName] : []
      )),
    };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

/** Derives side effects from explicit tool receipts, never from prose. */
function executionOutcome(
  effect: ToolEffect,
  success: boolean,
  output: unknown,
): CapabilityExecution["outcome"] {
  if (!success) return "failed";
  if (effect === "none") return "read";
  const receipt = record(output);
  const submittedProposals = Array.isArray(receipt?.submittedProposals)
    ? receipt.submittedProposals.length
    : 0;
  const executedCommands = Array.isArray(receipt?.executedCommands)
    ? receipt.executedCommands.length
    : 0;
  const proposalReceipt = typeof receipt?.proposalId === "string" ||
    receipt?.kind === "proposed" || submittedProposals > 0;
  const commitReceipt = receipt?.committed === true ||
    receipt?.kind === "executed" || executedCommands > 0 ||
    (receipt?.completed === true && positiveNumber(receipt.publishedAssertions));
  if (commitReceipt) return "commit";
  if (proposalReceipt) return "proposal";
  if (effect === "unknown") return "unknown";
  return "no_effect";
}
