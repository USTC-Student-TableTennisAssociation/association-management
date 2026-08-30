import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDebugTrace,
  debugTraceEnabled,
  redactDebugSecrets,
} from "@/ai/debug-trace";

describe("Sydaris Markdown debug trace", () => {
  it("is enabled by default outside tests and can be explicitly disabled", () => {
    expect(debugTraceEnabled({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
    expect(debugTraceEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
    expect(debugTraceEnabled({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
    expect(debugTraceEnabled({
      NODE_ENV: "development",
      SYDARIS_DEBUG_TRACE: "false",
    } as NodeJS.ProcessEnv)).toBe(false);
    expect(debugTraceEnabled({
      NODE_ENV: "test",
      SYDARIS_DEBUG_TRACE: "true",
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("writes one readable Markdown file and redacts secrets", async () => {
    const root = path.join(os.tmpdir(), `sydaris-debug-trace-${crypto.randomUUID()}`);
    const environment = {
      NODE_ENV: "test",
      SYDARIS_DEBUG_TRACE: "true",
      SYDARIS_DEBUG_TRACE_DIR: root,
      AI_API_KEY: "sk-secret-example-value",
      DATABASE_URL: "postgresql://user:password@localhost/database",
    } as NodeJS.ProcessEnv;
    const trace = createDebugTrace({
      clientMessageId: "user/message 1",
      submittedAt: new Date("2026-08-14T02:03:04.000Z"),
      timezone: "Asia/Shanghai",
      actorId: "00000000-0000-4000-8000-000000000001",
      actorDisplayName: "开发用户",
      userMessage: "动漫协会九月准备迎新。",
      pageContext: { activePresentation: "full_chat" },
    }, environment);

    await trace.appendSection(
      "模型输出",
      "Authorization: Bearer sk-secret-example-value\npostgresql://user:password@localhost/database",
    );
    await trace.flush();

    expect(trace.filePath).toMatch(/2026-08-14T10-03-04_user-message-1\.md$/);
    const markdown = await readFile(trace.filePath!, "utf8");
    expect(markdown).toContain("# Sydaris Chat 调试报告");
    expect(markdown).toContain("动漫协会九月准备迎新");
    expect(markdown).toContain("## 模型输出");
    expect(markdown).toContain("[REDACTED]");
    expect(markdown).not.toContain("sk-secret-example-value");
    expect(markdown).not.toContain("user:password");
  });

  it("redacts bearer tokens and Postgres URLs without configured env values", () => {
    const redacted = redactDebugSecrets(
      "Bearer abcdefghijklmnopqrstuvwxyz postgresql://user:pass@db.example/sydaris",
    );
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("postgresql://[REDACTED]");
  });
});
