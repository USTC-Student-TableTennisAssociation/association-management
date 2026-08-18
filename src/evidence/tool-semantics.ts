import type { EvidenceCoverage } from "@/memory/types";
import type { EvidenceLayer, EvidenceSemantics } from "@/evidence/types";

function completeness(coverage: EvidenceCoverage | undefined):
  "complete" | "partial" | "unknown" {
  if (coverage?.observationComplete === true) return "complete";
  if (coverage?.level === "partial" || coverage?.observationComplete === false) {
    return "partial";
  }
  return "unknown";
}

export function retrievalEvidenceSemantics(input: {
  id: string;
  layer: EvidenceLayer;
  scope: string;
  subject: string;
  question: string;
  coverage?: EvidenceCoverage;
  refs?: string[];
  authority: "authoritative" | "supporting" | "navigation";
  presentSummary: string;
  absentSummary: string;
  unknownSummary: string;
}): EvidenceSemantics {
  const refs = [...(input.refs ?? [])];
  const status = input.coverage?.contentPresence ?? "unknown";
  const observationCompleteness = completeness(input.coverage);
  const answerabilityStatus = input.coverage?.level === "complete"
    ? "answerable" as const
    : input.coverage?.level === "partial"
      ? "partially_answerable" as const
      : "not_answerable" as const;
  const summary = status === "present"
    ? input.presentSummary
    : status === "absent"
      ? input.absentSummary
      : input.unknownSummary;
  return {
    observations: [{
      id: `${input.id}.observation`,
      layer: input.layer,
      scope: input.scope,
      subject: input.subject,
      predicate: "returned_relevant_evidence",
      status,
      completeness: observationCompleteness,
      authority: input.authority,
      refs,
      summary,
    }],
    answerability: [{
      id: `${input.id}.answerability`,
      layer: input.layer,
      question: input.question,
      status: answerabilityStatus,
      reason: input.coverage?.missingAspects.length
        ? `${summary} 尚未覆盖：${input.coverage.missingAspects.join("；")}`
        : summary,
      refs,
    }],
  };
}

export function artifactSearchEvidenceSemantics(input: {
  queryTitle: string;
  matchedCount: number;
  truncated: boolean;
  ref?: string;
  items: Array<{ ref?: string }>;
}): EvidenceSemantics {
  const refs = [
    ...(input.ref ? [input.ref] : []),
    ...input.items.flatMap((item) => item.ref ? [item.ref] : []),
  ];
  const found = input.matchedCount > 0;
  const complete = !input.truncated;
  const status = found ? "present" as const : complete ? "absent" as const : "unknown" as const;
  const summary = found
    ? `Library 标题索引匹配到 ${input.matchedCount} 个与“${input.queryTitle}”相关的文件。`
    : complete
      ? `完整 Library 标题查询没有匹配到“${input.queryTitle}”。`
      : `当前返回页没有匹配到“${input.queryTitle}”，但查询尚未完整。`;
  return {
    observations: [{
      id: `library.title_search.${input.queryTitle}`,
      layer: "library",
      scope: `title:${input.queryTitle}`,
      subject: input.queryTitle,
      predicate: "matching_artifact_in_library_index",
      status,
      completeness: complete ? "complete" : "partial",
      authority: "authoritative",
      refs,
      summary,
    }],
    answerability: [
      {
        id: `library.title_search.${input.queryTitle}.existence`,
        layer: "library",
        question: `Library 标题索引是否存在匹配“${input.queryTitle}”的文件`,
        status: found || complete ? "answerable" : "not_answerable",
        reason: summary,
        refs,
      },
      {
        id: `library.title_search.${input.queryTitle}.content`,
        layer: "library",
        question: `匹配文件的正文具体说明了什么`,
        status: "not_answerable",
        reason: "标题查询只证明文件索引和元数据，不能证明文件正文。",
        refs,
      },
    ],
  };
}
