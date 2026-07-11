import type {
  GuidanceGraph,
  GuidanceGraphNode,
  GuidanceKind,
  GuidanceRelationType,
  GuidanceStatus,
} from "./guidance-types";

export type ThreeStateFilter = "all" | "yes" | "no";
export type MandatoryFilter = "all" | "mandatory" | "optional";

export type GuidanceFilterState = {
  query: string;
  kinds: readonly GuidanceKind[];
  statuses: readonly GuidanceStatus[];
  mandatory: MandatoryFilter;
  isolated: ThreeStateFilter;
  hasIncoming: ThreeStateFilter;
  hasOutgoing: ThreeStateFilter;
  relationTypes: readonly GuidanceRelationType[];
  onlyShowMatches: boolean;
};

export const defaultGuidanceFilters: GuidanceFilterState = {
  query: "",
  kinds: [],
  statuses: [],
  mandatory: "all",
  isolated: "all",
  hasIncoming: "all",
  hasOutgoing: "all",
  relationTypes: [],
  onlyShowMatches: false,
};

function matchesThreeState(value: boolean, filter: ThreeStateFilter): boolean {
  return filter === "all" || (filter === "yes" ? value : !value);
}

function matchesMandatory(value: boolean, filter: MandatoryFilter): boolean {
  return filter === "all" || (filter === "mandatory" ? value : !value);
}

function matchesSearch(node: GuidanceGraphNode, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalizedQuery) {
    return true;
  }

  return [node.title, node.kind, node.status, node.contentMarkdown, node.basisNote ?? ""]
    .join(" ")
    .toLocaleLowerCase("zh-CN")
    .includes(normalizedQuery);
}

export function matchesGuidanceFilters(
  graph: GuidanceGraph,
  node: GuidanceGraphNode,
  filters: GuidanceFilterState,
): boolean {
  if (!matchesSearch(node, filters.query)) {
    return false;
  }
  if (filters.kinds.length > 0 && !filters.kinds.includes(node.kind)) {
    return false;
  }
  if (filters.statuses.length > 0 && !filters.statuses.includes(node.status)) {
    return false;
  }
  if (!matchesMandatory(node.isMandatory, filters.mandatory)) {
    return false;
  }

  const isIsolated = node.incomingEdgeIds.length + node.outgoingEdgeIds.length === 0;
  if (!matchesThreeState(isIsolated, filters.isolated)) {
    return false;
  }
  if (!matchesThreeState(node.incomingEdgeIds.length > 0, filters.hasIncoming)) {
    return false;
  }
  if (!matchesThreeState(node.outgoingEdgeIds.length > 0, filters.hasOutgoing)) {
    return false;
  }

  if (filters.relationTypes.length > 0) {
    const incidentRelationTypes = [...node.incomingEdgeIds, ...node.outgoingEdgeIds]
      .map((edgeId) => graph.edgeById.get(edgeId)?.relationType)
      .filter((relationType): relationType is GuidanceRelationType => relationType !== undefined);

    if (!filters.relationTypes.some((relationType) => incidentRelationTypes.includes(relationType))) {
      return false;
    }
  }

  return true;
}

export function getFilteredGuidanceNodes(
  graph: GuidanceGraph,
  filters: GuidanceFilterState,
): GuidanceGraphNode[] {
  return graph.nodes.filter((node) => matchesGuidanceFilters(graph, node, filters));
}
