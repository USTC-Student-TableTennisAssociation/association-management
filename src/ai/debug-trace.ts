import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TRACE_ROOT = ".sydaris-debug/chat-runs";
const SECRET_ENV_KEYS = [
  "AI_API_KEY",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "SHADOW_DATABASE_URL",
] as const;

export type DebugTrace = {
  readonly enabled: boolean;
  readonly filePath?: string;
  appendSection(title: string, markdown: string): Promise<void>;
  appendJsonSection(title: string, value: unknown): Promise<void>;
  appendError(title: string, error: unknown): Promise<void>;
  flush(): Promise<void>;
};

export type DebugTraceStart = {
  clientMessageId: string;
  submittedAt: Date;
  timezone: string;
  actorId: string;
  actorDisplayName: string;
  userMessage: string;
  pageContext?: unknown;
};

function falseLike(value: string): boolean {
  return ["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

export function debugTraceEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const configured = environment.SYDARIS_DEBUG_TRACE;
  if (configured !== undefined && configured.trim()) return !falseLike(configured);
  return environment.NODE_ENV !== "test";
}

function safeSegment(value: string, fallback: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  return sanitized || fallback;
}

function localTimestamp(instant: Date, timezone: string): {
  date: string;
  filenameTime: string;
  readable: string;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = new Map(parts.map((part) => [part.type, part.value]));
  const date = `${value.get("year")}-${value.get("month")}-${value.get("day")}`;
  const time = `${value.get("hour")}-${value.get("minute")}-${value.get("second")}`;
  return {
    date,
    filenameTime: `${date}T${time}`,
    readable: `${date} ${time.replaceAll("-", ":")}`,
  };
}

function secretValues(environment: NodeJS.ProcessEnv = process.env): string[] {
  return SECRET_ENV_KEYS.flatMap((key) => {
    const value = environment[key]?.trim();
    return value ? [value] : [];
  }).sort((left, right) => right.length - left.length);
}

export function redactDebugSecrets(value: string): string {
  let redacted = value;
  for (const secret of secretValues()) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:postgres(?:ql)?):\/\/[^\s"'`]+/gi, "postgresql://[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "sk-[REDACTED]");
}

function jsonReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

export function debugJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, jsonReplacer(), 2);
    return redactDebugSecrets(json === undefined ? "undefined" : json);
  } catch (error) {
    return redactDebugSecrets(`[无法序列化：${error instanceof Error ? error.message : String(error)}]`);
  }
}

export function debugCodeBlock(value: string, language = ""): string {
  const runs = value.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}${language}\n${redactDebugSecrets(value)}\n${fence}`;
}

function renderContentPart(part: unknown, index: number): string {
  if (typeof part !== "object" || part === null) {
    return `#### 内容 ${index + 1}\n\n${debugCodeBlock(String(part))}`;
  }
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";
  if (type === "text" && typeof record.text === "string") {
    return `#### 文本 ${index + 1}\n\n${debugCodeBlock(record.text)}`;
  }
  if (type === "reasoning" && typeof record.text === "string") {
    return `#### 模型 reasoning ${index + 1}\n\n${debugCodeBlock(record.text)}`;
  }
  if (type === "tool-call") {
    return [
      `#### 工具调用：${String(record.toolName ?? "unknown")}`,
      "",
      `- toolCallId：\`${String(record.toolCallId ?? "unknown")}\``,
      "- 参数：",
      "",
      debugCodeBlock(debugJson(record.input), "json"),
    ].join("\n");
  }
  if (type === "tool-result") {
    return [
      `#### 工具结果：${String(record.toolName ?? "unknown")}`,
      "",
      debugCodeBlock(debugJson(record.output), "json"),
    ].join("\n");
  }
  if (type === "tool-error") {
    return [
      `#### 工具错误：${String(record.toolName ?? "unknown")}`,
      "",
      debugCodeBlock(debugJson(record.error), "json"),
    ].join("\n");
  }
  return `#### ${type} ${index + 1}\n\n${debugCodeBlock(debugJson(record), "json")}`;
}

export function renderDebugMessages(messages: readonly unknown[]): string {
  if (!messages.length) return "（没有消息）";
  return messages.map((message, index) => {
    if (typeof message !== "object" || message === null) {
      return `### 消息 ${index + 1}\n\n${debugCodeBlock(String(message))}`;
    }
    const record = message as Record<string, unknown>;
    const role = String(record.role ?? "unknown").toUpperCase();
    const content = record.content;
    const rendered = typeof content === "string"
      ? debugCodeBlock(content)
      : Array.isArray(content)
        ? content.map(renderContentPart).join("\n\n")
        : debugCodeBlock(debugJson(content), "json");
    return `### 消息 ${index + 1} · ${role}\n\n${rendered}`;
  }).join("\n\n");
}

export function renderDebugModelOutput(content: readonly unknown[]): string {
  return content.length
    ? content.map(renderContentPart).join("\n\n")
    : "（模型没有返回内容）";
}

export function renderDebugTools(tools: readonly unknown[] | undefined): string {
  if (!tools?.length) return "（本次模型调用没有可用工具）";
  return tools.map((tool, index) => {
    if (typeof tool !== "object" || tool === null) {
      return `### 工具 ${index + 1}\n\n${debugCodeBlock(debugJson(tool), "json")}`;
    }
    const record = tool as Record<string, unknown>;
    const nested = typeof record.function === "object" && record.function !== null
      ? record.function as Record<string, unknown>
      : undefined;
    const name = String(record.name ?? nested?.name ?? `工具 ${index + 1}`);
    const description = record.description ?? nested?.description;
    const schema = record.inputSchema ?? record.parameters ?? nested?.parameters;
    return [
      `### ${name}`,
      "",
      typeof description === "string" ? description : "（没有工具说明）",
      "",
      "输入结构：",
      "",
      debugCodeBlock(debugJson(schema), "json"),
    ].join("\n");
  }).join("\n\n");
}

function renderError(error: unknown): string {
  if (error instanceof Error) {
    return [
      `- 类型：\`${error.name}\``,
      `- 消息：${redactDebugSecrets(error.message)}`,
      ...(error.stack ? ["", "调用栈：", "", debugCodeBlock(error.stack)] : []),
    ].join("\n");
  }
  return debugCodeBlock(debugJson(error), "json");
}

class FileDebugTrace implements DebugTrace {
  readonly enabled = true;
  readonly filePath: string;
  private queue: Promise<void>;

  constructor(filePath: string, initialMarkdown: string) {
    this.filePath = filePath;
    this.queue = mkdir(path.dirname(filePath), { recursive: true })
      .then(() => writeFile(filePath, redactDebugSecrets(initialMarkdown), "utf8"))
      .catch((error) => {
        console.error("[chat.debug-trace.write]", error);
      });
  }

  private enqueue(markdown: string): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        await appendFile(this.filePath, redactDebugSecrets(markdown), "utf8");
      })
      .catch((error) => {
        console.error("[chat.debug-trace.write]", error);
      });
    return this.queue;
  }

  appendSection(title: string, markdown: string): Promise<void> {
    return this.enqueue(`\n\n## ${title}\n\n${markdown.trim()}\n`);
  }

  appendJsonSection(title: string, value: unknown): Promise<void> {
    return this.appendSection(title, debugCodeBlock(debugJson(value), "json"));
  }

  appendError(title: string, error: unknown): Promise<void> {
    return this.appendSection(title, renderError(error));
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

const NOOP_TRACE: DebugTrace = {
  enabled: false,
  async appendSection() {},
  async appendJsonSection() {},
  async appendError() {},
  async flush() {},
};

export function createDebugTrace(
  input: DebugTraceStart,
  environment: NodeJS.ProcessEnv = process.env,
): DebugTrace {
  if (!debugTraceEnabled(environment)) return NOOP_TRACE;
  const local = localTimestamp(input.submittedAt, input.timezone);
  const traceRoot = environment.SYDARIS_DEBUG_TRACE_DIR?.trim() || DEFAULT_TRACE_ROOT;
  const root = path.isAbsolute(traceRoot)
    ? traceRoot
    : path.join(/* turbopackIgnore: true */ process.cwd(), traceRoot);
  const filename = `${local.filenameTime}_${safeSegment(input.clientMessageId, "message")}.md`;
  const filePath = path.join(root, local.date, filename);
  const initial = [
    "# Sydaris Chat 调试报告",
    "",
    `- 用户消息 ID：\`${input.clientMessageId}\``,
    `- 提交人：${input.actorDisplayName}（\`${input.actorId}\`）`,
    `- 服务端时刻：\`${input.submittedAt.toISOString()}\``,
    `- 组织本地时间：\`${local.readable}\``,
    `- 环境时区：\`${input.timezone}\``,
    `- 页面上下文：${input.pageContext === undefined ? "未提供" : "见下方 JSON"}`,
    ...(input.pageContext === undefined
      ? []
      : ["", debugCodeBlock(debugJson(input.pageContext), "json")]),
    "",
    "## 用户原始消息",
    "",
    debugCodeBlock(input.userMessage),
    "",
    "> 本报告记录 Sydaris 实际发送和收到的模型内容，以及后台处理结果。API Key、数据库连接串和认证 Header 不会写入。",
  ].join("\n");
  const trace = new FileDebugTrace(filePath, initial);
  console.info("[chat.debug-trace]", filePath);
  return trace;
}
