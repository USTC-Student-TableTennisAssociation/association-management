import { tool } from "ai";
import { z } from "zod";

import type {
  ActorContext,
  CommandInputReferenceDefinition,
  ViewReadSnapshot,
} from "@/contracts";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import type {
  ViewCommandProposalNotice,
  ViewInformationReference,
  ViewReferenceBundle,
} from "@/agent-runtime/view-types";
import type { AgentSkillSession } from "@/agent-runtime/skill-runtime";
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

function normalizedObjectName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\s“”"'《》〈〉【】（）()，,。.!！?？:：;；·—_\-]/g, "");
}

const databaseId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function referenceAtPath(
  references: readonly CommandInputReferenceDefinition[],
  path: readonly string[],
): CommandInputReferenceDefinition | undefined {
  return references.find((reference) =>
    reference.path.length === path.length &&
    reference.path.every((part, index) => part === path[index])
  );
}

function modelObjectReferenceSchema(multiple: boolean): Record<string, unknown> {
  const reference = {
    type: "string",
    description: "使用本轮知识检索返回的 O#，或可唯一解析的 canonical name；禁止填写数据库 UUID。",
  };
  return multiple
    ? { type: "array", items: reference }
    : reference;
}

function modelCardReferenceSchema(multiple: boolean): Record<string, unknown> {
  const reference = {
    type: "string",
    pattern: "^V\\d+$",
    description: "必须使用本轮 readView 返回的 V# Card 引用；禁止填写数据库 UUID、Object 引用或名称。",
  };
  return multiple
    ? { type: "array", items: reference }
    : reference;
}

/**
 * Domain Commands receive UUIDs after server-side reference resolution, but the
 * model-facing contract must never ask the model to manufacture those IDs.
 */
export function modelFacingCommandInputSchema(
  value: unknown,
  references: readonly CommandInputReferenceDefinition[] = [],
  path: readonly string[] = [],
): unknown {
  const reference = referenceAtPath(references, path);
  if (reference?.kind === "card") {
    return modelCardReferenceSchema(reference.cardinality === "many");
  }
  if (reference?.kind === "object") {
    return modelObjectReferenceSchema(reference.cardinality === "many");
  }
  if (Array.isArray(value)) {
    return value.map((item) => modelFacingCommandInputSchema(item, references, path));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => {
    if (entryKey === "properties" && entryValue && typeof entryValue === "object" && !Array.isArray(entryValue)) {
      return [entryKey, Object.fromEntries(Object.entries(entryValue).flatMap(
        ([propertyKey, propertySchema]) => {
          const propertyReference = referenceAtPath(references, [...path, propertyKey]);
          return propertyReference?.inferFromCanonicalNamePath
            ? []
            : [[
                propertyKey,
                modelFacingCommandInputSchema(propertySchema, references, [...path, propertyKey]),
              ]];
        },
      ))];
    }
    if (entryKey === "required" && Array.isArray(entryValue)) {
      return [entryKey, entryValue.filter((propertyKey) => {
        if (typeof propertyKey !== "string") return true;
        return !referenceAtPath(references, [...path, propertyKey])?.inferFromCanonicalNamePath;
      })];
    }
    return [entryKey, modelFacingCommandInputSchema(entryValue, references, path)];
  }));
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function withValueAtPath(
  value: unknown,
  path: readonly string[],
  nextValue: unknown,
): unknown {
  if (!path.length) return nextValue;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const [head, ...tail] = path;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    [head]: withValueAtPath(record[head], tail, nextValue),
  };
}

export function createAgentViewToolset(input: {
  actor: ActorContext;
  registry: ExtensionRegistry;
  readPort: PrismaViewReadPort;
  commandBus: ViewCommandBus;
  skillSession?: AgentSkillSession;
  onCommandAttempt?: () => void;
  onProposal?: (proposal: ViewCommandProposalNotice) => void;
  findExistingObjectsByCanonicalName?: (
    canonicalName: string,
  ) => Promise<readonly { id: string; canonicalName: string }[]>;
  resolveObjectReference?: (
    reference: string,
  ) => { id: string; canonicalName: string } | undefined;
}) {
  const { registry, readPort, commandBus } = input;
  const inspectedViews = new Set<string>();
  const snapshots = new Map<string, Promise<ViewReadSnapshot & { references: ViewInformationReference[] }>>();
  const referenceByRef = new Map<string, ViewInformationReference>();
  const publishedObjects = new Map<string, { id: string; canonicalName: string }>();

  const describeCommands = (viewKey: string) => {
    const view = registry.getView(viewKey);
    if (!view) throw new ViewRuntimeError(`View ${viewKey} 未注册或未启用`);
    const commands = view.commands.filter((command) =>
      command.allowedInitiators.includes("ai") &&
      (input.skillSession?.canRunCommand(viewKey, command.key) ?? true)
    );
    return {
      viewKey,
      schemaVersion: view.manifest.schemaVersion,
      semanticInstructions: view.manifest.aiSemanticInstructions ?? null,
      commands: commands.map((command) => ({
        commandKey: command.key,
        label: command.label,
        inputSchema: modelFacingCommandInputSchema(
          command.inputSchema.jsonSchema,
          command.inputReferences,
        ),
      })),
    };
  };

  const resolveObjectName = async (name: string) => {
    const discovered = input.resolveObjectReference?.(name);
    if (discovered) return discovered;
    const normalizedName = normalizedObjectName(name);
    const matches = [...publishedObjects.values()].filter(
      (object) => normalizedObjectName(object.canonicalName) === normalizedName,
    );
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1 || !input.findExistingObjectsByCanonicalName) {
      return undefined;
    }
    const existingMatches = await input.findExistingObjectsByCanonicalName(
      name.trim(),
    );
    return existingMatches.length === 1
      ? existingMatches[0]
      : undefined;
  };

  const resolveOneReference = async (
    value: unknown,
    reference: CommandInputReferenceDefinition,
  ): Promise<unknown> => {
    if (reference.cardinality === "many") {
      if (!Array.isArray(value)) {
        throw new ViewRuntimeError(`引用字段 ${reference.path.join(".")} 必须是数组`);
      }
      return Promise.all(value.map((item) => resolveOneReference(item, {
        ...reference,
        cardinality: "one",
      })));
    }
    if (typeof value !== "string") return value;
    if (reference.kind === "card") {
      const viewReference = referenceByRef.get(value);
      if (!viewReference) {
        throw new ViewRuntimeError(
          `字段 ${reference.path.join(".")} 必须使用本轮 readView 返回的真实 V# Card 引用；禁止填写数据库 UUID、Object 引用或名称`,
        );
      }
      if (viewReference.target.kind !== "card") {
        throw new ViewRuntimeError(`${value} 指向整个 View，不能作为 Card 引用`);
      }
      return viewReference.target.cardId;
    }
    if (reference.kind === "object") {
      if (databaseId.test(value)) {
        throw new ViewRuntimeError(
          `字段 ${reference.path.join(".")} 禁止填写数据库 UUID；请使用本轮知识检索返回的 O# 或唯一 canonical name`,
        );
      }
      const objectReference = input.resolveObjectReference?.(value);
      if (objectReference) return objectReference.id;
      const object = await resolveObjectName(value);
      if (object) return object.id;
      throw new ViewRuntimeError(
        `字段 ${reference.path.join(".")} 无法唯一解析 Object「${value}」；请先检索并使用 O#，或提供唯一 canonical name`,
      );
    }
    return value;
  };

  const resolveCommandReferences = async (
    value: unknown,
    references: readonly CommandInputReferenceDefinition[],
    path: readonly string[] = [],
  ): Promise<unknown> => {
    const reference = referenceAtPath(references, path);
    if (reference) return resolveOneReference(value, reference);
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => resolveCommandReferences(item, references, path)));
    }
    if (!value || typeof value !== "object") return value;
    const entries = await Promise.all(Object.entries(value).map(async ([entryKey, entryValue]) => [
      entryKey,
      await resolveCommandReferences(entryValue, references, [...path, entryKey]),
    ] as const));
    return Object.fromEntries(entries);
  };

  const bindInferredObjectReferences = async (
    commandInput: unknown,
    references: readonly CommandInputReferenceDefinition[],
  ): Promise<unknown> => {
    let bound = commandInput;
    for (const reference of references) {
      if (
        reference.kind !== "object" ||
        !reference.inferFromCanonicalNamePath ||
        valueAtPath(bound, reference.path) !== undefined
      ) continue;
      const name = valueAtPath(bound, reference.inferFromCanonicalNamePath);
      if (typeof name !== "string") continue;
      const object = await resolveObjectName(name);
      if (object) bound = withValueAtPath(bound, reference.path, object.id);
    }
    return bound;
  };

  const readView = (viewKey: string) => {
    if (!(input.skillSession?.canReadView(viewKey) ?? true)) {
      throw new ViewRuntimeError(
        `已激活 Skill ${input.skillSession?.active()?.extension.id} 不允许读取 View ${viewKey}`,
      );
    }
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

  const presentCards = (
    cards: readonly ViewReadSnapshot["cards"][number][],
    objectRefById: ReadonlyMap<string, string> = new Map(),
  ) => {
    const cardRefById = new Map(
      [...referenceByRef.values()].flatMap((reference) =>
        reference.target.kind === "card"
          ? [[reference.target.cardId, reference.ref] as const]
          : []
      ),
    );
    return cards.map((card) => ({
      ref: cardRefById.get(card.id),
      cardTypeKey: card.cardTypeKey,
      dimensions: card.dimensions,
      slots: Object.fromEntries(Object.entries(card.slots).map(([slotKey, targetIds]) => [
        slotKey,
        targetIds.flatMap((targetId) => {
          const ref = cardRefById.get(targetId);
          return ref ? [ref] : [];
        }),
      ])),
      relatedObjectRefs: card.relatedObjectIds.flatMap((objectId) => {
        const ref = objectRefById.get(objectId);
        return ref ? [ref] : [];
      }),
    }));
  };

  const tools = {
    readView: tool({
      description: [
        "通过 Echo 统一 ViewReadPort 读取指定 View 的完整正式 Card Graph 快照。",
        "View 职责范围：",
        orientation(registry),
        "返回 pluginVersion、schemaVersion、stateVersion、Typed Dimensions、View-local Slots 和 Related Objects。",
      ].join("\n"),
      inputSchema: z.object({ viewKey: registeredViewKeySchema(registry) }),
      execute: async ({ viewKey }) => {
        const snapshot = await readView(viewKey);
        return {
          ...snapshot,
          cards: presentCards(snapshot.cards),
          references: (snapshot.references as readonly ViewInformationReference[]).map((reference) => ({
            ref: reference.ref,
            label: reference.label,
            targetKind: reference.target.kind,
          })),
        };
      },
    }),
    runViewCommand: tool({
      description: [
        "调用某个 View Module 公开声明的 Domain Command。",
        "禁止传入原始 Card/Dimension/Slot mutation；输入会由 Command Contract 校验。",
        "approval_required 的 View 只会创建 Proposal；auto_execute 会在同一 Runtime 中执行。",
        "同一用户请求包含多个独立条目时，使用 commands 数组一次提交完整批次；Runtime 会为每个 Domain Command 生成独立、可见、可审批的 Proposal。不要只提交第一项后用文字声称其余项也已完成。",
        "Object 引用唯一只证明目标是谁，不证明它符合 Slot 的业务关系。若 Slot 或 Command 表示当前状态，来源还必须明确支持该对象在当前有效期内具有该关系；历史任职、过期名单、致谢或仅仅共现都不能写入当前 Slot，不确定时应留空并说明。",
        "批次中的 Command 都基于调用前的同一正式 View 状态；前一项产生的待审批 Proposal 不会在批次内创建可供后一项引用的 Card。若后续命令依赖尚未批准创建的 Card，本轮只提交前置 Command。",
        "调用前必须先 readView。stateVersion 与 Command version 均由 Runtime 自动绑定，模型只填写 commandKey，不得把 @版本号拼进 commandKey。",
        "Command 中的 Card 引用必须使用本轮 readView 返回的真实 V#。新建关联 Card 时只填写 Command 声明的自然语言实体名称；Runtime 会用本轮 O#、别名或唯一 canonical name 自动绑定 Object，模型禁止填写或索要数据库 UUID。",
        "只使用 openActions 返回的当前目标 View Command 契约；不要调用其他 View 的 Command。",
      ].join("\n"),
      inputSchema: z.union([z.object({
        viewKey: registeredViewKeySchema(registry),
        commandKey: z.string().trim().min(1),
        input: z.unknown(),
      }), z.object({
        viewKey: registeredViewKeySchema(registry),
        commands: z.array(z.object({
          commandKey: z.string().trim().min(1),
          input: z.unknown(),
        })).min(1).max(20),
      })]),
      execute: async (request) => {
        input.onCommandAttempt?.();
        if (!inspectedViews.has(request.viewKey)) {
          throw new ViewRuntimeError(`调用 ${request.viewKey} Command 前必须先 readView`);
        }
        const requests = "commands" in request
          ? request.commands.map((command) => ({ ...command, viewKey: request.viewKey }))
          : [request];
        const results = [];
        for (const commandRequest of requests) {
          try {
            const snapshot = await readView(commandRequest.viewKey);
            const availableCommands = (registry.getView(commandRequest.viewKey)?.commands ?? [])
              .filter((candidate) => candidate.allowedInitiators.includes("ai"));
            const command = availableCommands.find((candidate) =>
              candidate.key === commandRequest.commandKey ||
              `${candidate.key}@${candidate.version}` === commandRequest.commandKey
            );
            if (!command) {
              throw new ViewRuntimeError(
                `View ${commandRequest.viewKey} 没有声明 Command ${commandRequest.commandKey}；` +
                  `可用 commandKey：${availableCommands.map((candidate) => candidate.key).join("、")}`,
              );
            }
            if (!(input.skillSession?.canRunCommand(commandRequest.viewKey, command.key) ?? true)) {
              throw new ViewRuntimeError(
                `已激活 Skill ${input.skillSession?.active()?.extension.id} ` +
                  `不允许调用 ${commandRequest.viewKey}.${command.key}`,
              );
            }
            const references = command.inputReferences ?? [];
            const resolvedInput = await resolveCommandReferences(commandRequest.input, references);
            const commandInput = await bindInferredObjectReferences(resolvedInput, references);
            const result = await commandBus.dispatch({
              viewKey: commandRequest.viewKey,
              commandKey: command.key,
              commandVersion: command.version,
              input: commandInput,
              expectedStateVersion: snapshot.stateVersion,
              actor: input.actor,
              initiator: "ai",
              skillId: input.skillSession?.active()?.extension.id,
            });
            results.push(result);
            if (result.kind === "proposed") {
              input.onProposal?.({
                proposalId: result.proposalId,
                viewKey: commandRequest.viewKey,
                commandKey: command.key,
                commandVersion: command.version,
                stateVersion: result.stateVersion,
                input: commandRequest.input,
              });
            } else {
              snapshots.delete(commandRequest.viewKey);
            }
          } catch (error) {
            if (!(error instanceof ViewRuntimeError) && !(error instanceof z.ZodError)) {
              throw error;
            }
            results.push({
              kind: "invalid",
              viewKey: commandRequest.viewKey,
              commandKey: commandRequest.commandKey,
              error: error.message,
              next: "根据本轮 readView 的当前状态修正 Command；同一批次中的其他有效 Command 已继续处理。",
            });
          }
        }
        if (!("commands" in request)) return results[0];
        const resultEntries = results.map((result, index) => ({
          request: requests[index],
          result,
        }));
        const submittedProposals = resultEntries.flatMap(({ request: commandRequest, result }) =>
          result?.kind === "proposed" && "proposalId" in result
            ? [{
                proposalId: result.proposalId,
                commandKey: commandRequest.commandKey,
                input: commandRequest.input,
              }]
            : []
        );
        const executedCommands = resultEntries.flatMap(({ request: commandRequest, result }) =>
          result?.kind === "executed" && "executionId" in result
            ? [{
                executionId: result.executionId,
                commandKey: commandRequest.commandKey,
                input: commandRequest.input,
                stateVersion: result.stateVersion,
                ...(result.summary === undefined ? {} : { summary: result.summary }),
              }]
            : []
        );
        const invalidCommands = resultEntries.flatMap(({ request: commandRequest, result }) =>
          result?.kind === "invalid" && "error" in result
            ? [{
                commandKey: commandRequest.commandKey,
                input: commandRequest.input,
                error: result.error,
              }]
            : []
        );
        return {
          kind: "batch",
          attemptedCount: results.length,
          proposedCount: submittedProposals.length,
          executedCount: executedCommands.length,
          invalidCount: invalidCommands.length,
          submittedProposals,
          executedCommands,
          invalidCommands,
        };
      },
    }),
  };

  return {
    tools,
    readView,
    presentCards,
    describeCommands,
    registerPublishedObjects(objects: readonly { id: string; canonicalName: string }[]): void {
      for (const object of objects) publishedObjects.set(object.id, object);
    },
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
