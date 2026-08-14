import { z } from "zod";

import {
  GUIDE_NODE_TYPES,
  type GuideNodeType,
} from "@/semantic-view/activity-operations-contract";
import type { SemanticViewCard, SemanticViewState } from "@/semantic-view/types";

const optionalText = z.string().trim().max(10_000).optional();

export const activityPlaybookEditorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: optionalText,
  applicableScenario: optionalText,
  overview: optionalText,
  notes: optionalText,
  lanes: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
});

export const guideNodeEditorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  nodeType: z.enum(GUIDE_NODE_TYPES),
  lane: z.string().trim().min(1).max(100),
  row: z.number().int().min(0).max(100),
  guide: optionalText,
  applicableCondition: optionalText,
  requiredInformation: optionalText,
  expectedOutcome: optionalText,
  aiAssistance: optionalText,
  resources: optionalText,
});

export const guideNodePathsSchema = z.object({
  nextCardIds: z.array(z.string().uuid()).max(20),
  whenYesCardId: z.string().uuid().nullable(),
  whenNoCardId: z.string().uuid().nullable(),
});

export const ACTIVITY_PLAYBOOK_STARTER_NAMES = [
  "社团活动筹备操作手册",
  "采购与报销操作指南",
  "校内场地申请操作指南",
] as const;

export const activityPlaybookActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("CREATE_SAMPLE_PLAYBOOK") }),
  z.object({ type: z.literal("INSTALL_STARTER_PLAYBOOKS") }),
  z.object({
    type: z.literal("CREATE_PLAYBOOK"),
    values: activityPlaybookEditorSchema,
  }),
  z.object({
    type: z.literal("UPDATE_PLAYBOOK"),
    cardId: z.string().uuid(),
    values: activityPlaybookEditorSchema,
  }),
  z.object({
    type: z.literal("CREATE_GUIDE_NODE"),
    playbookCardId: z.string().uuid(),
    values: guideNodeEditorSchema,
  }),
  z.object({
    type: z.literal("UPDATE_GUIDE_NODE"),
    playbookCardId: z.string().uuid(),
    cardId: z.string().uuid(),
    values: guideNodeEditorSchema,
    paths: guideNodePathsSchema,
  }),
]);

export type ActivityPlaybookEditorValues = z.infer<typeof activityPlaybookEditorSchema>;
export type GuideNodeEditorValues = z.infer<typeof guideNodeEditorSchema>;
export type GuideNodePaths = z.infer<typeof guideNodePathsSchema>;
export type ActivityPlaybookAction = z.infer<typeof activityPlaybookActionSchema>;

export type ActivityPlaybookEdge = {
  sourceCardId: string;
  targetCardId: string;
  kind: "next" | "when_yes" | "when_no";
  label: string;
};

export type ActivityGuideNode = GuideNodeEditorValues & {
  cardId: string;
  paths: GuideNodePaths;
};

export type ActivityPlaybook = ActivityPlaybookEditorValues & {
  cardId: string;
  startNodeCardIds: string[];
  nodes: ActivityGuideNode[];
  edges: ActivityPlaybookEdge[];
};

export type ActivityPlaybookCollection = {
  playbooks: ActivityPlaybook[];
};

function dimension(card: SemanticViewCard, name: string): string {
  return card.contentDimensions.find((item) => item.name === name)
    ?.contentMarkdown.trim() ?? "";
}

function targets(card: SemanticViewCard, slotKey: string) {
  return card.slots.find((slot) => slot.key === slotKey)?.targets ?? [];
}

function nodeType(value: string): GuideNodeType {
  return GUIDE_NODE_TYPES.includes(value as GuideNodeType)
    ? value as GuideNodeType
    : "ACTION";
}

export function buildActivityPlaybooks(
  view: SemanticViewState,
): ActivityPlaybookCollection {
  const cardsById = new Map(view.cards.map((card) => [card.id, card]));
  const playbooks = view.cards
    .filter((card) => card.cardTypeKey === "ActivityPlaybookCard")
    .map((playbook): ActivityPlaybook => {
      const nodes = targets(playbook, "nodes")
        .map((target) => cardsById.get(target.cardId))
        .filter((card): card is SemanticViewCard =>
          Boolean(card?.cardTypeKey === "GuideNodeCard")
        )
        .map((node): ActivityGuideNode => ({
          cardId: node.id,
          name: dimension(node, "名称") || node.objectName,
          nodeType: nodeType(dimension(node, "节点类型")),
          lane: dimension(node, "泳道") || "未分组",
          row: Math.max(0, Number.parseInt(dimension(node, "纵向位置"), 10) || 0),
          guide: dimension(node, "操作指南"),
          applicableCondition: dimension(node, "适用条件"),
          requiredInformation: dimension(node, "所需信息"),
          expectedOutcome: dimension(node, "预期结果"),
          aiAssistance: dimension(node, "AI 协助说明"),
          resources: dimension(node, "资源与入口"),
          paths: {
            nextCardIds: targets(node, "next").map((target) => target.cardId),
            whenYesCardId: targets(node, "when_yes")[0]?.cardId ?? null,
            whenNoCardId: targets(node, "when_no")[0]?.cardId ?? null,
          },
        }))
        .sort((left, right) => left.row - right.row ||
          left.lane.localeCompare(right.lane, "zh-CN"));
      const edges = nodes.flatMap((node): ActivityPlaybookEdge[] => [
        ...node.paths.nextCardIds.map((targetCardId) => ({
          sourceCardId: node.cardId,
          targetCardId,
          kind: "next" as const,
          label: "",
        })),
        ...(node.paths.whenYesCardId ? [{
          sourceCardId: node.cardId,
          targetCardId: node.paths.whenYesCardId,
          kind: "when_yes" as const,
          label: "是",
        }] : []),
        ...(node.paths.whenNoCardId ? [{
          sourceCardId: node.cardId,
          targetCardId: node.paths.whenNoCardId,
          kind: "when_no" as const,
          label: "否",
        }] : []),
      ]);
      return {
        cardId: playbook.id,
        name: dimension(playbook, "名称") || playbook.objectName,
        description: dimension(playbook, "简介"),
        applicableScenario: dimension(playbook, "适用场景"),
        overview: dimension(playbook, "整体说明"),
        notes: dimension(playbook, "注意事项"),
        lanes: dimension(playbook, "泳道顺序").split("\n")
          .map((lane) => lane.trim()).filter(Boolean),
        startNodeCardIds: targets(playbook, "start_nodes")
          .map((target) => target.cardId),
        nodes,
        edges,
      };
    });
  return { playbooks };
}
