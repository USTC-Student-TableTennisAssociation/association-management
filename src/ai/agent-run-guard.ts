export type AgentRunInterruptionReason =
  | "no_progress"
  | "emergency_step_limit"
  | "context_capacity_exhausted";

export type AgentRunGuardDecision =
  | { interrupted: false }
  | {
      interrupted: true;
      reason: Exclude<AgentRunInterruptionReason, "context_capacity_exhausted">;
      detail: string;
    };

type ToolCallObservation = {
  toolName: string;
  input: unknown;
};

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null) return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    if (Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }) ?? "undefined";
}

export function evaluateAgentRunGuard(input: {
  stepNumber: number;
  toolCalls: readonly ToolCallObservation[];
  emergencyStepLimit: number;
  repeatedToolCallLimit: number;
}): AgentRunGuardDecision {
  const counts = new Map<string, { count: number; toolName: string }>();
  for (const call of input.toolCalls) {
    const signature = `${call.toolName}\n${stableJson(call.input)}`;
    const observed = counts.get(signature) ?? { count: 0, toolName: call.toolName };
    observed.count += 1;
    counts.set(signature, observed);
    if (observed.count >= input.repeatedToolCallLimit) {
      return {
        interrupted: true,
        reason: "no_progress",
        detail:
          `工具 ${observed.toolName} 已使用完全相同的参数重复调用 ` +
          `${observed.count} 次，没有形成新的探索路径`,
      };
    }
  }

  if (input.stepNumber >= input.emergencyStepLimit) {
    return {
      interrupted: true,
      reason: "emergency_step_limit",
      detail: `模型运行已达到 ${input.emergencyStepLimit} 个 step 的异常安全上限`,
    };
  }

  return { interrupted: false };
}

export function incompleteRunInstruction(input: {
  reason: AgentRunInterruptionReason;
  detail: string;
  missingProposal?: boolean;
}): string {
  return [
    `本轮运行保护已触发：${input.detail}。所有工具现已停用。`,
    "必须明确写出“本轮未完成”，简要说明已经完成的部分、尚未完成的部分和停止原因；不得把已有的局部结果表述为任务已经完成。",
    input.missingProposal
      ? "本轮虽然打开了 Business View 写入能力，但没有实际调用 View Command；必须明确说明没有生成 Proposal。"
      : "",
  ].filter(Boolean).join("\n");
}
