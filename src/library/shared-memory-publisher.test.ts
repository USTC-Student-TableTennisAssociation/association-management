import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GlobalObjectDraft } from "@/library/global-object-resolver";
import {
  prepareDeepPublication,
  prepareSemanticPublication,
} from "@/library/shared-memory-publisher";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const LATER_RUN_ID = "11111111-1111-4111-8111-111111111112";
const BLOB_ID = "22222222-2222-4222-8222-222222222222";
const LATER_BLOB_ID = "22222222-2222-4222-8222-222222222223";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const OLD_OBJECT_ID = "44444444-4444-4444-8444-444444444444";
const SHA = "a".repeat(64);
const LATER_SHA = "b".repeat(64);

function resolvedObject(key: string, label = "继往开来杯"): GlobalObjectDraft {
  return {
    draftObjectId: DRAFT_ID,
    canonicalLabel: label,
    labels: [label],
    members: [{
      key,
      runId: RUN_ID,
      sourceName: "比赛通知.docx",
      label,
      reason: "活动实体",
    }],
  };
}

describe("library Shared Brain publication preparation", () => {
  const temporaryRoots: string[] = [];
  const originalOutputRoot = process.env.ECHO_COLD_START_OUTPUT_ROOT;

  afterEach(async () => {
    if (originalOutputRoot === undefined) delete process.env.ECHO_COLD_START_OUTPUT_ROOT;
    else process.env.ECHO_COLD_START_OUTPUT_ROOT = originalOutputRoot;
    await Promise.all(temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  it("preserves a resolved Object identity when later material adds new cognition", () => {
    const sharedObject: GlobalObjectDraft = {
      draftObjectId: DRAFT_ID,
      canonicalLabel: "继往开来杯",
      labels: ["继往开来杯"],
      members: [
        {
          key: `${RUN_ID}:assessment:0`,
          runId: RUN_ID,
          sourceName: "首份通知.docx",
          label: "继往开来杯",
          reason: "活动实体",
        },
        {
          key: `${LATER_RUN_ID}:assessment:0`,
          runId: LATER_RUN_ID,
          sourceName: "补充通知.docx",
          label: "继往开来杯",
          reason: "同一活动的新材料",
        },
      ],
    };
    const publication = (
      runId: string,
      blobId: string,
      sha256: string,
      title: string,
      statement: string,
      excerpt: string,
    ) => prepareSemanticPublication({
      id: runId,
      sourceBlobId: blobId,
      profile: "coarse",
      parserKey: "mineru-raw",
      artifactLocation: null,
      completedAt: new Date("2026-08-16T00:00:00Z"),
      sourceBlob: { sha256 },
      libraryNode: { name: title, originalRelativePath: title },
      assessment: {
        referenceCandidates: [],
        assertionCandidates: [{
          statement,
          sourceExcerpt: excerpt,
          objectLabels: ["继往开来杯"],
          contextDependent: false,
        }],
        objectCandidates: [{
          label: "继往开来杯",
          action: "new_candidate",
          reason: "文档明确命名活动",
        }],
      },
    }, [sharedObject]);

    const initial = publication(
      RUN_ID,
      BLOB_ID,
      SHA,
      "首份通知.docx",
      "继往开来杯计划于十月举办。",
      "活动计划于十月举办。",
    );
    const later = publication(
      LATER_RUN_ID,
      LATER_BLOB_ID,
      LATER_SHA,
      "补充通知.docx",
      "继往开来杯已提交场地申请。",
      "活动已提交场地申请。",
    );

    expect(initial.objects).toEqual([{ id: DRAFT_ID, canonicalName: "继往开来杯" }]);
    expect(later.objects).toEqual([{ id: DRAFT_ID, canonicalName: "继往开来杯" }]);
    expect(initial.assertions).toHaveLength(1);
    expect(later.assertions).toHaveLength(1);
    expect(later.assertions[0].id).not.toBe(initial.assertions[0].id);
    expect(initial.objectLinks).toEqual([
      { assertionId: initial.assertions[0].id, globalObjectId: DRAFT_ID },
    ]);
    expect(later.objectLinks).toEqual([
      { assertionId: later.assertions[0].id, globalObjectId: DRAFT_ID },
    ]);
    expect(later.regions[0]).toMatchObject({
      sourceTitle: "补充通知.docx",
      sourceSha256: LATER_SHA,
    });
  });

  it("publishes coarse Reference before a small number of grounded facts", () => {
    const publication = prepareSemanticPublication({
      id: RUN_ID,
      sourceBlobId: BLOB_ID,
      profile: "coarse",
      parserKey: "mineru-raw",
      artifactLocation: null,
      completedAt: new Date("2026-08-16T00:00:00Z"),
      sourceBlob: { sha256: SHA },
      libraryNode: {
        name: "比赛通知.docx",
        originalRelativePath: "25-26/比赛通知.docx",
      },
      assessment: {
        referenceCandidates: [{
          statement: "该原文块涵盖比赛与报名安排。",
          sourceExcerpt: "比赛时间为10月25日，报名截止时间为10月24日中午。",
          sourceKind: "text_excerpt",
          objectLabels: ["继往开来杯"],
        }],
        assertionCandidates: [{
          statement: "继往开来杯的报名截止时间为10月24日中午。",
          sourceExcerpt: "报名截止时间为10月24日中午。",
          objectLabels: ["继往开来杯"],
          contextDependent: false,
        }],
        objectCandidates: [{
          label: "继往开来杯",
          action: "new_candidate",
          reason: "文档明确命名活动",
        }],
      },
    }, [resolvedObject(`${RUN_ID}:assessment:0`)]);

    expect(publication.assertions.map((item) => item.kind))
      .toEqual(["reference", "grounded"]);
    expect(publication.objectCoverage).toEqual([
      { assertionId: publication.assertions[0].id, globalObjectId: DRAFT_ID },
    ]);
    expect(publication.objectLinks).toEqual([
      { assertionId: publication.assertions[1].id, globalObjectId: DRAFT_ID },
    ]);
    expect(publication.regions[0]).toMatchObject({
      sourceTitle: "比赛通知.docx",
      sourceSha256: SHA,
      sourceParser: "mineru-raw",
    });
  });

  it("merges a deep package into plain Shared Brain assertions and shared objects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "echo-shared-publisher-"));
    temporaryRoots.push(root);
    process.env.ECHO_COLD_START_OUTPUT_ROOT = root;
    const compilationDirectory = path.join(root, "run", "source-semantic-compilations", "comp");
    const resolutionDirectory = path.join(compilationDirectory, "global-resolutions", "resolution");
    await mkdir(resolutionDirectory, { recursive: true });
    await writeFile(path.join(compilationDirectory, "source-semantics-full.json"), JSON.stringify({
      schema_version: "source-semantics-full.v9",
      created_at: "2026-08-16T00:00:00Z",
      source: {
        path: "手册.pdf",
        title: "手册",
        sha256: SHA,
        parser: "mineru-raw",
        page_count: 1,
        block_count: 1,
      },
      region_tree_schema_version: "region-tree.v1",
      sources: [{
        schema_version: "source-semantics.v9",
        created_at: "2026-08-16T00:00:00Z",
        region_node_id: "region-1",
        label: "比赛安排",
        lineage_node_ids: ["region-1"],
        source_pages: [1],
        source_block_ids: ["block-1"],
        covered_block_ids: ["block-1"],
        unclaimed_block_ids: [],
        initial_claim_count: 1,
        review_addition_count: 0,
        assertions: [{
          claim_id: "claim-1",
          kind: "grounded",
          statement_template_markdown: "{{fragment:fragment-1}}在10月25日举行。",
          supporting_block_ids: ["block-1"],
          context_dependent: false,
        }],
        object_fragments: [{
          fragment_id: "fragment-1",
          surface_forms: ["继往开来杯"],
        }],
        model_calls: 1,
      }],
    }), "utf8");
    await writeFile(path.join(compilationDirectory, "parsed-blocks.json"), JSON.stringify([{
      block_id: "block-1",
      order: 0,
      block_type: "text",
      source_pages: [1],
      heading_level: null,
      heading_path: ["比赛安排"],
      source_type: "text",
      source_sub_type: null,
      bbox: null,
      asset_path: null,
      markdown: "继往开来杯在10月25日举行。",
    }]), "utf8");
    await writeFile(path.join(resolutionDirectory, "global-resolution.json"), JSON.stringify({
      source_sha256: SHA,
      global_objects: [{
        global_object_id: OLD_OBJECT_ID,
        canonical_name: "继往开来杯",
        surface_atom_ids: ["surface:region-1:fragment-1:0"],
      }],
    }), "utf8");
    await writeFile(path.join(resolutionDirectory, "global-assertions.json"), JSON.stringify({
      source_sha256: SHA,
      assertions: [{
        assertion_id: "assertion:region-1:claim-1",
        kind: "grounded",
        global_statement_template_markdown: `{{object:${OLD_OBJECT_ID}}}在10月25日举行。`,
        reference_atoms: [{ global_object_id: OLD_OBJECT_ID }],
        linked_global_object_ids: [],
      }],
    }), "utf8");

    const publication = await prepareDeepPublication({
      id: RUN_ID,
      sourceBlobId: BLOB_ID,
      profile: "deep",
      parserKey: "pdf",
      artifactLocation: `cold-start-global-resolution:${resolutionDirectory}`,
      completedAt: new Date("2026-08-16T00:00:00Z"),
      sourceBlob: { sha256: SHA },
      libraryNode: { name: "手册.pdf", originalRelativePath: "手册.pdf" },
      assessment: null,
    }, [resolvedObject(`${RUN_ID}:deep:0`)]);

    expect(publication.regions).toHaveLength(1);
    expect(publication.blocks).toHaveLength(1);
    expect(publication.fragments).toHaveLength(1);
    expect(publication.assertions[0].globalStatementTemplateMarkdown)
      .toBe("继往开来杯在10月25日举行。");
    expect(publication.objectLinks).toEqual([{
      assertionId: publication.assertions[0].id,
      globalObjectId: DRAFT_ID,
    }]);
    expect(publication.objectCoverage).toEqual([]);
    expect(publication.surfaceMemberships[0].globalObjectId).toBe(DRAFT_ID);
  });
});
