"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";

import { ActivityPlaybookOverview } from "@/semantic-view/activity-playbook-components";
import { ActivityPortfolioOverview } from "@/semantic-view/activity-portfolio-components";
import {
  ACTIVITY_OPERATIONS_VIEW,
  SOCIETY_INFORMATION_VIEW,
  type AssertionSupportView,
  type BusinessViewKey,
  type BusinessViewPresentation,
  type SemanticViewCard,
  type SemanticViewCardType,
  type SemanticViewFocus,
  type SemanticViewState,
  type ViewProposalPresentation,
} from "@/semantic-view/types";

const VIEW_CHANGED_EVENT = "echo:semantic-view-changed";
const VIEW_PROPOSAL_CHANGED_EVENT = "echo:semantic-view-proposal-changed";

async function submitProposalDecision(
  proposalId: string,
  decision: "approve" | "reject",
): Promise<ViewProposalPresentation> {
  const response = await fetch(`/api/semantic-view/proposals/${proposalId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  const body = await response.json() as {
    error?: string;
    proposal?: ViewProposalPresentation;
  };
  if (!response.ok || !body.proposal) {
    throw new Error(body.error || "Proposal 处理失败");
  }
  return body.proposal;
}

function announceProposalChange(proposal: ViewProposalPresentation) {
  window.dispatchEvent(new CustomEvent(VIEW_PROPOSAL_CHANGED_EVENT, {
    detail: { proposal },
  }));
  if (proposal.status === "applied") {
    window.dispatchEvent(new CustomEvent(VIEW_CHANGED_EVENT, {
      detail: { viewKey: proposal.viewKey },
    }));
  }
}

function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="prose prose-zinc max-w-none whitespace-pre-wrap text-sm leading-6 text-zinc-700">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}

function SupportList({ supports }: { supports: AssertionSupportView[] }) {
  if (!supports.length) return null;
  return (
    <details className="mt-2 text-xs text-zinc-500">
      <summary className="cursor-pointer font-medium text-emerald-800">
        本次建议的 Shared Brain 依据（{supports.length}）
      </summary>
      <ul className="mt-2 space-y-2">
        {supports.map((support) => (
          <li key={support.id} className="rounded-md border border-zinc-200 bg-white p-2.5">
            <p className="text-zinc-700">{support.statement}</p>
            {support.sources.map((source) => (
              <details key={`${support.id}-${source.kind === "chat" ? source.evidenceId : source.sourceBlockId}`} className="mt-2 border-t border-zinc-100 pt-2">
                <summary className="cursor-pointer text-zinc-500">
                  {source.kind === "chat"
                    ? `${source.actorDisplayName} 的聊天陈述 · ${source.submittedAt}`
                    : `${source.sourceTitle} · ${source.sourceRegionLabel}${source.pages.length ? ` · p.${source.pages.join(",")}` : ""}`}
                </summary>
                <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-50 p-2 text-zinc-600">
                  {source.excerpt}
                </p>
              </details>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ViewProposalCard({
  proposal: initialProposal,
  onPreview,
}: {
  proposal: ViewProposalPresentation;
  onPreview: (proposal: ViewProposalPresentation) => void;
}) {
  const [proposal, setProposal] = useState(initialProposal);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const sync = (event: Event) => {
      const changed = (event as CustomEvent<{
        proposal?: ViewProposalPresentation;
      }>).detail?.proposal;
      if (changed?.id === initialProposal.id) setProposal(changed);
    };
    window.addEventListener(VIEW_PROPOSAL_CHANGED_EVENT, sync);
    return () => window.removeEventListener(VIEW_PROPOSAL_CHANGED_EVENT, sync);
  }, [initialProposal.id]);

  async function decide(decision: "approve" | "reject") {
    if (busy || proposal.status !== "pending") return;
    setBusy(decision);
    setError(undefined);
    try {
      const changed = await submitProposalDecision(proposal.id, decision);
      setProposal(changed);
      announceProposalChange(changed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-zinc-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            业务视角修改建议
          </p>
          <p className="mt-1">{proposal.reason}</p>
        </div>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs text-amber-800">
          {proposal.status}
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {proposal.changes.map((change, index) => (
          <div key={`${change.type}-${index}`} className="rounded-md border border-amber-200 bg-white/80 p-2.5">
            <p className="font-medium text-zinc-900">{change.title}</p>
            {change.type === "CREATE_CARD" ? (
              <p className="text-zinc-600">{change.objectName} → {change.cardTypeLabel}</p>
            ) : change.type === "SET_CONTENT_DIMENSION" ? (
              <>
                <p className="text-xs text-zinc-500">{change.cardLabel}</p>
                {change.before !== null ? (
                  <p className="mt-1 rounded bg-red-50 px-2 py-1 text-red-800 line-through">
                    {change.before}
                  </p>
                ) : null}
                <div className="mt-1 rounded bg-emerald-50 px-2 py-1 text-emerald-900">
                  <MarkdownContent>{change.after}</MarkdownContent>
                </div>
                <SupportList supports={change.supports} />
              </>
            ) : (
              <>
                <p className="text-xs text-zinc-500">{change.cardLabel}</p>
                <p className="mt-1 text-zinc-600">
                  {change.before.map((target) => target.objectName).join("、") || "未连接"} → {change.after.map((target) => target.objectName).join("、") || "清空"}
                </p>
                <SupportList supports={change.supports} />
              </>
            )}
          </div>
        ))}
      </div>

      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      {proposal.status === "pending" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => onPreview(proposal)}
            className="rounded-md border border-amber-400 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          >
            在社团信息中查看改动
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide("approve")}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {busy === "approve" ? "正在校验并应用…" : "批准"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide("reject")}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {busy === "reject" ? "正在拒绝…" : "拒绝"}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">
          {proposal.status === "applied"
            ? "已批准并写入正式业务视角。"
            : proposal.status === "rejected"
              ? "已拒绝；正式业务视角未发生变化。"
              : proposal.failureReason || "Proposal 已结束。"}
        </p>
      )}
    </section>
  );
}

function dimension(card: SemanticViewCard, name: string) {
  return card.contentDimensions.find((item) => item.name === name);
}

function slot(card: SemanticViewCard, key: string) {
  return card.slots.find((item) => item.key === key);
}

type ProposalChange = ViewProposalPresentation["changes"][number];

function proposalChangesForCard(
  proposal: ViewProposalPresentation | undefined,
  cardSelector: string,
) {
  return proposal?.changes.filter((change) => change.cardSelector === cardSelector) ?? [];
}

function proposedNewCard(
  view: SemanticViewState,
  proposal: ViewProposalPresentation | undefined,
  cardSelector: string | undefined,
): SemanticViewCard | undefined {
  if (!proposal || !cardSelector) return undefined;
  const creation = proposal.changes.find(
    (change): change is Extract<ProposalChange, { type: "CREATE_CARD" }> =>
      change.type === "CREATE_CARD" && change.cardSelector === cardSelector,
  );
  if (!creation) return undefined;
  const cardType = view.cardTypes.find((type) => type.key === creation.cardTypeKey);
  if (!cardType) return undefined;
  const changes = proposalChangesForCard(proposal, cardSelector);
  const dimensions = changes.filter(
    (change): change is Extract<ProposalChange, { type: "SET_CONTENT_DIMENSION" }> =>
      change.type === "SET_CONTENT_DIMENSION",
  );
  const slotChanges = new Map(
    changes
      .filter(
        (change): change is Extract<ProposalChange, { type: "SET_SLOT" }> =>
          change.type === "SET_SLOT",
      )
      .map((change) => [change.slotKey, change]),
  );
  return {
    id: cardSelector,
    viewKey: proposal.viewKey,
    cardTypeKey: creation.cardTypeKey,
    cardTypeLabel: creation.cardTypeLabel,
    ...(creation.objectId ? { objectId: creation.objectId } : {}),
    objectName: creation.objectName,
    seedContentDimensions: cardType.seedContentDimensions,
    contentDimensions: dimensions.map((change) => ({
      id: `${cardSelector}:${change.dimensionName}`,
      name: change.dimensionName,
      contentMarkdown: change.after,
    })),
    slots: cardType.slots.map((slotDefinition) => {
      const change = slotChanges.get(slotDefinition.key);
      return {
        key: slotDefinition.key,
        label: slotDefinition.label,
        meaning: slotDefinition.meaning,
        cardinality: slotDefinition.cardinality,
        targets: (change?.after ?? []).map((target) => ({
          cardId: target.cardId ?? target.cardSelector,
          viewKey: slotDefinition.allowedTargetViewKey ?? proposal.viewKey,
          cardTypeKey: target.cardTypeKey,
          ...(target.objectId ? { objectId: target.objectId } : {}),
          objectName: target.objectName,
        })),
      };
    }),
  };
}

function ContentDiff({ before, after }: { before: string | null; after: string }) {
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-zinc-200 bg-white font-mono text-sm">
      {before !== null ? (
        <div className="grid grid-cols-[2rem_1fr] border-l-4 border-red-400 bg-red-50 text-red-900">
          <span className="select-none px-2 py-2 text-center font-semibold text-red-600">−</span>
          <div className="border-l border-red-200 px-3 py-2 line-through decoration-red-400">
            <MarkdownContent>{before}</MarkdownContent>
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-[2rem_1fr] border-l-4 border-emerald-500 bg-emerald-50 text-emerald-950">
        <span className="select-none px-2 py-2 text-center font-semibold text-emerald-700">+</span>
        <div className="border-l border-emerald-200 px-3 py-2">
          <MarkdownContent>{after}</MarkdownContent>
        </div>
      </div>
    </div>
  );
}

function SlotDiff({
  before,
  after,
}: {
  before: Extract<ProposalChange, { type: "SET_SLOT" }>["before"];
  after: Extract<ProposalChange, { type: "SET_SLOT" }>["after"];
}) {
  const beforeSelectors = new Set(before.map((target) => target.cardSelector));
  const afterSelectors = new Set(after.map((target) => target.cardSelector));
  const rows = [
    ...before.map((target) => ({
      target,
      kind: afterSelectors.has(target.cardSelector) ? "same" as const : "remove" as const,
    })),
    ...after
      .filter((target) => !beforeSelectors.has(target.cardSelector))
      .map((target) => ({ target, kind: "add" as const })),
  ];
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-zinc-200 bg-white font-mono text-sm">
      {rows.length ? rows.map(({ target, kind }) => (
        <div
          key={`${kind}-${target.cardSelector}`}
          className={`grid grid-cols-[2rem_1fr] border-l-4 ${
            kind === "remove"
              ? "border-red-400 bg-red-50 text-red-900"
              : kind === "add"
                ? "border-emerald-500 bg-emerald-50 text-emerald-950"
                : "border-transparent text-zinc-600"
          }`}
        >
          <span className="select-none px-2 py-2 text-center font-semibold">
            {kind === "remove" ? "−" : kind === "add" ? "+" : " "}
          </span>
          <span className={`border-l px-3 py-2 ${
            kind === "remove"
              ? "border-red-200 line-through decoration-red-400"
              : kind === "add"
                ? "border-emerald-200"
                : "border-zinc-100"
          }`}
          >
            {target.objectName}
          </span>
        </div>
      )) : (
        <p className="px-3 py-2 text-zinc-400">连接保持为空</p>
      )}
    </div>
  );
}

function targetTypeLabels(view: SemanticViewState, typeKeys: string[]) {
  const labels = new Map(view.cardTypes.map((type) => [type.key, type.label]));
  return typeKeys.map((key) => labels.get(key) ?? key).join(" / ");
}

function CardTypeSchema({
  view,
  type,
  instances,
  onSelectCard,
}: {
  view: SemanticViewState;
  type: SemanticViewCardType;
  instances: SemanticViewCard[];
  onSelectCard: (cardId: string) => void;
}) {
  return (
    <article className="flex min-h-72 flex-col rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-zinc-950">{type.label}</h3>
          <p className="mt-0.5 font-mono text-xs text-zinc-400">{type.key}</p>
        </div>
        <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">
          {instances.length} 张
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-zinc-600">{type.meaning}</p>

      <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">初始内容</h4>
          {type.seedContentDimensions.length ? (
            <ul className="mt-2 space-y-1 text-zinc-700">
              {type.seedContentDimensions.map((name) => <li key={name}>· {name}</li>)}
            </ul>
          ) : <p className="mt-2 text-zinc-400">无固定初始内容</p>}
        </section>
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">连接</h4>
          {type.slots.length ? (
            <ul className="mt-2 space-y-1 text-zinc-700">
              {type.slots.map((item) => (
                <li key={item.key}>
                  · {item.label} → {targetTypeLabels(view, item.allowedTargetCardTypes)}
                  {item.cardinality === "many" ? "（多个）" : ""}
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-zinc-400">无连接定义</p>}
        </section>
      </div>

      <div className="mt-auto border-t border-zinc-100 pt-4">
        {instances.length ? (
          <div className="flex flex-wrap gap-2">
            {instances.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => onSelectCard(card.id)}
                className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900 hover:border-emerald-400"
              >
                {card.objectName} →
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-400">当前暂无正式{type.label}卡片</p>
        )}
      </div>
    </article>
  );
}

function CardDetail({
  card,
  cardSelector = card.id,
  isProposedNew = false,
  proposalPreview,
  focus,
  onBack,
  onSelectCard,
}: {
  card: SemanticViewCard;
  cardSelector?: string;
  isProposedNew?: boolean;
  proposalPreview?: ViewProposalPresentation;
  focus?: SemanticViewFocus;
  onBack: () => void;
  onSelectCard: (cardId: string) => void;
}) {
  const dimensionsByName = new Map(
    card.contentDimensions.map((item) => [item.name, item]),
  );
  const previewChanges = proposalChangesForCard(proposalPreview, cardSelector);
  const contentChanges = previewChanges.filter(
    (change): change is Extract<ProposalChange, { type: "SET_CONTENT_DIMENSION" }> =>
      change.type === "SET_CONTENT_DIMENSION",
  );
  const dimensionNames = [
    ...card.seedContentDimensions,
    ...card.contentDimensions.map((item) => item.name),
    ...contentChanges.map((change) => change.dimensionName),
  ].filter((name, index, names) => names.indexOf(name) === index);
  const dimensions = dimensionNames.map((name) => ({
    name,
    value: dimensionsByName.get(name),
    change: contentChanges.find((candidate) => candidate.dimensionName === name),
  }));
  const slotChanges = new Map(
    previewChanges
      .filter(
        (change): change is Extract<ProposalChange, { type: "SET_SLOT" }> =>
          change.type === "SET_SLOT",
      )
      .map((change) => [change.slotKey, change]),
  );
  const isFocusedCard = focus?.cardId === card.id ||
    focus?.proposalCardSelector === cardSelector;

  useEffect(() => {
    if (!isFocusedCard) return;
    const anchor = focus.dimensionName
      ? viewAnchorId(cardSelector, "dimension", focus.dimensionName)
      : focus.slotKey
        ? viewAnchorId(cardSelector, "slot", focus.slotKey)
        : undefined;
    if (!anchor) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [cardSelector, focus, isFocusedCard]);

  return (
    <article className={`rounded-xl bg-white p-6 shadow-sm ${
      isProposedNew
        ? "border-2 border-dashed border-emerald-400"
        : previewChanges.length
          ? "border-2 border-amber-300"
          : "border border-zinc-200"
    }`}>
      <button type="button" onClick={onBack} className="text-sm text-emerald-800 hover:underline">
        ← 返回卡片类型
      </button>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-zinc-950">{card.objectName}</h2>
          <p className="mt-1 text-sm text-zinc-500">{card.cardTypeLabel} · {card.cardTypeKey}</p>
          {isProposedNew ? (
            <span className="mt-2 inline-flex rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
              待创建 Card
            </span>
          ) : previewChanges.length ? (
            <span className="mt-2 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
              待修改
            </span>
          ) : null}
        </div>
      </div>

      <section className="mt-8">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">内容</h3>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {dimensions.map(({ name, value, change }) => (
            <div
              id={viewAnchorId(cardSelector, "dimension", name)}
              key={name}
              className={`scroll-m-8 rounded-lg border p-4 transition-colors ${
                isFocusedCard && focus?.dimensionName === name
                  ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200"
                  : change
                    ? "border-amber-300 bg-amber-50/40"
                  : "border-zinc-200 bg-zinc-50"
              }`}
            >
              <h4 className="font-semibold text-zinc-900">{name}</h4>
              {change ? (
                <ContentDiff before={change.before} after={change.after} />
              ) : value ? (
                <div className="mt-1"><MarkdownContent>{value.contentMarkdown}</MarkdownContent></div>
              ) : (
                <p className="mt-1 text-sm text-zinc-400">当前正式 View 暂无记录</p>
              )}
            </div>
          ))}
          {!dimensions.length ? (
            <p className="rounded-lg border border-dashed border-zinc-200 p-4 text-sm text-zinc-400">
              暂无正式内容。
            </p>
          ) : null}
        </div>
      </section>

      <section className="mt-8">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">连接</h3>
        <div className="mt-3 space-y-3">
          {card.slots.map((item) => {
            const change = slotChanges.get(item.key);
            return (
              <div
                id={viewAnchorId(cardSelector, "slot", item.key)}
                key={item.key}
                className={`scroll-m-8 rounded-lg border p-4 transition-colors ${
                  isFocusedCard && focus?.slotKey === item.key
                    ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200"
                    : change
                      ? "border-amber-300 bg-amber-50/40"
                      : "border-zinc-200"
                }`}
              >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="font-semibold text-zinc-900">{item.label}</h4>
                <span className="text-xs text-zinc-400">{item.cardinality === "many" ? "可连接多个" : "单一连接"}</span>
              </div>
              <p className="mt-1 text-sm text-zinc-500">{item.meaning}</p>
                {change ? (
                  <SlotDiff before={change.before} after={change.after} />
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.targets.map((target) => (
                      <button
                        key={target.cardId}
                        type="button"
                        onClick={() => onSelectCard(target.cardId)}
                        className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900"
                      >
                        {target.objectName} →
                      </button>
                    ))}
                    {!item.targets.length ? <span className="text-sm text-zinc-400">暂无连接</span> : null}
                  </div>
                )}
              </div>
            );
          })}
          {!card.slots.length ? <p className="text-sm text-zinc-400">该类型没有连接定义。</p> : null}
        </div>
      </section>
    </article>
  );
}

function viewAnchorId(cardId: string, kind: "dimension" | "slot", key: string) {
  return `semantic-view-${cardId}-${kind}-${encodeURIComponent(key)}`;
}

function GenericSemanticView({
  view,
  focus,
  proposalPreview,
  onFocusChange,
}: {
  view: SemanticViewState;
  focus?: SemanticViewFocus;
  proposalPreview?: ViewProposalPresentation;
  onFocusChange: (focus?: SemanticViewFocus) => void;
}) {
  const [selectedTypeKey, setSelectedTypeKey] = useState<string>("all");
  const selectedCard = view.cards.find((card) => card.id === focus?.cardId);
  const virtualCard = proposedNewCard(
    view,
    proposalPreview,
    focus?.proposalCardSelector,
  );
  const visibleTypes = selectedTypeKey === "all"
    ? view.cardTypes
    : view.cardTypes.filter((type) => type.key === selectedTypeKey);

  if (selectedCard || virtualCard) {
    const card = selectedCard ?? virtualCard!;
    return (
      <CardDetail
        card={card}
        cardSelector={focus?.proposalCardSelector ?? card.id}
        isProposedNew={Boolean(virtualCard)}
        proposalPreview={proposalPreview}
        focus={focus}
        onBack={() => onFocusChange(undefined)}
        onSelectCard={(cardId) => onFocusChange({ cardId })}
      />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSelectedTypeKey("all")}
          className={`rounded-full px-3 py-1.5 text-sm ${selectedTypeKey === "all" ? "bg-emerald-800 text-white" : "border border-zinc-200 bg-white text-zinc-600"}`}
        >
          全部 {view.cards.length}
        </button>
        {view.cardTypes.map((type) => {
          const count = view.cards.filter((card) => card.cardTypeKey === type.key).length;
          return (
            <button
              key={type.key}
              type="button"
              onClick={() => setSelectedTypeKey(type.key)}
              className={`rounded-full px-3 py-1.5 text-sm ${selectedTypeKey === type.key ? "bg-emerald-800 text-white" : "border border-zinc-200 bg-white text-zinc-600"}`}
            >
              {type.label} {count}
            </button>
          );
        })}
      </div>
      <div className="mt-5 grid gap-4 2xl:grid-cols-2">
        {visibleTypes.map((type) => (
          <CardTypeSchema
            key={type.key}
            view={view}
            type={type}
            instances={view.cards.filter((card) => card.cardTypeKey === type.key)}
            onSelectCard={(cardId) => onFocusChange({ cardId })}
          />
        ))}
      </div>
    </div>
  );
}

function ratingText(content?: string) {
  if (!content || content.includes("★")) return content;
  const digit = content.match(/[1-5]/)?.[0];
  const chineseDigit = content.match(/[一二三四五]/)?.[0];
  const count = digit ? Number(digit) : ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 } as const)[
    chineseDigit as "一" | "二" | "三" | "四" | "五"
  ];
  return count ? `${"★".repeat(count)} ${content}` : content;
}

function OverviewSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-emerald-100 py-7">
      <h3 className="text-base font-semibold text-zinc-950">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function EmptySocietyOverview() {
  return (
    <article className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <header className="bg-gradient-to-br from-emerald-50 to-white px-7 py-9">
        <p className="text-sm font-medium text-emerald-700">社团概览</p>
        <h2 className="mt-2 text-3xl font-semibold text-zinc-950">社团信息尚待建立</h2>
        <p className="mt-3 text-zinc-500">通过 AI 对话从 Shared Brain 提出并批准第一张社团卡片。</p>
      </header>
      <div className="px-7">
        <OverviewSection title="简介"><p className="text-zinc-400">暂无简介</p></OverviewSection>
        <OverviewSection title="基本信息">
          <dl className="grid gap-4 sm:grid-cols-3">
            {["社团星级", "成立时间", "宗旨"].map((label) => (
              <div key={label} className="rounded-lg bg-zinc-50 p-4">
                <dt className="text-sm text-zinc-500">{label}</dt>
                <dd className="mt-2 text-lg text-zinc-400">—</dd>
              </div>
            ))}
          </dl>
        </OverviewSection>
        <OverviewSection title="指导老师"><p className="text-zinc-400">暂无信息</p></OverviewSection>
        <OverviewSection title="组织人员"><p className="text-zinc-400">暂无组织人员信息</p></OverviewSection>
        <OverviewSection title="活动"><p className="text-zinc-400">暂无活动信息</p></OverviewSection>
        <OverviewSection title="平台"><p className="text-zinc-400">暂无平台信息</p></OverviewSection>
      </div>
    </article>
  );
}

function LinkedCards({
  cards,
  empty,
  render,
}: {
  cards: SemanticViewCard[];
  empty: string;
  render: (card: SemanticViewCard) => ReactNode;
}) {
  return cards.length ? (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <article key={card.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h4 className="font-semibold text-zinc-900">{card.objectName}</h4>
          {render(card)}
        </article>
      ))}
    </div>
  ) : <p className="text-zinc-400">{empty}</p>;
}

function SocietyInformationOverview({ view }: { view: SemanticViewState }) {
  const cardsById = useMemo(
    () => new Map(view.cards.map((card) => [card.id, card])),
    [view.cards],
  );
  const society = view.cards.find((card) => card.cardTypeKey === "SocietyCard");
  if (!society) return <EmptySocietyOverview />;

  const intro = dimension(society, "简介");
  const rating = dimension(society, "社团星级");
  const founded = dimension(society, "成立时间");
  const purpose = dimension(society, "宗旨");
  const linkedCards = (slotKey: string) =>
    (slot(society, slotKey)?.targets ?? [])
      .map((target) => cardsById.get(target.cardId))
      .filter((card): card is SemanticViewCard => Boolean(card));
  const advisors = linkedCards("advisor");
  const positions = linkedCards("positions");
  const activities = linkedCards("activities");
  const platforms = linkedCards("platforms");

  return (
    <article className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <header className="bg-gradient-to-br from-emerald-50 to-white px-7 py-9">
        <p className="text-sm font-medium text-emerald-700">社团概览</p>
        <h2 className="mt-2 text-3xl font-semibold text-zinc-950">{society.objectName}</h2>
        <p className="mt-3 text-lg font-semibold text-amber-700">{ratingText(rating?.contentMarkdown) ?? "星级待补充"}</p>
      </header>
      <div className="px-7">
        <OverviewSection title="简介">
          {intro ? (
            <MarkdownContent>{intro.contentMarkdown}</MarkdownContent>
          ) : <p className="text-zinc-400">暂无简介</p>}
        </OverviewSection>
        <OverviewSection title="基本信息">
          <dl className="grid gap-4 sm:grid-cols-3">
            {[
              { label: "社团星级", value: rating },
              { label: "成立时间", value: founded },
              { label: "宗旨", value: purpose },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-lg bg-zinc-50 p-4">
                <dt className="text-sm text-zinc-500">{label}</dt>
                <dd className="mt-2">{value ? <MarkdownContent>{value.contentMarkdown}</MarkdownContent> : <span className="text-zinc-400">—</span>}</dd>
              </div>
            ))}
          </dl>
        </OverviewSection>
        <OverviewSection title="指导老师">
          <LinkedCards
            cards={advisors}
            empty="暂无信息"
            render={(card) => {
              const content = dimension(card, "简介");
              return content ? <div className="mt-2"><MarkdownContent>{content.contentMarkdown}</MarkdownContent></div> : null;
            }}
          />
        </OverviewSection>
        <OverviewSection title="组织人员">
          <LinkedCards
            cards={positions}
            empty="暂无组织人员信息"
            render={(card) => {
              const title = dimension(card, "职位名称");
              const year = dimension(card, "学年");
              const holders = (slot(card, "holders")?.targets ?? []).map((target) => target.objectName);
              return (
                <div className="mt-2 text-sm text-zinc-600">
                  <p>{[year?.contentMarkdown, title?.contentMarkdown].filter(Boolean).join(" · ") || card.objectName}</p>
                  <p className="mt-1 text-emerald-800">{holders.join("、") || "任职人员尚未连接"}</p>
                </div>
              );
            }}
          />
        </OverviewSection>
        <OverviewSection title="活动">
          <LinkedCards
            cards={activities}
            empty="暂无活动信息"
            render={(card) => {
              const period = dimension(card, "举办时期");
              const content = dimension(card, "简介");
              return (
                <div className="mt-2 space-y-1">
                  {period ? <p className="text-sm text-emerald-700">{period.contentMarkdown}</p> : null}
                  {content ? <MarkdownContent>{content.contentMarkdown}</MarkdownContent> : null}
                </div>
              );
            }}
          />
        </OverviewSection>
        <OverviewSection title="平台">
          <LinkedCards
            cards={platforms}
            empty="暂无平台信息"
            render={(card) => {
              const platformType = dimension(card, "平台类型");
              const access = dimension(card, "访问方式");
              return (
                <div className="mt-2 space-y-1">
                  {platformType ? <p className="text-sm text-zinc-600">{platformType.contentMarkdown}</p> : null}
                  {access ? <div className="break-all text-emerald-800"><MarkdownContent>{access.contentMarkdown}</MarkdownContent></div> : null}
                </div>
              );
            }}
          />
        </OverviewSection>
      </div>
    </article>
  );
}

function ProposalPreviewBar({
  proposal,
  changeIndex,
  onChangeIndex,
  onProposalChange,
  onExit,
}: {
  proposal: ViewProposalPresentation;
  changeIndex: number;
  onChangeIndex: (index: number) => void;
  onProposalChange: (proposal: ViewProposalPresentation) => void;
  onExit: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string>();
  const change = proposal.changes[changeIndex];

  async function decide(decision: "approve" | "reject") {
    if (busy || proposal.status !== "pending") return;
    setBusy(decision);
    setError(undefined);
    try {
      const changed = await submitProposalDecision(proposal.id, decision);
      announceProposalChange(changed);
      onProposalChange(changed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            Proposal 改动预览 · {changeIndex + 1} / {proposal.changes.length}
          </p>
          <p className="mt-1 font-medium text-zinc-900">{change?.title ?? proposal.reason}</p>
          <p className="mt-1 text-xs text-zinc-500">红色表示删除，绿色表示新增；正式 View 尚未改变。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={changeIndex === 0 || busy !== null}
            onClick={() => onChangeIndex(changeIndex - 1)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 disabled:opacity-40"
          >
            上一处
          </button>
          <button
            type="button"
            disabled={changeIndex >= proposal.changes.length - 1 || busy !== null}
            onClick={() => onChangeIndex(changeIndex + 1)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 disabled:opacity-40"
          >
            下一处
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide("approve")}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === "approve" ? "正在应用…" : "批准并应用"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide("reject")}
            className="rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
          >
            {busy === "reject" ? "正在拒绝…" : "拒绝"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={onExit}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-600 disabled:opacity-50"
          >
            退出预览
          </button>
        </div>
      </div>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
    </section>
  );
}

export function SemanticViewWorkspace({
  viewKey = SOCIETY_INFORMATION_VIEW,
  presentation,
  focus,
  proposalPreview,
  proposalChangeIndex = 0,
  onFocusChange,
  onProposalChangeIndex,
  onProposalChange,
  onExitProposalPreview,
  onPresentationChange,
  onOpenAI,
  onAskAI,
}: {
  viewKey?: BusinessViewKey;
  presentation: BusinessViewPresentation;
  focus?: SemanticViewFocus;
  proposalPreview?: ViewProposalPresentation;
  proposalChangeIndex?: number;
  onFocusChange: (focus?: SemanticViewFocus) => void;
  onProposalChangeIndex: (index: number) => void;
  onProposalChange: (proposal: ViewProposalPresentation) => void;
  onExitProposalPreview: () => void;
  onPresentationChange: (presentation: BusinessViewPresentation) => void;
  onOpenAI: () => void;
  onAskAI: (prompt: string) => void;
}) {
  const [view, setView] = useState<SemanticViewState>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/semantic-view/${encodeURIComponent(viewKey)}`, { cache: "no-store" });
      const body = await response.json() as SemanticViewState & { error?: string };
      if (!response.ok) throw new Error(body.error || "读取失败");
      setView(body);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [viewKey]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const refresh = (event: Event) => {
      const changedViewKey = (event as CustomEvent<{ viewKey?: string }>).detail?.viewKey;
      if (!changedViewKey || changedViewKey === viewKey) void load();
    };
    window.addEventListener(VIEW_CHANGED_EVENT, refresh);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener(VIEW_CHANGED_EVENT, refresh);
    };
  }, [load, viewKey]);

  useEffect(() => {
    if (!proposalPreview) return;
    const sync = (event: Event) => {
      const changed = (event as CustomEvent<{
        proposal?: ViewProposalPresentation;
      }>).detail?.proposal;
      if (changed?.id === proposalPreview.id) onProposalChange(changed);
    };
    window.addEventListener(VIEW_PROPOSAL_CHANGED_EVENT, sync);
    return () => window.removeEventListener(VIEW_PROPOSAL_CHANGED_EVENT, sync);
  }, [onProposalChange, proposalPreview]);

  const specializedLabel = view?.specializedLabel ?? "概览";
  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-7 lg:px-10">
      <header className="border-b border-zinc-200 pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold text-zinc-950">{view?.viewLabel ?? "社团信息"}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
              {view?.viewDescription ?? "了解社团的基本身份、组织人员、长期活动与平台资源。"}
            </p>
            <p className="mt-2 text-xs text-zinc-400">
              {view?.cardTypes.length ?? 5} 种卡片类型 · {view?.cards.length ?? 0} 张正式卡片
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenAI}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-900"
          >
            <span aria-hidden="true">✦</span> AI
          </button>
        </div>
        <div className="mt-5 flex gap-1 rounded-lg bg-zinc-100 p-1 sm:w-fit">
          <button
            type="button"
            onClick={() => onPresentationChange("overview")}
            className={`rounded-md px-4 py-2 text-sm ${presentation === "overview" ? "bg-white font-medium text-emerald-900 shadow-sm" : "text-zinc-500"}`}
          >
            {specializedLabel}
          </button>
          <button
            type="button"
            onClick={() => onPresentationChange("cards")}
            className={`rounded-md px-4 py-2 text-sm ${presentation === "cards" ? "bg-white font-medium text-emerald-900 shadow-sm" : "text-zinc-500"}`}
          >
            卡片
          </button>
          {viewKey === ACTIVITY_OPERATIONS_VIEW ? (
            <button
              type="button"
              onClick={() => onPresentationChange("playbook")}
              className={`rounded-md px-4 py-2 text-sm ${presentation === "playbook" ? "bg-white font-medium text-emerald-900 shadow-sm" : "text-zinc-500"}`}
            >
              操作手册
            </button>
          ) : null}
        </div>
      </header>

      {proposalPreview?.status === "pending" ? (
        <ProposalPreviewBar
          proposal={proposalPreview}
          changeIndex={proposalChangeIndex}
          onChangeIndex={onProposalChangeIndex}
          onProposalChange={onProposalChange}
          onExit={onExitProposalPreview}
        />
      ) : null}

      {error ? <p className="mt-6 rounded-lg bg-red-50 p-4 text-red-700">{error}</p> : null}
      {!view && !error ? <p className="mt-6 text-zinc-500">正在读取 Business View…</p> : null}
      {view && !view.compatible ? (
        <p className="mt-6 rounded-lg bg-red-50 p-4 text-red-800">{view.incompatibilityReason}</p>
      ) : null}
      {view?.compatible ? (
        <div className="mt-7">
          {presentation === "playbook" && view.viewKey === ACTIVITY_OPERATIONS_VIEW
            ? <ActivityPlaybookOverview onAskAI={onAskAI} />
            : presentation === "overview"
            ? view.viewKey === SOCIETY_INFORMATION_VIEW
              ? <SocietyInformationOverview view={view} />
              : view.viewKey === ACTIVITY_OPERATIONS_VIEW
                ? <ActivityPortfolioOverview />
                : <GenericSemanticView
                    view={view}
                    focus={focus}
                    proposalPreview={proposalPreview}
                    onFocusChange={onFocusChange}
                  />
            : <GenericSemanticView
                view={view}
                focus={focus}
                proposalPreview={proposalPreview}
                onFocusChange={onFocusChange}
              />}
        </div>
      ) : null}
    </div>
  );
}
