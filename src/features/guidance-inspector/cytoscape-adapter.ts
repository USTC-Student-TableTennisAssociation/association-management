import type { ElementDefinition } from "cytoscape";

import type { GuidanceGraph, GuidanceKind, GuidanceRelationType } from "./guidance-types";
import {
  guidanceKindLabels,
  guidanceRelationLabels,
  guidanceStatusLabels,
} from "./guidance-types";

type KindVisual = {
  symbol: string;
};

const kindVisuals: Record<GuidanceKind, KindVisual> = {
  workflow: { symbol: "◆" },
  rule: { symbol: "!" },
  checklist: { symbol: "☑" },
  experience: { symbol: "✦" },
};

export const relationClassNames: Record<GuidanceRelationType, string> = {
  contains: "relation-contains",
  triggers: "relation-triggers",
  requires: "relation-requires",
  next: "relation-next",
  exception: "relation-exception",
};

function shortenTitle(title: string): string {
  return title.length > 18 ? `${title.slice(0, 18)}…` : title;
}

export function toCytoscapeElements(graph: GuidanceGraph): ElementDefinition[] {
  const nodeElements: ElementDefinition[] = graph.nodes.map((node) => {
    const visual = kindVisuals[node.kind];
    const statusLabel = guidanceStatusLabels[node.status];
    const mandatoryLabel = node.isMandatory ? "强制" : "建议";

    return {
      group: "nodes",
      data: {
        id: node.id,
        label: `${visual.symbol} ${shortenTitle(node.title)}\n${guidanceKindLabels[node.kind]} · ${statusLabel} · ${mandatoryLabel}\n${node.directNeighborIds.length} 个直接关联`,
        title: node.title,
      },
      classes: `kind-${node.kind} status-${node.status}${node.isMandatory ? " is-mandatory" : ""}`,
    };
  });

  const edgeElements: ElementDefinition[] = graph.renderableEdges.map((edge) => ({
    group: "edges",
    data: {
      id: edge.id,
      source: edge.fromGuidelineId,
      target: edge.toGuidelineId,
      label: guidanceRelationLabels[edge.relationType],
      note: edge.note ?? "未填写关系说明",
    },
    classes: relationClassNames[edge.relationType],
  }));

  return [...nodeElements, ...edgeElements];
}
