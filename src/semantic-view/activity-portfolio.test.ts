import { describe, expect, it } from "vitest";

import {
  activityPortfolioActionSchema,
  buildActivityPortfolio,
} from "@/semantic-view/activity-portfolio";
import type { SemanticViewCard, SemanticViewState } from "@/semantic-view/types";

const activityId = "11111111-1111-4111-8111-111111111111";
const secondActivityId = "22222222-2222-4222-8222-222222222222";
const workPackageId = "33333333-3333-4333-8333-333333333333";
const secondWorkPackageId = "44444444-4444-4444-8444-444444444444";
const assignmentId = "55555555-5555-4555-8555-555555555555";
const personId = "66666666-6666-4666-8666-666666666666";
const taskId = "77777777-7777-4777-8777-777777777777";

function card(input: Partial<SemanticViewCard> & Pick<SemanticViewCard, "id" | "cardTypeKey">): SemanticViewCard {
  return {
    id: input.id,
    viewKey: input.viewKey ?? "activity_operations",
    cardTypeKey: input.cardTypeKey,
    cardTypeLabel: input.cardTypeKey,
    objectName: input.objectName ?? input.cardTypeKey,
    seedContentDimensions: input.seedContentDimensions ?? [],
    contentDimensions: input.contentDimensions ?? [],
    slots: input.slots ?? [],
  };
}

function dimension(name: string, contentMarkdown: string) {
  return { id: `${name}-${contentMarkdown}`, name, contentMarkdown };
}

function state(viewKey: SemanticViewState["viewKey"], cards: SemanticViewCard[]): SemanticViewState {
  return {
    viewKey,
    viewLabel: viewKey,
    viewDescription: viewKey,
    compilationId: null,
    compatible: true,
    cardTypes: [],
    cards,
  };
}

describe("Activity Portfolio projection", () => {
  it("projects multiple Activities, owner Slots, natural-language progress, and derived counts", () => {
    const activityView = state("activity_operations", [
      card({
        id: activityId,
        cardTypeKey: "ActivityCard",
        contentDimensions: [
          dimension("名称", "2026 秋继往开来单打赛"),
          dimension("状态", "PLANNING"),
          dimension("活动时间", "10/24"),
          dimension("进度", "场地正在确认，二课申请已经提交。"),
          dimension("参与人数", "116"),
        ],
        slots: [
          {
            key: "work_packages",
            label: "工作包",
            meaning: "",
            cardinality: "many",
            targets: [
              { cardId: workPackageId, viewKey: "activity_operations", cardTypeKey: "WorkPackageCard", objectName: "场地申请" },
              { cardId: secondWorkPackageId, viewKey: "activity_operations", cardTypeKey: "WorkPackageCard", objectName: "宣传" },
            ],
          },
          {
            key: "assignments",
            label: "负责人",
            meaning: "",
            cardinality: "many",
            targets: [{ cardId: assignmentId, viewKey: "activity_operations", cardTypeKey: "AssignmentCard", objectName: "工作分配" }],
          },
        ],
      }),
      card({
        id: secondActivityId,
        cardTypeKey: "ActivityCard",
        contentDimensions: [
          dimension("名称", "四国大战团体赛"),
          dimension("状态", "RUNNING"),
          dimension("进度", "已完成基本方案，准备启动报名。"),
        ],
      }),
      card({
        id: workPackageId,
        cardTypeKey: "WorkPackageCard",
        contentDimensions: [
          dimension("名称", "场地申请"),
          dimension("状态", "COMPLETED"),
          dimension("进度", "申请已完成审批。"),
        ],
        slots: [{
          key: "tasks",
          label: "任务",
          meaning: "",
          cardinality: "many",
          targets: [{ cardId: taskId, viewKey: "activity_operations", cardTypeKey: "TaskCard", objectName: "提交申请" }],
        }],
      }),
      card({
        id: secondWorkPackageId,
        cardTypeKey: "WorkPackageCard",
        contentDimensions: [dimension("名称", "宣传"), dimension("状态", "IN_PROGRESS")],
      }),
      card({
        id: assignmentId,
        cardTypeKey: "AssignmentCard",
        slots: [{
          key: "assignee",
          label: "负责人",
          meaning: "",
          cardinality: "one",
          targets: [{ cardId: personId, viewKey: "society_information", cardTypeKey: "PersonCard", objectName: "雷岳鑫" }],
        }],
      }),
      card({
        id: taskId,
        cardTypeKey: "TaskCard",
        contentDimensions: [dimension("状态", "COMPLETED")],
      }),
    ]);
    const societyView = state("society_information", [card({
      id: personId,
      viewKey: "society_information",
      cardTypeKey: "PersonCard",
      objectName: "雷岳鑫",
    })]);

    const result = buildActivityPortfolio(activityView, societyView);

    expect(result.activities).toHaveLength(2);
    expect(result.activities[0]).toMatchObject({
      name: "2026 秋继往开来单打赛",
      time: "10/24",
      status: "PLANNING",
      progress: "场地正在确认，二课申请已经提交。",
      participantCount: 116,
      owner: { cardId: personId, name: "雷岳鑫" },
      completedWorkPackageCount: 1,
    });
    expect(result.activities[0].workPackages).toHaveLength(2);
    expect(result.activities[0].workPackages[0]).toMatchObject({
      name: "场地申请",
      status: "COMPLETED",
      progress: "申请已完成审批。",
      taskCount: 1,
      completedTaskCount: 1,
    });
    expect(result.people).toEqual([{ cardId: personId, name: "雷岳鑫" }]);
  });

  it("accepts atomic owner changes with create/update actions", () => {
    expect(activityPortfolioActionSchema.parse({
      type: "CREATE_ACTIVITY",
      values: { name: "新活动", status: "PLANNING", participantCount: null },
      ownerPersonCardId: personId,
    })).toMatchObject({ ownerPersonCardId: personId });
    expect(activityPortfolioActionSchema.parse({
      type: "CREATE_WORK_PACKAGE",
      activityCardId: activityId,
      values: { name: "报名", status: "NOT_STARTED" },
      ownerPersonCardId: null,
    })).toMatchObject({ ownerPersonCardId: null });
  });
});
