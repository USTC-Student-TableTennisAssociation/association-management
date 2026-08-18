import { describe, expect, it } from "vitest";

import {
  activityOperationsCardTypes,
  businessViewDefinition,
  cardTypePromptContract,
  cardTypeDefinition,
  societyInformationCardTypes,
} from "@/semantic-view/card-types";
import {
  assertActivityOperationsDimensionValue,
  assertGroundedAssertionSupports,
  assertSemanticCardStructure,
  assertSameBusinessView,
  assertSlotTarget,
  SemanticViewValidationError,
  type StructuralCardState,
} from "@/semantic-view/service";
import { viewChangePayloadSchema } from "@/semantic-view/types";

const societyObjectId = "c28d1424-133c-5724-bad9-7cf80d899dd2";
const assertionId = "73f322cd-3062-42de-a96e-4f8a0e52dbb8";

describe("society_information change protocol", () => {
  it("accepts the three walking-skeleton SET operations", () => {
    const payload = viewChangePayloadSchema.parse({
      viewKey: "society_information",
      reason: "把已有事实形成可确认的社团信息。",
      changes: [
        {
          type: "CREATE_CARD",
          cardRef: "society",
          sourceObjectId: societyObjectId,
          cardTypeKey: "SocietyCard",
        },
        {
          type: "SET_CONTENT_DIMENSION",
          card: "new:society",
          name: "社团星级",
          contentMarkdown: "三星级社团",
          supportingAssertionIds: [assertionId],
        },
        {
          type: "SET_SLOT",
          card: "new:society",
          slotKey: "advisor",
          targets: [],
          supportingAssertionIds: [],
        },
      ],
    });

    expect(payload.changes.map((change) => change.type)).toEqual([
      "CREATE_CARD",
      "SET_CONTENT_DIMENSION",
      "SET_SLOT",
    ]);
  });

  it("accepts a user-confirmed ContentDimension change without Assertion support", () => {
    const payload = viewChangePayloadSchema.parse({
      viewKey: "society_information",
      reason: "用户明确要求修改正式业务状态",
      changes: [{
        type: "SET_CONTENT_DIMENSION",
        card: societyObjectId,
        name: "社团星级",
        contentMarkdown: "五星",
      }],
    });

    expect(payload.changes[0]).toMatchObject({
      type: "SET_CONTENT_DIMENSION",
      supportingAssertionIds: [],
    });
  });

  it("defines the formal Society Information card graph", () => {
    expect(businessViewDefinition("society_information")).toMatchObject({
      label: "社团信息",
      specializedLabel: "社团概览",
    });
    expect(Object.keys(societyInformationCardTypes)).toEqual([
      "SocietyCard",
      "PersonCard",
      "PositionCard",
      "ActivityCard",
      "PlatformCard",
    ]);
    expect(societyInformationCardTypes.SocietyCard.seedContentDimensions).toEqual([
      "社团星级",
      "成立时间",
      "宗旨",
      "简介",
    ]);
    expect(societyInformationCardTypes.SocietyCard.slots).toMatchObject({
      advisor: { allowedTargetCardTypes: ["PersonCard"], cardinality: "many" },
      positions: { allowedTargetCardTypes: ["PositionCard"], cardinality: "many" },
      activities: { allowedTargetCardTypes: ["ActivityCard"], cardinality: "many" },
      platforms: { allowedTargetCardTypes: ["PlatformCard"], cardinality: "many" },
    });
    expect(societyInformationCardTypes.PositionCard.slots.holders).toMatchObject({
      allowedTargetCardTypes: ["PersonCard"],
      cardinality: "many",
    });
  });

  it("resolves Card Types inside a Business View rather than globally", () => {
    expect(cardTypeDefinition("society_information", "ActivityCard")?.viewKey)
      .toBe("society_information");
    expect(cardTypeDefinition("unknown_view", "ActivityCard")).toBeUndefined();
  });

  it("deterministically rejects cross-View SlotBinding", () => {
    expect(() => assertSameBusinessView(
      { selector: "source", viewKey: "society_information" },
      { selector: "target", viewKey: "activity_operations" },
    )).toThrow(SemanticViewValidationError);
  });

  it("rejects Reference Assertions as formal Business View support", () => {
    expect(() => assertGroundedAssertionSupports([
      { id: assertionId, kind: "reference" },
    ])).toThrow(/Reference Assertion 只能用于定位原文/);

    expect(() => assertGroundedAssertionSupports([
      { id: assertionId, kind: "grounded" },
    ])).not.toThrow();
  });
});

describe("activity_operations minimal skeleton", () => {
  const cardTypeKeys = [
    "DimensionDefinitionCard",
    "WorkPackageDefinitionCard",
    "TaskDefinitionCard",
    "AdaptationPatternCard",
    "ActivityPlaybookCard",
    "GuideNodeCard",
    "ActivityCard",
    "WorkPackageCard",
    "TaskCard",
    "MilestoneCard",
    "AssignmentCard",
    "BudgetCard",
    "PurchaseCard",
    "ExpenseCard",
    "ReimbursementCard",
    "ArtifactCard",
    "ApprovalCard",
    "RegistrationCard",
    "ParticipationCard",
    "ResultCard",
    "OperationalEventCard",
    "PlanRevisionCard",
    "ReviewCard",
    "ExperienceCard",
  ];

  it("registers the working-draft View and all 24 Card Types", () => {
    expect(businessViewDefinition("activity_operations")).toMatchObject({
      key: "activity_operations",
      label: "Activity Operations",
    });
    expect(Object.keys(activityOperationsCardTypes)).toEqual(cardTypeKeys);
    expect(Object.values(activityOperationsCardTypes).every(
      (type) => type.viewKey === "activity_operations",
    )).toBe(true);
  });

  it("keeps Runtime and suggestive-guide dimensions structurally separate", () => {
    expect(activityOperationsCardTypes.ActivityCard.seedContentDimensions).toEqual([
      "名称",
      "简介",
      "状态",
      "进度",
      "活动时间",
      "活动形式",
      "活动规模",
      "参与人数",
    ]);
    expect(activityOperationsCardTypes.WorkPackageCard.seedContentDimensions).toEqual([
      "名称",
      "简介",
      "状态",
      "进度",
      "截止时间",
    ]);
    expect(activityOperationsCardTypes.TaskCard.seedContentDimensions).toEqual([
      "名称",
      "状态",
    ]);
    expect(activityOperationsCardTypes.ActivityCard.seedContentDimensions)
      .not.toContain("expectedParticipants");
    expect(activityOperationsCardTypes.ActivityPlaybookCard.seedContentDimensions).toEqual([
      "名称",
      "简介",
      "适用场景",
      "整体说明",
      "注意事项",
      "泳道顺序",
    ]);
    expect(activityOperationsCardTypes.GuideNodeCard.seedContentDimensions).toEqual([
      "名称",
      "节点类型",
      "泳道",
      "纵向位置",
      "操作指南",
      "适用条件",
      "所需信息",
      "预期结果",
      "AI 协助说明",
      "资源与入口",
    ]);
    expect(activityOperationsCardTypes.GuideNodeCard.seedContentDimensions).not.toEqual(
      expect.arrayContaining(["状态", "当前步骤", "是否完成", "锁定"]),
    );
  });

  it("defines only the Slots used by Activity Portfolio", () => {
    expect(Object.keys(activityOperationsCardTypes.ActivityCard.slots)).toEqual([
      "work_packages",
      "assignments",
    ]);
    expect(activityOperationsCardTypes.ActivityCard.slots).toMatchObject({
      work_packages: {
        allowedTargetCardTypes: ["WorkPackageCard"],
        cardinality: "many",
      },
      assignments: {
        allowedTargetCardTypes: ["AssignmentCard"],
        cardinality: "many",
      },
    });
    expect(Object.keys(activityOperationsCardTypes.WorkPackageCard.slots)).toEqual([
      "definition",
      "assignments",
      "tasks",
    ]);
    expect(activityOperationsCardTypes.WorkPackageCard.slots).toMatchObject({
      definition: { allowedTargetCardTypes: ["WorkPackageDefinitionCard"] },
      assignments: { allowedTargetCardTypes: ["AssignmentCard"] },
      tasks: { allowedTargetCardTypes: ["TaskCard"] },
    });
    expect(activityOperationsCardTypes.TaskCard.slots).toEqual({});
    expect(activityOperationsCardTypes.ActivityPlaybookCard.slots).toMatchObject({
      nodes: {
        allowedTargetCardTypes: ["GuideNodeCard"],
        cardinality: "many",
        minimumTargetCount: 1,
      },
      start_nodes: {
        allowedTargetCardTypes: ["GuideNodeCard"],
        cardinality: "many",
        minimumTargetCount: 1,
        subsetOfSlotKey: "nodes",
      },
    });
    expect(activityOperationsCardTypes.GuideNodeCard.slots).toMatchObject({
      next: { allowedTargetCardTypes: ["GuideNodeCard"], cardinality: "many" },
      when_yes: { allowedTargetCardTypes: ["GuideNodeCard"], cardinality: "one" },
      when_no: { allowedTargetCardTypes: ["GuideNodeCard"], cardinality: "one" },
    });
    expect(activityOperationsCardTypes.AssignmentCard.slots.assignee).toMatchObject({
      allowedTargetCardTypes: ["PersonCard"],
      allowedTargetViewKey: "society_information",
      cardinality: "one",
    });
  });

  it("publishes structural constraints in the generic Card/Slot contract", () => {
    const contract = cardTypePromptContract("activity_operations");
    expect(contract).toContain("nodes（指南节点，many，target=GuideNodeCard，min=1");
    expect(contract).toContain("subsetOf=nodes");
    expect(contract).toContain("sameContainer=ActivityPlaybookCard.nodes");
    expect(contract).toContain("当 节点类型=DECISION 时必填 Slots：when_yes、when_no");
  });

  it("allows only the explicit Assignment.assignee cross-View target", () => {
    expect(() => assertSlotTarget({
      sourceCard: {
        selector: "assignment",
        viewKey: "activity_operations",
        cardTypeKey: "AssignmentCard",
      },
      targetCard: {
        selector: "person",
        viewKey: "society_information",
        cardTypeKey: "PersonCard",
      },
      slot: activityOperationsCardTypes.AssignmentCard.slots.assignee,
    })).not.toThrow();

    expect(() => assertSlotTarget({
      sourceCard: {
        selector: "assignment",
        viewKey: "activity_operations",
        cardTypeKey: "AssignmentCard",
      },
      targetCard: {
        selector: "activity",
        viewKey: "society_information",
        cardTypeKey: "ActivityCard",
      },
      slot: activityOperationsCardTypes.AssignmentCard.slots.assignee,
    })).toThrow(SemanticViewValidationError);
  });

  it("uses view-scoped Card Type identity", () => {
    expect(cardTypeDefinition("activity_operations", "ActivityCard")?.viewKey)
      .toBe("activity_operations");
    expect(cardTypeDefinition("society_information", "ActivityCard")?.viewKey)
      .toBe("society_information");
  });

  it("accepts an Activity Operations proposal without a parallel protocol", () => {
    const payload = viewChangePayloadSchema.parse({
      viewKey: "activity_operations",
      reason: "建立活动运营 Runtime Card。",
      changes: [{
        type: "CREATE_CARD",
        cardRef: "activity",
        name: "2026 秋季赛",
        cardTypeKey: "ActivityCard",
      }],
    });

    expect(payload.viewKey).toBe("activity_operations");
  });

  it("allows a complete graph proposal to contain more than twenty generic changes", () => {
    const changes = Array.from({ length: 21 }, (_, index) => ({
      type: "CREATE_CARD" as const,
      cardRef: `task_${index}`,
      name: `任务 ${index}`,
      cardTypeKey: "TaskCard",
    }));

    expect(viewChangePayloadSchema.parse({
      viewKey: "activity_operations",
      reason: "一次提交完整的 Card/Slot 子图。",
      changes,
    }).changes).toHaveLength(21);
  });

  it("keeps AI status and participant-count values inside the Portfolio contract", () => {
    const activity = {
      selector: "activity",
      viewKey: "activity_operations" as const,
      objectName: "活动",
      cardTypeKey: "ActivityCard",
    };
    expect(() => assertActivityOperationsDimensionValue(
      activity,
      "状态",
      "PLANNING",
    )).not.toThrow();
    expect(() => assertActivityOperationsDimensionValue(
      activity,
      "状态",
      "DOING",
    )).toThrow(/Activity 状态不支持/);
    expect(() => assertActivityOperationsDimensionValue(
      activity,
      "参与人数",
      "大约 100 人",
    )).toThrow(/非负整数/);

    const guideNode = {
      ...activity,
      cardTypeKey: "GuideNodeCard",
      objectName: "是否需要场地？",
    };
    expect(() => assertActivityOperationsDimensionValue(
      guideNode,
      "节点类型",
      "DECISION",
    )).not.toThrow();
    expect(() => assertActivityOperationsDimensionValue(
      guideNode,
      "节点类型",
      "CURRENT",
    )).toThrow(/节点类型不支持/);
    expect(() => assertActivityOperationsDimensionValue(
      guideNode,
      "纵向位置",
      "1.5",
    )).toThrow(/0 到 100 的整数/);
  });
});

function structuralCard(input: Partial<StructuralCardState> & Pick<
  StructuralCardState,
  "selector" | "cardTypeKey" | "objectName"
>): StructuralCardState {
  return {
    viewKey: "activity_operations",
    contentDimensions: {},
    slots: {},
    ...input,
  };
}

function minimalPlaybookGraph(): StructuralCardState[] {
  return [
    structuralCard({
      selector: "playbook",
      cardTypeKey: "ActivityPlaybookCard",
      objectName: "场地申请",
      contentDimensions: { 名称: "场地申请", 泳道顺序: "申请人\n审批人" },
      slots: { nodes: ["prepare", "done"], start_nodes: ["prepare"] },
    }),
    structuralCard({
      selector: "prepare",
      cardTypeKey: "GuideNodeCard",
      objectName: "准备材料",
      contentDimensions: {
        名称: "准备材料",
        节点类型: "ACTION",
        泳道: "申请人",
        纵向位置: "0",
      },
      slots: { next: ["done"] },
    }),
    structuralCard({
      selector: "done",
      cardTypeKey: "GuideNodeCard",
      objectName: "完成",
      contentDimensions: {
        名称: "完成",
        节点类型: "END",
        泳道: "审批人",
        纵向位置: "1",
      },
      slots: {},
    }),
  ];
}

describe("declarative Card/Slot structure constraints", () => {
  it("accepts a complete, reachable playbook subgraph", () => {
    const cards = minimalPlaybookGraph();
    expect(() => assertSemanticCardStructure(
      cards,
      new Set(cards.map((card) => card.selector)),
    )).not.toThrow();
  });

  it("rejects an empty playbook shell", () => {
    const playbook = structuralCard({
      selector: "playbook",
      cardTypeKey: "ActivityPlaybookCard",
      objectName: "空地图",
      contentDimensions: { 名称: "空地图", 泳道顺序: "申请人" },
    });
    expect(() => assertSemanticCardStructure(
      [playbook],
      new Set([playbook.selector]),
    )).toThrow(/指南节点.*至少需要 1 个目标 Card/);
  });

  it("commits contained nodes together with their playbook", () => {
    const cards = minimalPlaybookGraph();
    delete cards[1].contentDimensions.节点类型;
    expect(() => assertSemanticCardStructure(
      cards,
      new Set(["playbook"]),
    )).toThrow(/准备材料.*必须设置 ContentDimension「节点类型」/);
  });

  it("requires start nodes to belong to nodes and reach the whole map", () => {
    const cards = minimalPlaybookGraph();
    cards[0].slots.start_nodes = ["done"];
    expect(() => assertSemanticCardStructure(
      cards,
      new Set(["playbook"]),
    )).toThrow(/无法从 start_nodes 到达/);

    cards[0].slots.start_nodes = ["outside"];
    expect(() => assertSemanticCardStructure(
      cards,
      new Set(["playbook"]),
    )).toThrow(/start_nodes 必须是 nodes 的子集/);
  });

  it("keeps paths and lane values inside their playbook container", () => {
    const cards = minimalPlaybookGraph();
    cards.push(
      structuralCard({
        selector: "other_playbook",
        cardTypeKey: "ActivityPlaybookCard",
        objectName: "另一张地图",
        contentDimensions: { 名称: "另一张地图", 泳道顺序: "其他人" },
        slots: { nodes: ["other_node"], start_nodes: ["other_node"] },
      }),
      structuralCard({
        selector: "other_node",
        cardTypeKey: "GuideNodeCard",
        objectName: "其他节点",
        contentDimensions: {
          名称: "其他节点",
          节点类型: "END",
          泳道: "其他人",
          纵向位置: "0",
        },
        slots: {},
      }),
    );
    cards[1].slots.next = ["other_node"];
    expect(() => assertSemanticCardStructure(
      cards,
      new Set(["prepare"]),
    )).toThrow(/只能连接同一 ActivityPlaybookCard 中的节点/);

    cards[1].slots.next = ["done"];
    cards[1].contentDimensions.泳道 = "不存在的泳道";
    expect(() => assertSemanticCardStructure(
      cards,
      new Set(["prepare"]),
    )).toThrow(/必须来自所属容器的「泳道顺序」/);
  });

  it("requires both branches for a decision node", () => {
    const cards = minimalPlaybookGraph();
    cards[1].contentDimensions.节点类型 = "DECISION";
    cards[1].slots = { when_yes: ["done"] };
    expect(() => assertSemanticCardStructure(
      cards,
      new Set(["prepare"]),
    )).toThrow(/必须设置 Slots：when_no/);
  });

  it("rejects a flow sentence masquerading as a lane list", () => {
    const cards = minimalPlaybookGraph();
    cards[0].contentDimensions.泳道顺序 = "申请人 → 管理方 → 审批人";
    expect(() => assertSemanticCardStructure(
      cards,
      new Set(["playbook"]),
    )).toThrow(/不能用“→”串接流程步骤/);
  });
});
