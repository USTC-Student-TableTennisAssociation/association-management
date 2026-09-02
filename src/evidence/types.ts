export type EvidenceLayer =
  | "business_view"
  | "library"
  | "shared_brain"
  | "source_document";

export type EvidenceObservation = {
  /** Stable identity supplied by the producing protocol. Ledger entries are append-only. */
  id: string;
  layer: EvidenceLayer;
  scope: string;
  subject: string;
  predicate: string;
  status: "present" | "absent" | "unknown";
  completeness: "complete" | "partial" | "unknown";
  authority: "authoritative" | "supporting" | "navigation";
  refs: string[];
  summary: string;
};
export type EvidenceAnswerability = {
  id: string;
  layer: EvidenceLayer;
  question: string;
  status:
    | "answerable"
    | "partially_answerable"
    | "not_answerable"
    | "not_applicable";
  reason: string;
  refs: string[];
};

/**
 * Describes what a completed tool call actually established. It never tells
 * the model which tool to call next and is therefore evidence, not a plan.
 */
export type EvidenceSemantics = {
  observations: EvidenceObservation[];
  answerability: EvidenceAnswerability[];
};
