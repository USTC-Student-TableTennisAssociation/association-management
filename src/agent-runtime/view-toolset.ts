import { jsonSchema, tool, type ToolSet } from "ai";
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
const VIEW_QUERY_SOURCE_REF_LIMIT = 40;
const VIEW_QUERY_INPUT_CORRECTION_ATTEMPTS = 1;

type ViewQueryInputIssue = {
  path: string;
  code: string;
  message: string;
};

function viewQueryInputIssues(error: unknown): ViewQueryInputIssue[] {
  if (error instanceof z.ZodError) {
    return error.issues.slice(0, 8).map((issue) => {
      const path = issue.path.length
        ? `$.${issue.path.map(String).join(".")}`
        : "$";
      if (issue.code === "unrecognized_keys") {
        return {
          path,
          code: issue.code,
          message: `未声明字段：${issue.keys.join("、")}`,
        };
      }
      return { path, code: issue.code, message: issue.message };
    });
  }
  return [{
    path: "$",
    code: "invalid_input",
    message: error instanceof Error
      ? error.message.replace(/\s+/g, " ").slice(0, 500)
      : "输入不符合 Query 契约",
  }];
}

function viewQueryInputFields(schema: Readonly<Record<string, unknown>>): string[] {
  const properties = schema.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

function viewQueryToolName(viewKey: string, queryKey: string): string {
  const normalized = `${viewKey}_${queryKey}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `query_${normalized}`;
}

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
  onQueryResult?: (result: {
    viewKey: string;
    complete: boolean;
    sourceCardCount: number;
    reason?: string;
  }) => void;
  findExistingObjectsByCanonicalName?: (
    canonicalName: string,
  ) => Promise<readonly { id: string; canonicalName: string }[]>;
  resolveObjectReference?: (
    reference: string,
  ) => { id: string; canonicalName: string } | undefined;
}) {
  const { registry, readPort, commandBus } = input;
  const inspectedViews = new Set<string>();
  const snapshots = new Map<string, Promise<
    ViewReadSnapshot & { references: readonly ViewInformationReference[] }
  >>();
  const referenceByRef = new Map<string, ViewInformationReference>();
  const publishedObjects = new Map<string, { id: string; canonicalName: string }>();
  const queryToolNamesByView = new Map<string, string[]>();
  const queryInputRejections = new Map<string, number>();
  const blockedQueryToolNames = new Set<string>();

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

  const describeQueries = (viewKey: string) => {
    const view = registry.getView(viewKey);
    if (!view) throw new ViewRuntimeError(`View ${viewKey} 未注册或未启用`);
    return view.queries.map((query) => ({
      queryKey: query.key,
      label: query.label,
      description: query.description,
      toolName: viewQueryToolName(viewKey, query.key),
    }));
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

  const locateObjectViews = async (objectRef: string) => {
    const object = input.resolveObjectReference?.(objectRef);
    if (!object) {
      throw new ViewRuntimeError(
        `Object 引用 ${objectRef} 尚未出现在本轮知识或业务上下文中；请先检索并使用真实 O#`,
      );
    }
    const allowedViewKeys = registry.listViews()
      .map((view) => view.manifest.key)
      .filter((viewKey) => input.skillSession?.canReadView(viewKey) ?? true);
    const discovery = await readPort.locateObject({
      objectId: object.id,
      viewKeys: allowedViewKeys,
      actor: input.actor,
    });
    const cardsByView = new Map<string, Map<string, number>>();
    for (const card of discovery.cards) {
      const cardTypes = cardsByView.get(card.viewKey) ?? new Map<string, number>();
      cardTypes.set(card.cardTypeKey, (cardTypes.get(card.cardTypeKey) ?? 0) + 1);
      cardsByView.set(card.viewKey, cardTypes);
    }
    const matches = discovery.searchedViewKeys.flatMap((viewKey) => {
      const cardTypes = cardsByView.get(viewKey);
      if (!cardTypes) return [];
      const view = registry.getView(viewKey)!;
      return [{
        viewKey,
        viewLabel: view.manifest.label,
        viewDescription: view.manifest.description,
        cardCount: [...cardTypes.values()].reduce((total, count) => total + count, 0),
        cardTypes: [...cardTypes].map(([cardTypeKey, count]) => ({ cardTypeKey, count })),
      }];
    });
    return {
      object: { ref: objectRef, canonicalName: object.canonicalName },
      searchedViewKeys: discovery.searchedViewKeys,
      matches,
      next: matches.length
        ? `选择与任务有关的 View，并调用 openBusinessContext；在 targetObjectRefs 中继续使用 ${objectRef}，以精确读取关联 Card。`
        : "当前授权且启用的 View 中没有关联这个 Object 的 Card。只有用户还要求相关资料或背景时，才继续检索 Shared Brain。",
    };
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

  const queryTools: ToolSet = {};
  for (const view of registry.listViews()) {
    const toolNames: string[] = [];
    for (const query of view.queries) {
      const name = viewQueryToolName(view.manifest.key, query.key);
      if (queryTools[name]) throw new Error(`View Query Tool 名称冲突：${name}`);
      toolNames.push(name);
      queryTools[name] = tool({
        description: [
          `${view.manifest.label} / ${query.label}`,
          query.description,
          "输入契约独立且精确；只使用本 Query Schema 声明的字段，不要沿用其他 Query 的参数。",
          "只读取该 View 已观察到的正式 Snapshot；结果中的 stateVersion、observedAt、coverage 与 references 由 Runtime 附加。",
        ].join("\n"),
        inputSchema: jsonSchema(query.inputSchema.jsonSchema),
        execute: async (value) => {
          if (!inspectedViews.has(view.manifest.key)) {
            throw new ViewRuntimeError(
              `调用 ${view.manifest.key} Query 前必须先用 openBusinessContext 选择并读取该 View`,
            );
          }
          let parsedInput: unknown;
          try {
            parsedInput = query.inputSchema.parse(value);
          } catch (error) {
            const rejectionCount = (queryInputRejections.get(name) ?? 0) + 1;
            queryInputRejections.set(name, rejectionCount);
            const correctionAttemptsRemaining = Math.max(
              0,
              VIEW_QUERY_INPUT_CORRECTION_ATTEMPTS - rejectionCount + 1,
            );
            const retryable = correctionAttemptsRemaining > 0;
            if (!retryable) blockedQueryToolNames.add(name);
            const allowedFields = viewQueryInputFields(query.inputSchema.jsonSchema);
            return {
              ok: false,
              error: {
                code: "INVALID_VIEW_QUERY_INPUT",
                viewKey: view.manifest.key,
                queryKey: query.key,
                issues: viewQueryInputIssues(error),
                ...(allowedFields.length ? { allowedFields } : {}),
                retryable,
                correctionAttemptsRemaining,
                next: retryable
                  ? "根据 issues 修正输入，并且只重新调用这一次。不要复制其他 Query 的参数。"
                  : "本轮已经用尽该 Query 的输入纠正机会；不要再次调用，请说明无法完成这项查询。",
              },
            };
          }
          const snapshot = await readView(view.manifest.key);
          const outcome = await query.execute(snapshot, parsedInput);
          const result = query.outputSchema.parse(outcome.data);
          if (outcome.coverage.level === "partial" && !outcome.coverage.reason.trim()) {
            throw new ViewRuntimeError(
              `View Query ${view.manifest.key}.${query.key} 的 partial coverage 缺少原因`,
            );
          }
          const snapshotCardIds = new Set(snapshot.cards.map((card) => card.id));
          const sourceCardIds = [...new Set(outcome.sourceCardIds)];
          const unknownCardId = sourceCardIds.find((cardId) => !snapshotCardIds.has(cardId));
          if (unknownCardId) {
            throw new ViewRuntimeError(
              `View Query ${view.manifest.key}.${query.key} 引用了 Snapshot 外的 Card`,
            );
          }
          const sourceCardRefById = new Map(
            [...referenceByRef.values()].flatMap((reference) =>
              reference.target.kind === "card"
                ? [[reference.target.cardId, reference.ref] as const]
                : []
            ),
          );
          const viewReference = [...referenceByRef.values()].find((reference) =>
            reference.target.kind === "view" &&
            reference.target.viewKey === view.manifest.key
          );
          if (!viewReference) {
            throw new ViewRuntimeError(`View ${view.manifest.key} 缺少本轮读取引用`);
          }
          const sourceCardRefs = sourceCardIds.flatMap((cardId) => {
            const ref = sourceCardRefById.get(cardId);
            return ref ? [ref] : [];
          });
          const coverageReason = outcome.coverage.level === "partial"
            ? outcome.coverage.reason
            : undefined;
          const complete = coverageReason === undefined;
          input.onQueryResult?.({
            viewKey: view.manifest.key,
            complete,
            sourceCardCount: sourceCardIds.length,
            ...(coverageReason ? { reason: coverageReason } : {}),
          });
          return {
            ok: true,
            view: {
              ref: viewReference.ref,
              viewKey: view.manifest.key,
              viewLabel: view.manifest.label,
              schemaVersion: snapshot.schemaVersion,
              stateVersion: snapshot.stateVersion,
              observedAt: snapshot.observedAt,
            },
            query: {
              key: query.key,
              version: query.version,
              label: query.label,
            },
            input: parsedInput,
            result,
            coverage: {
              level: outcome.coverage.level,
              ...(coverageReason ? { reason: coverageReason } : {}),
              sourceCardCount: sourceCardIds.length,
            },
            references: {
              viewRef: viewReference.ref,
              sourceCardRefs: sourceCardRefs.slice(0, VIEW_QUERY_SOURCE_REF_LIMIT),
              sourceRefsTruncated: sourceCardRefs.length > VIEW_QUERY_SOURCE_REF_LIMIT,
            },
          };
        },
      });
    }
    queryToolNamesByView.set(view.manifest.key, toolNames);
  }

  const tools: ToolSet = {
    ...queryTools,
    readView: tool({
      description: [
        "通过 Sydaris 统一 ViewReadPort 读取指定 View 的完整正式 Card Graph 快照。",
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
          references: snapshot.references.map((reference) => ({
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
              candidate.key === commandRequest.commandKey
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
    locateObjectViews,
    presentCards,
    describeQueries,
    describeCommands,
    queryToolNames(viewKeys: Iterable<string>): string[] {
      return [...new Set([...viewKeys].flatMap((viewKey) =>
        input.skillSession?.canReadView(viewKey) ?? true
          ? (queryToolNamesByView.get(viewKey) ?? []).filter((name) =>
              !blockedQueryToolNames.has(name)
            )
          : []
      ))];
    },
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
