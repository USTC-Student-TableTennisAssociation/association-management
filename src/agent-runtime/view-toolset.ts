import { tool } from "ai";
import { z } from "zod";

import type { ActorContext, ViewReadSnapshot } from "@/contracts";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import type {
  ViewCommandProposalNotice,
  ViewInformationReference,
  ViewReferenceBundle,
} from "@/agent-runtime/view-types";
import { ViewCommandBus } from "@/view-runtime/application/command-bus";
import { PrismaViewReadPort } from "@/view-runtime/application/view-read-port";
import { ViewRuntimeError } from "@/view-runtime/domain/errors";

export function registeredViewKeySchema(registry: ExtensionRegistry) {
  return z.string().trim().min(1).refine(
    (viewKey) => Boolean(registry.getView(viewKey)),
    { message: "View 未注册或未启用" },
  );
}

function orientation(registry: ExtensionRegistry): string {
  return registry.listViews().map((view) =>
    `${view.manifest.key}（${view.manifest.label}）：` +
    (view.manifest.retrievalDescription ?? view.manifest.description)
  ).join("\n");
}

export function createAgentViewToolset(input: {
  actor: ActorContext;
  registry: ExtensionRegistry;
  readPort: PrismaViewReadPort;
  commandBus: ViewCommandBus;
  onProposal?: (proposal: ViewCommandProposalNotice) => void;
}) {
  const { registry, readPort, commandBus } = input;
  const inspectedViews = new Set<string>();
  const snapshots = new Map<string, Promise<ViewReadSnapshot & { references: ViewInformationReference[] }>>();
  const referenceByRef = new Map<string, ViewInformationReference>();

  const readView = (viewKey: string) => {
    const existing = snapshots.get(viewKey);
    if (existing) return existing;
    const pending = readPort.query({ viewKey, actor: input.actor }).then((snapshot) => {
      inspectedViews.add(viewKey);
      const viewModule = registry.getView(viewKey)!;
      const references: ViewInformationReference[] = [{
        ref: `V${referenceByRef.size + 1}`,
        label: viewModule.manifest.label,
        target: { kind: "view", viewKey },
      }];
      for (const card of snapshot.cards) {
        references.push({
          ref: `V${referenceByRef.size + references.length + 1}`,
          label: `${viewModule.manifest.label} / ${card.cardTypeKey}`,
          target: { kind: "card", viewKey, cardId: card.id },
        });
      }
      references.forEach((reference) => referenceByRef.set(reference.ref, reference));
      return { ...snapshot, references };
    }).catch((error) => {
      snapshots.delete(viewKey);
      throw error;
    });
    snapshots.set(viewKey, pending);
    return pending;
  };

  const tools = {
    readView: tool({
      description: [
        "通过 Echo 统一 ViewReadPort 读取指定 View 的完整正式 Card Graph 快照。",
        "View 职责范围：",
        orientation(registry),
        "返回 moduleVersion、schemaVersion、stateVersion、Typed Dimensions、View-local Slots 和 Related Objects。",
      ].join("\n"),
      inputSchema: z.object({ viewKey: registeredViewKeySchema(registry) }),
      execute: async ({ viewKey }) => readView(viewKey),
    }),
    runViewCommand: tool({
      description: [
        "调用某个 View Module 公开声明的 Domain Command。",
        "禁止传入原始 Card/Dimension/Slot mutation；输入会由 Command Contract 校验。",
        "approval_required 的 View 只会创建 Proposal；auto_execute 会在同一 Runtime 中执行。",
        "调用前必须先 readView，并带上已读取的 stateVersion。",
        ...registry.listViews().map((view) => [
          `${view.manifest.key}@${view.manifest.version}`,
          ...view.commands.map((command) =>
            `- ${command.key}@${command.version}（${command.label}）`
          ),
        ].join("\n")),
      ].join("\n"),
      inputSchema: z.object({
        viewKey: registeredViewKeySchema(registry),
        commandKey: z.string().trim().min(1),
        commandVersion: z.string().trim().min(1),
        expectedStateVersion: z.string().regex(/^\d+$/),
        input: z.unknown(),
      }),
      execute: async (request) => {
        if (!inspectedViews.has(request.viewKey)) {
          throw new ViewRuntimeError(`调用 ${request.viewKey} Command 前必须先 readView`);
        }
        const result = await commandBus.dispatch({
          ...request,
          actor: input.actor,
          initiator: "ai",
        });
        if (result.kind === "proposed") {
          input.onProposal?.({
            proposalId: result.proposalId,
            viewKey: request.viewKey,
            commandKey: request.commandKey,
            commandVersion: request.commandVersion,
            stateVersion: result.stateVersion,
            input: request.input,
          });
        } else {
          snapshots.delete(request.viewKey);
        }
        return result;
      },
    }),
  };

  return {
    tools,
    readView,
    availableReferenceRefs(): string[] {
      return [...referenceByRef.keys()];
    },
    citedReferences(text: string): ViewReferenceBundle {
      const refs = [...text.matchAll(/\[(V\d+)\]/g)].map((match) => match[1]);
      return {
        references: [...new Set(refs)].flatMap((ref) => {
          const reference = referenceByRef.get(ref);
          return reference ? [reference] : [];
        }),
      };
    },
  };
}
