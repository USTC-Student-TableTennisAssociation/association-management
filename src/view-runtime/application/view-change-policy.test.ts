import { describe, expect, it } from "vitest";

import type { DomainEventDefinition, ViewChange, ViewModule } from "@/contracts";
import { zodContractSchema } from "@/contracts";
import { z } from "zod";
import {
  resolveViewChangeReaction,
  resolveViewPostCommitReaction,
} from "@/view-runtime/application/view-change-policy";

const viewModule: ViewModule = {
  manifest: {
    key: "test",
    label: "Test",
    schemaVersion: "1",
    description: "Test",
    defaultSettings: { aiWritePolicy: "approval_required" },
  },
  schema: {
    viewKey: "test",
    schemaVersion: "1",
    cardTypes: [{
      key: "SocietyCard",
      label: "Society",
      description: "Society",
      changePolicy: { attention: "evaluate", knowledge: "reconcile" },
      dimensions: [{
        key: "description",
        label: "Description",
        type: "rich_text",
        changePolicy: {
          attention: "never",
          knowledge: "none",
          guidance: "Ignore presentation-only edits.",
        },
      }],
      slots: [],
    }],
  },
  queries: [],
  commands: [],
  invariants: [],
  events: [],
};

const change: ViewChange = {
  kind: "dimension",
  cardId: "card-1",
  cardTypeKey: "SocietyCard",
  dimensionKey: "description",
  before: { present: true, value: "before" },
  after: { present: true, value: "after" },
};

describe("View change reaction policy", () => {
  it("uses the most specific field policy", () => {
    expect(resolveViewChangeReaction({
      viewModule,
      changes: [change],
      eventDefinitions: [],
    })).toEqual({
      attention: "never",
      knowledge: "none",
      timing: "after_settle",
      guidance: ["Ignore presentation-only edits."],
    });
  });

  it("combines field and Event policies using the strongest review", () => {
    const event: DomainEventDefinition = {
      key: "society.changed",
      version: "1",
      payloadSchema: zodContractSchema(z.object({})),
      reaction: {
        attention: "always",
        knowledge: "reconcile",
        timing: "immediate",
        guidance: "Always surface identity conflicts.",
      },
    };
    expect(resolveViewChangeReaction({
      viewModule,
      changes: [change],
      eventDefinitions: [event],
    })).toEqual({
      attention: "always",
      knowledge: "reconcile",
      timing: "immediate",
      guidance: [
        "Ignore presentation-only edits.",
        "Always surface identity conflicts.",
      ],
    });
  });

  it("keeps Human attention while making AI and System post-commit knowledge-only", () => {
    const event: DomainEventDefinition = {
      key: "society.changed",
      version: "1",
      payloadSchema: zodContractSchema(z.object({})),
      reaction: { attention: "always", knowledge: "reconcile" },
    };
    const human = resolveViewPostCommitReaction({
      viewModule,
      changes: [change],
      eventDefinitions: [event],
      initiator: "human",
    });
    const ai = resolveViewPostCommitReaction({
      viewModule,
      changes: [change],
      eventDefinitions: [event],
      initiator: "ai",
    });
    const system = resolveViewPostCommitReaction({
      viewModule,
      changes: [change],
      eventDefinitions: [event],
      initiator: "system",
    });

    expect(human).toMatchObject({ attention: "always", knowledge: "reconcile" });
    expect(ai).toMatchObject({ attention: "never", knowledge: "reconcile" });
    expect(system).toMatchObject({ attention: "never", knowledge: "reconcile" });
  });
});
