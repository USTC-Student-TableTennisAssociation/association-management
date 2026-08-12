export function estimateSerializedTokens(value: unknown): number {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  return Math.max(1, Math.ceil(bytes / 3));
}

/** Shared request-local budget for all tool results fed back into the model. */
export class ToolResultTokenBudget {
  private usedTokens = 0;

  constructor(readonly maximumTokens: number) {}

  reserve(value: unknown): boolean {
    const tokens = estimateSerializedTokens(value);
    if (this.usedTokens + tokens > this.maximumTokens) return false;
    this.usedTokens += tokens;
    return true;
  }

  remainingTokens(): number {
    return Math.max(0, this.maximumTokens - this.usedTokens);
  }
}
