import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createLibraryCompilationJobInputSchema,
  libraryCatalogCompilationOutputSchema,
  libraryCoarseCompilationOutputSchema,
  libraryCompilationAssessmentSchema,
  libraryVisualObservationOutputSchema,
} from "@/library/compilation-types";
import {
  buildLibraryEvidenceCatalog,
  coarseCompilationInstructions,
  materializeLibraryAssessment,
  ModelInFlightGate,
  parseEmbeddedModelJson,
  renderVisualObservation,
  sourceExcerptMatchesPreview,
} from "@/library/compilation-processor";
import {
  coldStartModelConcurrency,
  catalogCompilationConcurrency,
  coarseCompilationConcurrency,
  textModelConcurrency,
  visionModelConcurrency,
} from "@/library/compilation-concurrency";
import {
  artifactDirectoryFromProgress,
  checkpointOwnedByRun,
  deepParallelUnitEventFromProgress,
  webSourcePath,
} from "@/library/deep-compilation-worker";
import { parserKeyForMimeType } from "@/library/compilation-service";

describe("library compilation profiles", () => {
  it("uses eighteen coarse file workers by default", () => {
    const previous = process.env.LIBRARY_COARSE_CONCURRENCY;
    delete process.env.LIBRARY_COARSE_CONCURRENCY;
    try {
      expect(coarseCompilationConcurrency()).toBe(18);
      process.env.LIBRARY_COARSE_CONCURRENCY = "7";
      expect(coarseCompilationConcurrency()).toBe(7);
    } finally {
      if (previous === undefined) delete process.env.LIBRARY_COARSE_CONCURRENCY;
      else process.env.LIBRARY_COARSE_CONCURRENCY = previous;
    }
  });

  it("uses eighteen catalog file workers by default", () => {
    const previous = process.env.LIBRARY_CATALOG_CONCURRENCY;
    delete process.env.LIBRARY_CATALOG_CONCURRENCY;
    try {
      expect(catalogCompilationConcurrency()).toBe(18);
      process.env.LIBRARY_CATALOG_CONCURRENCY = "9";
      expect(catalogCompilationConcurrency()).toBe(9);
    } finally {
      if (previous === undefined) delete process.env.LIBRARY_CATALOG_CONCURRENCY;
      else process.env.LIBRARY_CATALOG_CONCURRENCY = previous;
    }
  });

  it("uses eighteen simultaneous model requests by default", () => {
    const previousText = process.env.AI_TEXT_MAX_IN_FLIGHT;
    const previousVision = process.env.AI_VISION_MAX_IN_FLIGHT;
    const previousColdStart = process.env.COLD_START_MODEL_MAX_IN_FLIGHT;
    delete process.env.AI_TEXT_MAX_IN_FLIGHT;
    delete process.env.AI_VISION_MAX_IN_FLIGHT;
    delete process.env.COLD_START_MODEL_MAX_IN_FLIGHT;
    try {
      expect(textModelConcurrency()).toBe(18);
      expect(visionModelConcurrency()).toBe(18);
      expect(coldStartModelConcurrency()).toBe(18);
    } finally {
      if (previousText === undefined) delete process.env.AI_TEXT_MAX_IN_FLIGHT;
      else process.env.AI_TEXT_MAX_IN_FLIGHT = previousText;
      if (previousVision === undefined) delete process.env.AI_VISION_MAX_IN_FLIGHT;
      else process.env.AI_VISION_MAX_IN_FLIGHT = previousVision;
      if (previousColdStart === undefined) delete process.env.COLD_START_MODEL_MAX_IN_FLIGHT;
      else process.env.COLD_START_MODEL_MAX_IN_FLIGHT = previousColdStart;
    }
  });

  it("allows eighteen in-flight model requests and queues the nineteenth", async () => {
    const gate = new ModelInFlightGate(18);
    const releases = await Promise.all(Array.from({ length: 18 }, () => gate.acquire()));
    let nineteenthStarted = false;
    let nineteenthRelease: (() => void) | undefined;
    const nineteenth = gate.acquire().then((release) => {
      nineteenthStarted = true;
      nineteenthRelease = release;
    });
    await Promise.resolve();
    expect(gate.activeCount).toBe(18);
    expect(nineteenthStarted).toBe(false);

    releases[0]();
    await nineteenth;
    expect(nineteenthStarted).toBe(true);
    expect(gate.activeCount).toBe(18);
    nineteenthRelease?.();
    for (const release of releases.slice(1)) release();
    expect(gate.activeCount).toBe(0);
  });

  it("extracts deep source and Global Object worker activity from progress", () => {
    expect(deepParallelUnitEventFromProgress(
      "[+  12.4s] [来源语义·region-0003] 第二遍：只检查遗漏命题",
    )).toEqual({
      completed: false,
      unit: {
        id: "region-0003",
        kind: "source",
        statusMessage: "第二遍：只检查遗漏命题",
      },
    });
    expect(deepParallelUnitEventFromProgress(
      "[+  18.0s] [全局对象·region-0001] 开始 1/8：3 个 Fragment",
    )?.unit.kind).toBe("global_object");
    expect(deepParallelUnitEventFromProgress(
      "[+  30.0s] [来源语义·region-0003] 完成：命题 4，Object Fragment 2",
    )?.completed).toBe(true);
  });

  it("keeps the coarse prompt generic and leaves quantity limits to the schema", () => {
    const prompt = coarseCompilationInstructions().join("\n");

    expect(prompt).toContain("文档自身的结构");
    expect(prompt).toContain("由文档内容决定提取多少");
    expect(prompt).toContain("不要重新判断处理档位");
    expect(prompt).not.toMatch(/2[–-]5|0[–-]4|报名|赛制|奖励|安全预案/u);
  });

  it("requires evidence ids and Object names for coarse compilation", () => {
    expect(() => libraryCoarseCompilationOutputSchema.parse({
      summary: "比赛通知",
      referenceCandidates: [],
      assertionCandidates: [],
    })).toThrow();

    expect(() => libraryCoarseCompilationOutputSchema.parse({
      summary: "比赛通知",
      referenceCandidates: [{
        statement: "该文件说明比赛安排",
        sourceId: "S0001",
        objectLabels: [],
      }],
      assertionCandidates: [],
    })).toThrow();
  });

  it("allows coarse compilation to omit grounded Assertions", () => {
    const output = libraryCoarseCompilationOutputSchema.parse({
      summary: "比赛通知",
      referenceCandidates: [{
        statement: "该文件说明比赛安排",
        sourceId: "S0001",
        objectLabels: ["比赛"],
      }],
      assertionCandidates: [],
    });

    expect(output.referenceCandidates).toHaveLength(1);
    expect(output.assertionCandidates).toEqual([]);
  });

  it("accepts source excerpts that only differ by Markdown and invisible spacing", () => {
    const preview = "## **一、主题**\n\n这里有\u200B一段原文。";

    expect(sourceExcerptMatchesPreview("一、主题\n这里有一段原文。", preview)).toBe(true);
    expect(sourceExcerptMatchesPreview("文档中并不存在的内容", preview)).toBe(false);
  });

  it("materializes exact source excerpts and the Object closure from model ids and names", () => {
    const evidence = buildLibraryEvidenceCatalog({
      previewText: "## 一、比赛安排\n\n时间：10月25日\n\n地点：西区乒乓球馆",
      previewSourceKind: "text_excerpt",
      fileName: "比赛通知.docx",
      originalRelativePath: "比赛/比赛通知.docx",
    });
    const output = libraryCoarseCompilationOutputSchema.parse({
      summary: "比赛时间与地点安排",
      referenceCandidates: [{
        statement: "文件说明比赛地点",
        sourceId: "S0003",
        objectLabels: ["西区乒乓球馆"],
      }],
      assertionCandidates: [{
        statement: "比赛时间为10月25日",
        sourceId: "S0002",
        objectLabels: ["比赛"],
        contextDependent: false,
      }],
    });

    const assessment = materializeLibraryAssessment({
      profile: "coarse",
      output,
      evidence,
      existingObjects: [{
        id: "01033118-c894-419a-90ca-db335193f5d1",
        canonicalName: "西区乒乓球馆",
      }],
    });

    expect(assessment.referenceCandidates[0]).toMatchObject({
      sourceExcerpt: "地点：西区乒乓球馆",
      sourceKind: "text_excerpt",
    });
    expect(assessment.assertionCandidates[0].sourceExcerpt).toBe("时间：10月25日");
    expect(assessment.objectCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "西区乒乓球馆", action: "bind_existing" }),
      expect.objectContaining({ label: "比赛", action: "new_candidate" }),
    ]));
  });

  it("rejects unknown evidence ids and file-context evidence for grounded Assertions", () => {
    const evidence = buildLibraryEvidenceCatalog({
      previewText: "时间：10月25日",
      previewSourceKind: "text_excerpt",
      fileName: "比赛通知.docx",
    });
    expect(() => materializeLibraryAssessment({
      profile: "coarse",
      output: libraryCoarseCompilationOutputSchema.parse({
        summary: "比赛通知",
        referenceCandidates: [{
          statement: "比赛时间",
          sourceId: "S9999",
          objectLabels: ["比赛"],
        }],
        assertionCandidates: [],
      }),
      evidence,
      existingObjects: [],
    })).toThrow("未提供的证据编号");
    expect(() => materializeLibraryAssessment({
      profile: "coarse",
      output: libraryCoarseCompilationOutputSchema.parse({
        summary: "比赛通知",
        referenceCandidates: [{
          statement: "比赛通知",
          sourceId: "F0001",
          objectLabels: ["比赛"],
        }],
        assertionCandidates: [{
          statement: "文件名表示比赛时间",
          sourceId: "F0001",
          objectLabels: ["比赛"],
          contextDependent: false,
        }],
      }),
      evidence,
      existingObjects: [],
    })).toThrow("grounded Assertion 不能使用文件路径证据");
  });

  it("does not impose semantic candidate counts in the structured output schema", () => {
    const references = Array.from({ length: 10 }, (_, index) => ({
      statement: `主题 ${index + 1}`,
      sourceExcerpt: `主题 ${index + 1} 的原文内容`,
      sourceKind: "text_excerpt" as const,
      objectLabels: ["文档主题"],
    }));
    const assertions = Array.from({ length: 10 }, (_, index) => ({
      statement: `文档主题的事实 ${index + 1}`,
      sourceExcerpt: `事实 ${index + 1} 的原文内容`,
      objectLabels: ["文档主题"],
      contextDependent: false,
    }));

    expect(() => libraryCompilationAssessmentSchema.parse({
      summary: "文档摘要",
      referenceCandidates: references,
      assertionCandidates: assertions,
      objectCandidates: [{
        label: "文档主题",
        action: "new_candidate",
        reason: "正文明确出现",
      }],
    })).not.toThrow();
  });

  it("records only artifact directories explicitly reported by the current cold-start process", () => {
    expect(artifactDirectoryFromProgress(
      "[产物] 已创建运行目录 /tmp/current-library-job/run-1",
      "已创建运行目录 ",
    )).toBe("/tmp/current-library-job/run-1");
    expect(artifactDirectoryFromProgress(
      "[进度] 正在处理历史目录",
      "已创建运行目录 ",
    )).toBeUndefined();
  });

  it("does not trust a deep checkpoint owned by another or legacy run", () => {
    expect(checkpointOwnedByRun("current-run", {
      explorationRun: "/old/local/artifact",
    })).toEqual({ ownerRunId: "current-run" });
    expect(checkpointOwnedByRun("current-run", {
      ownerRunId: "current-run",
      explorationRun: "/current/artifact",
    })).toEqual({
      ownerRunId: "current-run",
      explorationRun: "/current/artifact",
    });
  });

  it("keeps the MinerU input basename short while retaining the full SHA in its parent", () => {
    const previous = process.env.SYDARIS_COLD_START_OUTPUT_ROOT;
    process.env.SYDARIS_COLD_START_OUTPUT_ROOT = "/tmp/sydaris-cold-start-test";
    try {
      const sha256 = "a".repeat(64);
      const sourcePath = webSourcePath(sha256);
      expect(path.basename(sourcePath)).toBe("source.pdf");
      expect(path.basename(path.dirname(sourcePath))).toBe(sha256);
      expect(path.basename(path.dirname(path.dirname(sourcePath)))).toBe("web-sources");
    } finally {
      if (previous === undefined) delete process.env.SYDARIS_COLD_START_OUTPUT_ROOT;
      else process.env.SYDARIS_COLD_START_OUTPUT_ROOT = previous;
    }
  });

  it("represents a catalog file with no knowledge result using empty candidates", () => {
    const output = libraryCatalogCompilationOutputSchema.parse({
      summary: "文件已保存，未形成知识结果",
      referenceCandidates: [],
    });

    expect(output.referenceCandidates).toEqual([]);
  });

  it("accepts a catalog Reference without asking the model for Object candidates", () => {
    const output = libraryCatalogCompilationOutputSchema.parse({
      summary: "活动资料",
      referenceCandidates: [{
        statement: "该文件是积分赛资料",
        sourceId: "S0001",
        objectLabels: ["积分赛"],
      }],
    });
    expect(output.referenceCandidates[0].sourceId).toBe("S0001");
  });

  it("routes common formats to deterministic preview parsers", () => {
    expect(parserKeyForMimeType("application/pdf")).toBe("pdf");
    expect(parserKeyForMimeType("image/jpeg")).toBe("vision");
    expect(parserKeyForMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe("docx");
    expect(parserKeyForMimeType("application/octet-stream")).toBe("metadata-only");
  });

  it("requires an exact existing Object id for an automatic binding candidate", () => {
    expect(() => libraryCompilationAssessmentSchema.parse({
      summary: "一份比赛策划案",
      referenceCandidates: [],
      assertionCandidates: [],
      objectCandidates: [{
        label: "继往开来杯",
        action: "bind_existing",
        reason: "原文明确出现",
      }],
    })).toThrow("existingObjectId");
  });

  it("accepts source-anchored draft candidates without publishing semantics", () => {
    const output = libraryCompilationAssessmentSchema.parse({
      summary: "比赛策划材料",
      referenceCandidates: [{
        statement: "该来源包含报名时间安排",
        sourceExcerpt: "报名时间为 10 月 1 日至 10 月 7 日",
        sourceKind: "text_excerpt",
        objectLabels: ["继往开来杯"],
      }],
      assertionCandidates: [{
        statement: "继往开来杯的报名时间为 10 月 1 日至 10 月 7 日",
        sourceExcerpt: "报名时间为 10 月 1 日至 10 月 7 日",
        objectLabels: ["继往开来杯"],
        contextDependent: false,
      }],
      objectCandidates: [{
        label: "继往开来杯",
        action: "new_candidate",
        reason: "原文明确命名活动",
      }],
    });
    expect(output.assertionCandidates).toHaveLength(1);
    expect(output.objectCandidates[0].action).toBe("new_candidate");
  });

  it("accepts file context as navigation evidence", () => {
    const output = libraryCatalogCompilationOutputSchema.parse({
      summary: "会员大会合影",
      referenceCandidates: [{
        statement: "该图片归档在会员大会目录下",
        sourceId: "F0002",
        objectLabels: ["会员大会"],
      }],
    });
    expect(output.referenceCandidates[0].sourceId).toBe("F0002");
  });

  it("requires an explicit non-empty unique-content selection before starting", () => {
    expect(() => createLibraryCompilationJobInputSchema.parse({ selections: [] }))
      .toThrow();
    expect(createLibraryCompilationJobInputSchema.parse({
      selections: [{
        sourceBlobId: "123e4567-e89b-12d3-a456-426614174000",
        profile: "deep",
      }],
    }).selections).toHaveLength(1);
  });

  it("turns multimodal output into a source-anchored text handoff", () => {
    const observation = libraryVisualObservationOutputSchema.parse({
      summary: "一张室内乒乓球活动合影",
      visibleText: "中国科大乒协",
      observations: [{
        statement: "画面中多人在乒乓球台后方合影",
        evidenceRegion: "画面中央",
      }],
      uncertainties: ["无法仅凭画面确认人物姓名"],
    });
    const handoff = renderVisualObservation(observation, "vision-model-a");
    expect(handoff).toContain("[视觉模型：vision-model-a]");
    expect(handoff).toContain("中国科大乒协");
    expect(handoff).toContain("无法仅凭画面确认人物姓名");
  });

  it("recovers schema-valid JSON wrapped in model prose and markdown", () => {
    const raw = `模型结果如下：\n\`\`\`json\n${JSON.stringify({
      summary: "未形成知识结果",
      referenceCandidates: [],
    })}\n\`\`\``;
    expect(parseEmbeddedModelJson(raw, libraryCatalogCompilationOutputSchema))
      .toMatchObject({ summary: "未形成知识结果" });
  });
});
