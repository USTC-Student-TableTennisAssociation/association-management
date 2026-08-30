import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

import { getDatabase } from "@/db";
import { readStoredFile, resolveStorageKey } from "@/library/object-store";

const execFileAsync = promisify(execFile);
const MAX_PREVIEW_CHARS = 30_000;

export type LibraryPreview = {
  parser: string;
  text?: string;
  image?: Buffer;
  imageMediaType?: "image/jpeg";
  sourceKind: "text_excerpt" | "visual_observation";
  warning?: string;
};

async function createVisionPreview(storageKey: string): Promise<Buffer> {
  const source = await readStoredFile(storageKey);
  return sharp(source, { animated: false, failOn: "none" })
    .rotate()
    .resize({
      width: 1_600,
      height: 1_600,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

function normalizePreview(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_PREVIEW_CHARS);
}

async function commandText(command: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    });
    return normalizePreview(result.stdout);
  } catch {
    return undefined;
  }
}

function mineruDocumentSuffix(input: {
  mimeType: string;
  parserKey?: string | null;
}): "pdf" | "docx" | "pptx" | "xlsx" | undefined {
  if (input.mimeType === "application/pdf") return "pdf";
  if (input.parserKey === "docx") return "docx";
  if (input.parserKey === "pptx") return "pptx";
  if (input.parserKey === "xlsx") return "xlsx";
  return undefined;
}

function coldStartOutputRoot(): string {
  const configured = process.env.SYDARIS_COLD_START_OUTPUT_ROOT?.trim();
  if (configured) return path.normalize(/* turbopackIgnore: true */ configured);
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".cold-start");
}

function commandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  const detail = [candidate.stderr, candidate.message, candidate.stdout]
    .find((value) => typeof value === "string" && value.trim());
  return typeof detail === "string"
    ? detail.replace(/\s+/g, " ").trim().slice(-1_500)
    : "未知 MinerU 错误";
}

async function extractMinerUPreview(input: {
  storageKey: string;
  sha256: string;
  suffix: "pdf" | "docx" | "pptx" | "xlsx";
}): Promise<LibraryPreview> {
  const cacheDirectory = path.join(
    /* turbopackIgnore: true */ coldStartOutputRoot(),
    "library-parses",
    input.sha256,
  );
  try {
    await execFileAsync("uv", [
      "run",
      "--project",
      path.join(/* turbopackIgnore: true */ process.cwd(), "services/cold-start"),
      "cold-start",
      "parse-document",
      "--source",
      resolveStorageKey(input.storageKey),
      "--source-suffix",
      input.suffix,
      "--output",
      cacheDirectory,
    ], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const [text, rawMetadata] = await Promise.all([
      readFile(path.join(/* turbopackIgnore: true */ cacheDirectory, "parsed-document.md"), "utf8"),
      readFile(path.join(/* turbopackIgnore: true */ cacheDirectory, "parsing-metadata.json"), "utf8"),
    ]);
    const metadata = JSON.parse(rawMetadata) as { parser_name?: unknown };
    return {
      parser: typeof metadata.parser_name === "string" ? metadata.parser_name : "mineru",
      text: normalizePreview(text),
      sourceKind: "text_excerpt",
    };
  } catch (error) {
    return {
      parser: "mineru-unavailable",
      sourceKind: "text_excerpt",
      warning: `MinerU 解析失败：${commandErrorMessage(error)}`,
    };
  }
}

async function existingSourcePreview(sha256: string): Promise<string | undefined> {
  const blocks = await getDatabase().memorySourceBlock.findMany({
    where: { sourceDocument: { processingRun: { sourceBlob: { sha256 } } } },
    orderBy: { order: "asc" },
    take: 30,
    select: { markdown: true },
  });
  const text = normalizePreview(blocks.map((block) => block.markdown).join("\n\n"));
  return text || undefined;
}

export async function extractLibraryPreview(input: {
  storageKey: string;
  sha256: string;
  mimeType: string;
  parserKey?: string | null;
  parseDocumentsIfMissing?: boolean;
}): Promise<LibraryPreview> {
  const parser = input.parserKey ?? "metadata-only";
  if (input.mimeType.startsWith("image/")) {
    return {
      parser: "vision",
      image: await createVisionPreview(input.storageKey),
      imageMediaType: "image/jpeg",
      sourceKind: "visual_observation",
    };
  }
  if (
    input.mimeType.startsWith("text/") ||
    input.mimeType === "application/json" ||
    input.mimeType === "text/csv"
  ) {
    const buffer = await readStoredFile(input.storageKey);
    return {
      parser: "text",
      text: normalizePreview(buffer.toString("utf8")),
      sourceKind: "text_excerpt",
    };
  }
  const mineruSuffix = mineruDocumentSuffix(input);
  if (mineruSuffix) {
    const existing = await existingSourcePreview(input.sha256);
    if (existing) return { parser: "existing-source-blocks", text: existing, sourceKind: "text_excerpt" };
    if (input.parseDocumentsIfMissing === false) {
      return {
        parser: "preview-not-parsed",
        sourceKind: "text_excerpt",
        warning: "数据库中尚无可复用原文；本次未获授权启动 MinerU。",
      };
    }
    return extractMinerUPreview({
      storageKey: input.storageKey,
      sha256: input.sha256,
      suffix: mineruSuffix,
    });
  }
  const storedPath = resolveStorageKey(input.storageKey);
  if (parser === "archive-manifest") {
    const manifest = await commandText("unzip", ["-Z1", storedPath]);
    return manifest
      ? { parser, text: manifest, sourceKind: "text_excerpt" }
      : { parser, sourceKind: "text_excerpt", warning: "压缩包目录读取失败" };
  }
  return {
    parser,
    sourceKind: "text_excerpt",
    warning: `当前未支持 ${input.mimeType} 的内容预览`,
  };
}
