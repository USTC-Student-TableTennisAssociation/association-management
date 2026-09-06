export type CompilationFailureCategory =
  | "authentication"
  | "billing"
  | "configuration"
  | "model_output"
  | "rate_limit"
  | "remote_service"
  | "transport"
  | "internal";

export type CompilationFailure = {
  retryable: boolean;
  category: CompilationFailureCategory;
  message: string;
  statusCode?: number;
};

const FAILURE_MARKER = "SYDARIS_FAILURE ";
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function retryableModelOutputFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const marker: CompilationFailure = {
    retryable: true,
    category: "model_output",
    message,
  };
  return new Error(`${message}\n${FAILURE_MARKER}${JSON.stringify(marker)}`, {
    cause: error,
  });
}

function statusFailure(statusCode: number, message: string): CompilationFailure {
  if (statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429) {
    return {
      retryable: true,
      category: statusCode === 429 ? "rate_limit" : "remote_service",
      message,
      statusCode,
    };
  }
  if (statusCode >= 500) {
    return { retryable: true, category: "remote_service", message, statusCode };
  }
  const category: CompilationFailureCategory = statusCode === 401 || statusCode === 403
    ? "authentication"
    : statusCode === 402
      ? "billing"
      : "configuration";
  return { retryable: false, category, message, statusCode };
}

function markedFailure(message: string): CompilationFailure | undefined {
  const line = message
    .split(/\r?\n/u)
    .reverse()
    .find((candidate) => candidate.startsWith(FAILURE_MARKER));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line.slice(FAILURE_MARKER.length)) as Partial<CompilationFailure>;
    if (typeof parsed.retryable !== "boolean" || typeof parsed.message !== "string") return undefined;
    if (![
      "authentication",
      "billing",
      "configuration",
      "model_output",
      "rate_limit",
      "remote_service",
      "transport",
      "internal",
    ].includes(parsed.category ?? "")) return undefined;
    return {
      retryable: parsed.retryable,
      category: parsed.category as CompilationFailureCategory,
      message: parsed.message,
      ...(typeof parsed.statusCode === "number" ? { statusCode: parsed.statusCode } : {}),
    };
  } catch {
    return undefined;
  }
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current) && chain.length < 8) {
    chain.push(current);
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return chain;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyCompilationFailure(error: unknown): CompilationFailure {
  const chain = errorChain(error);
  const combinedMessage = chain.map(messageOf).join("\n");
  const marked = markedFailure(combinedMessage);
  if (marked) return marked;

  for (const item of chain) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { status?: unknown; statusCode?: unknown; code?: unknown };
    const statusCode = typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : typeof candidate.status === "number"
        ? candidate.status
        : undefined;
    if (statusCode) return statusFailure(statusCode, messageOf(item));
    if (typeof candidate.code === "string" && RETRYABLE_NETWORK_CODES.has(candidate.code)) {
      return { retryable: true, category: "transport", message: messageOf(item) };
    }
  }

  const statusMatch = combinedMessage.match(
    /(?:\bHTTP(?:\s+status)?|\bstatus(?:Code)?|\bClient error)[\s=:']*(\d{3})\b/iu,
  );
  if (statusMatch) return statusFailure(Number(statusMatch[1]), messageOf(error));
  if (/\b(?:ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT)\b/u.test(combinedMessage)) {
    return { retryable: true, category: "transport", message: messageOf(error) };
  }
  if (/(?:Headers|Body|Connect) Timeout Error|(?:Headers|Body|Connect)TimeoutError/iu.test(combinedMessage)) {
    return { retryable: true, category: "transport", message: messageOf(error) };
  }
  if (/流式传输连续失败/u.test(combinedMessage)) {
    return { retryable: true, category: "transport", message: messageOf(error) };
  }
  return { retryable: false, category: "internal", message: messageOf(error) };
}

export function compilationFailureStatusMessage(failure: CompilationFailure): string {
  if (failure.statusCode === 402) return "模型账户余额不足，编译已停止；充值后可手动重试";
  if (failure.statusCode === 401 || failure.statusCode === 403) {
    return "模型接口认证失败，编译已停止；请检查 API 配置后手动重试";
  }
  if (failure.category === "model_output") {
    return "模型输出未通过结构或证据校验，将重新生成完整结果";
  }
  if (!failure.retryable) return "编译遇到不可自动恢复的错误，已停止；修正后可手动重试";
  return "临时故障，将从 checkpoint 自动续跑";
}
