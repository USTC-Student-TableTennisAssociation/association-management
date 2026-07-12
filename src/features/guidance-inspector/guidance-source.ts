import "server-only";

import {
  handbookGuidelineLinks,
  handbookGuidelines,
} from "../../../prisma/handbook-guidance.data";
import type { GuidanceGraphSource } from "./guidance-types";

/**
 * 观察器唯一接触当前种子数据的位置。
 * 未来改为数据库或 API 数据时，只需替换此函数的实现。
 */
export function getGuidanceInspectorSource(): GuidanceGraphSource {
  return {
    nodes: handbookGuidelines.map((guideline) => ({
      id: guideline.id,
      title: guideline.title,
      kind: guideline.kind,
      status: guideline.status,
      isMandatory: guideline.isMandatory,
      contentMarkdown: guideline.contentMarkdown,
      appliesWhen: guideline.appliesWhen,
      suggestedActions: guideline.suggestedActions.map((action) => ({ ...action })),
      basisNote: guideline.basisNote,
    })),
    links: handbookGuidelineLinks.map((link) => ({
      fromGuidelineId: link.fromGuidelineId,
      toGuidelineId: link.toGuidelineId,
      relationType: link.relationType,
      note: link.note,
    })),
  };
}
