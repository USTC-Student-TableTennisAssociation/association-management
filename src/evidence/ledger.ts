import type {
  EvidenceAnswerability,
  EvidenceObservation,
  EvidenceSemantics,
} from "@/evidence/types";

function copyObservation(item: EvidenceObservation): EvidenceObservation {
  return { ...item, refs: [...item.refs] };
}
function copyAnswerability(item: EvidenceAnswerability): EvidenceAnswerability {
  return { ...item, refs: [...item.refs] };
}

/** Request-local, passive record of evidence already returned by tools. */
export class EvidenceLedger {
  private readonly observations = new Map<string, EvidenceObservation>();
  private readonly answerability = new Map<string, EvidenceAnswerability>();

  record(semantics: EvidenceSemantics | undefined): void {
    if (!semantics) return;
    for (const item of semantics.observations) {
      this.observations.set(item.id, copyObservation(item));
    }
    for (const item of semantics.answerability) {
      this.answerability.set(item.id, copyAnswerability(item));
    }
  }

  snapshot(): EvidenceSemantics {
    return {
      observations: [...this.observations.values()].map(copyObservation),
      answerability: [...this.answerability.values()].map(copyAnswerability),
    };
  }
}
