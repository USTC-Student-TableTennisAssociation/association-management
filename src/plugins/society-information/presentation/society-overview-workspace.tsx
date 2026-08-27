"use client";

import Image from "next/image";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  EchoPresentationProps,
  EchoViewCommandResult,
  ViewCardState,
} from "@sydaris/plugin-sdk";
import {
  type EchoViewSnapshot,
  useEchoViewReactions,
} from "@sydaris/plugin-sdk/react";

import {
  SocietyCardEditor,
  type SocietyDimensionChanges,
} from "./society-card-editor.js";
import badgeImage from "./assets/ustctta-badge.svg";
import heroImage from "./assets/hero-evening-hall.png";
import wordmarkImage from "./assets/ustctta-wordmark.svg";
import styles from "./society-overview.module.css";

type SocietyOverviewSnapshot = EchoViewSnapshot;
type WorkspaceProps = EchoPresentationProps;

type EmptySlotProps = {
  eyebrow: string;
  title: string;
  onActivate: () => void;
  compact?: boolean;
};

type EditorTarget = {
  cardId: string;
  identityLabel: string;
};

type ActivityDragState = {
  cardId: string;
  startIndex: number;
  targetIndex: number;
  deltaX: number;
  span: number;
};

type ActivityDragSession = {
  pointerId: number;
  cardId: string;
  startX: number;
  startIndex: number;
  targetIndex: number;
  centers: number[];
  span: number;
  order: string[];
};

const OFFICIAL_PURPOSE = "服务科大乒乓球爱好者，促进科大乒乓球运动发展。";

const frequencyLabels: Record<string, string> = {
  WEEKLY: "每周",
  ANNUAL: "每年",
  PER_SEMESTER: "每学期",
  IRREGULAR: "不定期",
};

const statusLabels: Record<string, string> = {
  ACTIVE: "持续举办",
  PAUSED: "暂时暂停",
  RETIRED: "历史活动",
};

const platformStatusLabels: Record<string, string> = {
  ACTIVE: "正常使用",
  UNKNOWN: "状态待确认",
  PAUSED: "暂时停用",
  RETIRED: "已停用",
};

function text(card: ViewCardState | undefined, key: string): string | undefined {
  const value = card?.dimensions[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safePublicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function foundedLabel(value: string): string {
  const year = /^\d{4}/.exec(value)?.[0];
  return year ? `${year} 年成立` : value;
}

function observedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "刚刚同步";
  return `最后同步于 ${new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function scrollParent(element: HTMLElement): HTMLElement | Window {
  let candidate = element.parentElement;
  while (candidate) {
    const overflowY = window.getComputedStyle(candidate).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && candidate.scrollHeight > candidate.clientHeight) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return window;
}

function ArrowUpRightIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6.25 13.75 13.75 6.25M8 6.25h5.75V12" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d={direction === "left" ? "m12.5 4.5-5.5 5.5 5.5 5.5" : "m7.5 4.5 5.5 5.5-5.5 5.5"} />
    </svg>
  );
}

function DownArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3.5v12M5.5 11l4.5 4.5 4.5-4.5" />
    </svg>
  );
}

function EchoIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.75 11.4 7l4.35 1.25-4.35 1.4L10 14l-1.4-4.35-4.35-1.4L8.6 7 10 2.75Z" />
      <path d="m15.5 13 .65 1.85L18 15.5l-1.85.65L15.5 18l-.65-1.85L13 15.5l1.85-.65L15.5 13Z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m12.75 4.25 3 3L7.5 15.5l-3.75.75.75-3.75 8.25-8.25Z" />
      <path d="m11.5 5.5 3 3" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="7" cy="6" r=".8" />
      <circle cx="13" cy="6" r=".8" />
      <circle cx="7" cy="10" r=".8" />
      <circle cx="13" cy="10" r=".8" />
      <circle cx="7" cy="14" r=".8" />
      <circle cx="13" cy="14" r=".8" />
    </svg>
  );
}

function remapChanges(
  changes: SocietyDimensionChanges,
  keys: Readonly<Record<string, string>>,
): SocietyDimensionChanges {
  return Object.fromEntries(Object.entries(changes).map(([key, value]) => [keys[key] ?? key, value]));
}

function sameOrderMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function movedOrder(order: readonly string[], from: number, to: number): string[] {
  const next = [...order];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function EmptySlot({ eyebrow, title, onActivate, compact = false }: EmptySlotProps) {
  return (
    <button
      type="button"
      className={`${styles.emptySlot} ${compact ? styles.compactEmptySlot : ""}`}
      onClick={onActivate}
    >
      <span>{eyebrow}</span>
      <strong>{title}</strong>
      <span className={styles.emptySlotAction}><EchoIcon />用 Echo 补充</span>
    </button>
  );
}

export function SocietyOverviewWorkspace({
  viewKey,
  refreshRevision = 0,
  focusCardId,
  onOpenInspector,
  onAskAI,
}: WorkspaceProps) {
  const [reloadSequence, setReloadSequence] = useState(0);
  const [heroReady, setHeroReady] = useState(false);
  const [editorTarget, setEditorTarget] = useState<EditorTarget>();
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string>();
  const [activityOrderOverride, setActivityOrderOverride] = useState<{
    ids: string[];
    stateVersion: string;
  }>();
  const [activityDrag, setActivityDrag] = useState<ActivityDragState>();
  const [activityOrderSaving, setActivityOrderSaving] = useState(false);
  const [activityOrderStatus, setActivityOrderStatus] = useState<string>();
  const [expandedReactionId, setExpandedReactionId] = useState<string>();
  const {
    reactions,
    refresh: refreshReactions,
    markSeen: markReactionSeen,
  } = useEchoViewReactions(viewKey);
  const requestKey = `${viewKey}:${refreshRevision}:${reloadSequence}`;
  const heroScrollRef = useRef<HTMLElement>(null);
  const heroStageRef = useRef<HTMLDivElement>(null);
  const heroBadgeRef = useRef<HTMLDivElement>(null);
  const heroWordmarkRef = useRef<HTMLDivElement>(null);
  const activityGalleryRef = useRef<HTMLDivElement>(null);
  const activityDragSessionRef = useRef<ActivityDragSession | undefined>(undefined);
  const lastFocusedCardIdRef = useRef<string | undefined>(undefined);
  const [result, setResult] = useState<{
    requestKey: string;
    snapshot?: SocietyOverviewSnapshot;
    error?: string;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/views/${encodeURIComponent(viewKey)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as SocietyOverviewSnapshot & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "无法读取社团概览");
      setResult({ requestKey, snapshot: body });
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setResult((current) => ({
        requestKey,
        snapshot: current?.snapshot,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    });
    return () => controller.abort();
  }, [requestKey, viewKey]);

  const loading = !result?.snapshot && result?.requestKey !== requestKey;
  const snapshot = result?.snapshot;
  const error = result?.requestKey === requestKey ? result.error : undefined;
  const objectNames = useMemo(() => new Map(
    snapshot?.objects?.map((object) => [object.id, object.canonicalName]) ?? [],
  ), [snapshot]);
  const cardsById = useMemo(() => new Map(
    snapshot?.cards.map((card) => [card.id, card]) ?? [],
  ), [snapshot]);
  const society = snapshot?.cards.find((card) => card.cardTypeKey === "SocietyCard");
  const cardsInSlot = useCallback((slotKey: string) =>
    (society?.slots[slotKey] ?? []).flatMap((cardId) => {
      const card = cardsById.get(cardId);
      return card ? [card] : [];
    }), [cardsById, society]);
  const advisors = cardsInSlot("advisor");
  const teamMembers = cardsInSlot("team");
  const platforms = cardsInSlot("platforms");
  const slotActivityIds = useMemo(
    () => [...(society?.slots.activities ?? [])],
    [society],
  );
  const effectiveActivityIds = useMemo(() => {
    if (
      activityOrderOverride &&
      activityOrderOverride.stateVersion === snapshot?.stateVersion &&
      sameOrderMembers(activityOrderOverride.ids, slotActivityIds)
    ) {
      return activityOrderOverride.ids;
    }
    return [...slotActivityIds];
  }, [activityOrderOverride, slotActivityIds, snapshot?.stateVersion]);
  const activities = effectiveActivityIds.flatMap((cardId) => {
    const card = cardsById.get(cardId);
    return card ? [card] : [];
  });
  const cardTypesByKey = useMemo(() => new Map(
    snapshot?.schema.cardTypes.map((cardType) => [cardType.key, cardType]) ?? [],
  ), [snapshot]);
  const editorCard = editorTarget ? cardsById.get(editorTarget.cardId) : undefined;
  const editorCardType = editorCard ? cardTypesByKey.get(editorCard.cardTypeKey) : undefined;
  const objectName = useCallback((card: ViewCardState | undefined, fallback: string) =>
    card?.relatedObjectIds.map((id) => objectNames.get(id)).find(Boolean) ?? fallback,
  [objectNames]);

  useEffect(() => {
    if (!snapshot) return;
    const hero = heroScrollRef.current;
    const stage = heroStageRef.current;
    const badge = heroBadgeRef.current;
    const wordmark = heroWordmarkRef.current;
    if (!hero || !stage || !badge || !wordmark) return;

    const root = scrollParent(hero);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;

    const viewportMetrics = () => {
      if (root === window) return { top: 0, height: window.innerHeight };
      const bounds = (root as HTMLElement).getBoundingClientRect();
      return { top: bounds.top, height: (root as HTMLElement).clientHeight };
    };

    const update = () => {
      animationFrame = 0;
      const viewport = viewportMetrics();
      hero.style.setProperty("--stage-height", `${viewport.height}px`);
      hero.style.setProperty("--hero-height", `${Math.max(viewport.height * 2.18, 1080)}px`);
      if (reducedMotion.matches) return;

      const bounds = hero.getBoundingClientRect();
      const travel = Math.max(1, hero.offsetHeight - viewport.height);
      const progress = clamp((viewport.top - bounds.top) / travel);
      const lockupProgress = clamp(progress / 0.72);
      const surfaceProgress = clamp((progress - 0.24) / 0.48);
      const purposeProgress = clamp((progress - 0.43) / 0.36);
      const badgeWidth = badge.offsetWidth;
      const wordmarkWidth = wordmark.offsetWidth;
      const finalBadgeWidth = clamp(stage.clientWidth * 0.044, 42, 52);
      const finalWordmarkWidth = clamp(stage.clientWidth * 0.2, 184, 270);
      const dockLeft = clamp(stage.clientWidth * 0.048, 28, 56);
      const dockTop = clamp(stage.clientHeight * 0.055, 26, 46);
      const badgeTargetX = dockLeft + finalBadgeWidth / 2;
      const targetY = dockTop + finalBadgeWidth / 2;
      const wordmarkTargetX = dockLeft + finalBadgeWidth + 13 + finalWordmarkWidth / 2;
      const badgeStartX = stage.clientWidth / 2;
      const badgeStartY = stage.clientHeight * 0.37;
      const wordmarkStartX = stage.clientWidth / 2;
      const wordmarkStartY = stage.clientHeight * 0.72;

      stage.style.setProperty("--hero-progress", progress.toFixed(4));
      stage.style.setProperty("--surface-progress", surfaceProgress.toFixed(4));
      stage.style.setProperty("--purpose-progress", purposeProgress.toFixed(4));
      stage.style.setProperty("--badge-x", `${((badgeTargetX - badgeStartX) * lockupProgress).toFixed(2)}px`);
      stage.style.setProperty("--badge-y", `${((targetY - badgeStartY) * lockupProgress).toFixed(2)}px`);
      stage.style.setProperty("--badge-scale", (1 - lockupProgress * (1 - finalBadgeWidth / Math.max(1, badgeWidth))).toFixed(4));
      stage.style.setProperty("--wordmark-x", `${((wordmarkTargetX - wordmarkStartX) * lockupProgress).toFixed(2)}px`);
      stage.style.setProperty("--wordmark-y", `${((targetY - wordmarkStartY) * lockupProgress).toFixed(2)}px`);
      stage.style.setProperty("--wordmark-scale", (1 - lockupProgress * (1 - finalWordmarkWidth / Math.max(1, wordmarkWidth))).toFixed(4));
    };

    const schedule = () => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(update);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(hero);
    resizeObserver.observe(stage);
    if (root !== window) resizeObserver.observe(root as HTMLElement);
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    reducedMotion.addEventListener("change", schedule);
    update();

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      reducedMotion.removeEventListener("change", schedule);
    };
  }, [snapshot]);

  useEffect(() => {
    if (!focusCardId) {
      lastFocusedCardIdRef.current = undefined;
      return;
    }
    if (!snapshot || lastFocusedCardIdRef.current === focusCardId) return;
    window.requestAnimationFrame(() => {
      const focusedCard = document.getElementById(`society-card-${focusCardId}`);
      const target = focusedCard ?? document.getElementById("society-purpose-anchor");
      if (focusedCard) lastFocusedCardIdRef.current = focusCardId;
      target?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
    });
  }, [focusCardId, snapshot]);

  const scrollActivities = useCallback((direction: -1 | 1) => {
    const gallery = activityGalleryRef.current;
    if (!gallery) return;
    gallery.scrollBy({
      left: gallery.clientWidth * 0.76 * direction,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, []);

  const executeHumanCommand = useCallback(async (
    commandKey: string,
    input: unknown,
  ) => {
    if (!snapshot) throw new Error("正式 View 尚未载入");
    const response = await fetch(
      `/api/views/${encodeURIComponent(viewKey)}/commands/${encodeURIComponent(commandKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input,
          expectedStateVersion: snapshot.stateVersion,
        }),
      },
    );
    const body = await response.json() as EchoViewCommandResult & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "无法保存 View 修改");
    refreshReactions();
    return body;
  }, [refreshReactions, snapshot, viewKey]);

  const openEditor = useCallback((card: ViewCardState, identityLabel: string) => {
    setEditorError(undefined);
    setEditorTarget({ cardId: card.id, identityLabel });
  }, []);

  const closeEditor = useCallback(() => {
    setEditorTarget(undefined);
    setEditorError(undefined);
  }, []);

  const saveEditor = useCallback(async (changes: SocietyDimensionChanges) => {
    if (!society || !editorCard) return;
    let commandKey: string;
    let input: unknown;
    switch (editorCard.cardTypeKey) {
      case "SocietyCard":
        commandKey = "society.update_profile";
        input = {
          societyCardId: society.id,
          changes: remapChanges(changes, { founded_on: "foundedOn" }),
        };
        break;
      case "PersonCard":
        commandKey = "society.update_person";
        input = { societyCardId: society.id, personCardId: editorCard.id, changes };
        break;
      case "ActivityCard":
        commandKey = "society.save_long_term_activity";
        input = {
          mode: "update",
          societyCardId: society.id,
          activityCardId: editorCard.id,
          changes: remapChanges(changes, { usual_period: "usualPeriod" }),
        };
        break;
      case "PlatformCard":
        commandKey = "society.save_platform";
        input = {
          mode: "update",
          societyCardId: society.id,
          platformCardId: editorCard.id,
          changes: remapChanges(changes, {
            platform_type: "platformType",
            access_instructions: "accessInstructions",
          }),
        };
        break;
      default:
        setEditorError(`暂不支持编辑 ${editorCard.cardTypeKey}`);
        return;
    }

    setEditorSaving(true);
    setEditorError(undefined);
    try {
      await executeHumanCommand(commandKey, input);
      setEditorTarget(undefined);
      setReloadSequence((value) => value + 1);
    } catch (cause) {
      setEditorError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEditorSaving(false);
    }
  }, [editorCard, executeHumanCommand, society]);

  const commitActivityOrder = useCallback(async (
    nextOrder: string[],
    announcement: string,
  ) => {
    if (!society || activityOrderSaving) return;
    if (!snapshot) return;
    setActivityOrderOverride({ ids: nextOrder, stateVersion: snapshot.stateVersion });
    setActivityOrderSaving(true);
    setActivityOrderStatus("正在保存活动顺序…");
    try {
      await executeHumanCommand("society.reorder_long_term_activities", {
        societyCardId: society.id,
        activityCardIds: nextOrder,
      });
      setActivityOrderStatus(announcement);
      setReloadSequence((value) => value + 1);
    } catch (cause) {
      setActivityOrderOverride(undefined);
      setActivityOrderStatus(
        `顺序未保存：${cause instanceof Error ? cause.message : String(cause)}`,
      );
      setReloadSequence((value) => value + 1);
    } finally {
      setActivityOrderSaving(false);
    }
  }, [activityOrderSaving, executeHumanCommand, snapshot, society]);

  const beginActivityDrag = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    cardId: string,
  ) => {
    if (activityOrderSaving || effectiveActivityIds.length < 2 || event.button !== 0) return;
    const gallery = activityGalleryRef.current;
    if (!gallery) return;
    const elements = new Map(
      [...gallery.querySelectorAll<HTMLElement>("[data-activity-card-id]")].map((element) => [
        element.dataset.activityCardId!,
        element,
      ]),
    );
    const centers = effectiveActivityIds.map((id) => {
      const bounds = elements.get(id)?.getBoundingClientRect();
      return bounds ? bounds.left + bounds.width / 2 : Number.NaN;
    });
    if (centers.some((center) => !Number.isFinite(center))) return;
    const startIndex = effectiveActivityIds.indexOf(cardId);
    if (startIndex < 0) return;
    const bounds = elements.get(cardId)!.getBoundingClientRect();
    const span = centers.length > 1
      ? Math.abs(centers[Math.min(startIndex + 1, centers.length - 1)] - centers[
        startIndex === centers.length - 1 ? startIndex - 1 : startIndex
      ])
      : bounds.width;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activityDragSessionRef.current = {
      pointerId: event.pointerId,
      cardId,
      startX: event.clientX,
      startIndex,
      targetIndex: startIndex,
      centers,
      span,
      order: [...effectiveActivityIds],
    };
    setActivityOrderStatus("拖动后松手即可保存顺序");
    setActivityDrag({ cardId, startIndex, targetIndex: startIndex, deltaX: 0, span });
  }, [activityOrderSaving, effectiveActivityIds]);

  const moveActivityDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = activityDragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - session.startX;
    const projectedCenter = session.centers[session.startIndex] + deltaX;
    const targetIndex = session.centers.reduce((closest, center, index) =>
      Math.abs(center - projectedCenter) < Math.abs(session.centers[closest] - projectedCenter)
        ? index
        : closest
    , session.startIndex);
    session.targetIndex = targetIndex;
    setActivityDrag({
      cardId: session.cardId,
      startIndex: session.startIndex,
      targetIndex,
      deltaX,
      span: session.span,
    });
  }, []);

  const endActivityDrag = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) => {
    const session = activityDragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activityDragSessionRef.current = undefined;
    setActivityDrag(undefined);
    if (cancelled || session.startIndex === session.targetIndex) {
      setActivityOrderStatus(cancelled ? "已取消活动排序" : undefined);
      return;
    }
    const nextOrder = movedOrder(session.order, session.startIndex, session.targetIndex);
    const movedCard = cardsById.get(session.cardId);
    const movedName = objectName(movedCard, "活动");
    void commitActivityOrder(
      nextOrder,
      `已将${movedName}移动到第 ${session.targetIndex + 1} 位`,
    );
  }, [cardsById, commitActivityOrder, objectName]);

  const moveActivityByKeyboard = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    cardId: string,
  ) => {
    if (activityOrderSaving) return;
    const from = effectiveActivityIds.indexOf(cardId);
    if (from < 0) return;
    let to = from;
    if (event.key === "ArrowLeft") to = Math.max(0, from - 1);
    else if (event.key === "ArrowRight") to = Math.min(effectiveActivityIds.length - 1, from + 1);
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = effectiveActivityIds.length - 1;
    else return;
    event.preventDefault();
    if (to === from) return;
    const nextOrder = movedOrder(effectiveActivityIds, from, to);
    const movedName = objectName(cardsById.get(cardId), "活动");
    void commitActivityOrder(nextOrder, `已将${movedName}移动到第 ${to + 1} 位`);
  }, [activityOrderSaving, cardsById, commitActivityOrder, effectiveActivityIds, objectName]);

  const activityDragStyle = useCallback((cardId: string, index: number): CSSProperties => {
    if (!activityDrag) return {};
    if (cardId === activityDrag.cardId) {
      return { transform: `translate3d(${activityDrag.deltaX}px, 0, 0)` };
    }
    if (
      activityDrag.targetIndex > activityDrag.startIndex &&
      index > activityDrag.startIndex &&
      index <= activityDrag.targetIndex
    ) {
      return { transform: `translate3d(${-activityDrag.span}px, 0, 0)` };
    }
    if (
      activityDrag.targetIndex < activityDrag.startIndex &&
      index >= activityDrag.targetIndex &&
      index < activityDrag.startIndex
    ) {
      return { transform: `translate3d(${activityDrag.span}px, 0, 0)` };
    }
    return {};
  }, [activityDrag]);

  if (loading) {
    return (
      <div className={styles.statePage}>
        <div className={styles.loadingMark}>
          <Image src={badgeImage} alt="乒协徽章" width={96} height={101} priority />
        </div>
        <p>正在准备球场</p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className={styles.statePage}>
        <div className={styles.errorCard}>
          <p className={styles.errorTitle}>今晚的球场暂时无法开放</p>
          <p className={styles.errorMessage}>{error ?? "社团概览不可用"}</p>
          <button type="button" onClick={() => setReloadSequence((value) => value + 1)} className={styles.primaryButton}>
            重新载入
          </button>
        </div>
      </div>
    );
  }

  const societyName = society
    ? objectName(society, "中国科学技术大学学生乒乓球协会")
    : "中国科学技术大学学生乒乓球协会";
  const purpose = text(society, "purpose") ?? OFFICIAL_PURPOSE;
  const description = text(society, "description");
  const rating = text(society, "rating");
  const foundedOn = text(society, "founded_on");
  const ratingReaction = society ? reactions.find((reaction) =>
    reaction.targets.some((target) =>
      target.kind === "dimension" &&
      target.cardId === society.id &&
      target.dimensionKey === "rating"
    )
  ) : undefined;
  const reactionPresentation = ratingReaction
    ? ratingReaction.attention.status === "queued" || ratingReaction.attention.status === "running"
      ? { label: "Echo 正在核对", tone: "checking" }
      : ratingReaction.attention.status === "silent"
      ? { label: "已核对", tone: "verified" }
      : ratingReaction.attention.status === "inform"
      ? { label: "Echo 有一条说明", tone: "inform" }
      : ratingReaction.attention.status === "needs_confirmation"
      ? { label: "需要确认", tone: "attention" }
      : ratingReaction.attention.status === "failed"
      ? { label: "核对暂不可用", tone: "failed" }
      : undefined
    : undefined;
  const showReactionDetail = Boolean(
    ratingReaction &&
    expandedReactionId === ratingReaction.id &&
    ratingReaction.attention.message,
  );
  const promptToFill = (topic: string) => onAskAI(
    `请先读取 ${viewKey} 当前状态，帮我补充${topic}。以 synthesis 方式从 Shared Brain 与高价值原文中整理已有资料，先完整提交一版待审批草稿；可选细节不确定可以留空或明确标注推断，只有正式 Object 有歧义、当前状态冲突或必要字段无法确定时才询问，再只使用已声明的 society Commands 提交。`,
  );
  const askToImprove = () => onAskAI(
    society
      ? `请帮我完善社团概览。先读取 ${viewKey} 当前状态，再以 synthesis 方式从 Shared Brain 与高价值原文中整理社团资料、指导老师、干事队伍、长期活动和平台入口，并完整提交一版待审批草稿；可选细节不确定可以留空或明确标注推断，只有正式 Object 有歧义、当前状态冲突或必要字段无法确定时才询问，再只使用已声明的 society Commands 提交。`
      : `请帮我建立社团概览。先在知识中定位“中国科学技术大学学生乒乓球协会”的稳定 Object；唯一确认后以 synthesis 方式整理 Shared Brain 与高价值原文中的已有资料，无法唯一确认时才询问我，再使用 society.initialize_overview 建立正式概览。`,
  );

  return (
    <div className={styles.workspace}>
      <main className={styles.main}>
        <section ref={heroScrollRef} className={styles.heroScroll} aria-labelledby="society-hero-title">
          <div ref={heroStageRef} className={styles.heroStage} data-ready={heroReady ? "true" : "false"}>
            <div className={styles.nightLayer} aria-hidden="true">
              <Image
                src={heroImage}
                alt=""
                fill
                sizes="100vw"
                className={styles.nightImage}
                onLoad={() => setHeroReady(true)}
                priority
              />
              <div className={styles.nightGrade} />
            </div>
            <div className={styles.whiteSurface} aria-hidden="true" />
            <h1 id="society-hero-title" className="sr-only">{societyName}</h1>

            <div ref={heroBadgeRef} className={styles.heroBadge}>
              <Image src={badgeImage} alt="" width={340} height={358} priority />
            </div>
            <div ref={heroWordmarkRef} className={styles.heroWordmark}>
              <Image className={styles.lightWordmark} src={wordmarkImage} alt={societyName} width={890} height={84} priority />
              <Image className={styles.blueWordmark} src={wordmarkImage} alt="" width={890} height={84} priority />
            </div>

            <section id="society-purpose-anchor" className={styles.purposeScene} aria-labelledby="society-purpose-title">
              <p>我们的宗旨</p>
              <h2 id="society-purpose-title">{purpose}</h2>
              {description ? <p className={styles.purposeDescription}>{description}</p> : null}
              {rating || foundedOn ? (
                <div className={styles.purposeFacts}>
                  {rating ? (
                    <span className={styles.ratingFact}>
                      {rating}
                      {reactionPresentation && ratingReaction ? (
                        <button
                          type="button"
                          className={styles.reactionStatus}
                          data-tone={reactionPresentation.tone}
                          aria-expanded={Boolean(showReactionDetail)}
                          disabled={!ratingReaction.attention.message}
                          onClick={() => {
                            setExpandedReactionId((current) =>
                              current === ratingReaction.id ? undefined : ratingReaction.id
                            );
                            if (!ratingReaction.seenAt) void markReactionSeen(ratingReaction.id);
                          }}
                        >
                          <EchoIcon />
                          {reactionPresentation.label}
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                  {foundedOn ? <span>{foundedLabel(foundedOn)}</span> : null}
                </div>
              ) : null}
              {showReactionDetail && ratingReaction?.attention.message ? (
                <div className={styles.reactionDetail} role="status">
                  <p>{ratingReaction.attention.message}</p>
                </div>
              ) : null}
              {society ? (
                <button
                  type="button"
                  className={styles.profileEditButton}
                  onClick={() => openEditor(society, societyName)}
                >
                  <PencilIcon />
                  编辑社团资料
                </button>
              ) : null}
            </section>

            <div className={styles.scrollCue} aria-hidden="true"><DownArrowIcon /></div>
          </div>
        </section>

        <div className={styles.lightStory}>
          <div className={styles.brandRail} aria-hidden="true">
            <div className={styles.contentBrand}>
              <Image src={badgeImage} alt="" width={52} height={55} />
              <Image src={wordmarkImage} alt="" width={890} height={84} />
            </div>
          </div>

          <section className={styles.activitiesSection} aria-labelledby="society-activities-title">
            <header className={styles.sectionHeading}>
              <div>
                <p>我们的活动</p>
                <h2 id="society-activities-title">在球桌两端相遇。</h2>
              </div>
              <div className={styles.galleryToolbar}>
                <span className={styles.activityOrderStatus} role="status" aria-live="polite">
                  {activityOrderStatus ?? (activities.length > 1 ? "拖动卡片手柄调整顺序" : "")}
                </span>
                <div className={styles.galleryControls}>
                  <button type="button" aria-label="查看上一项活动" disabled={!activities.length} onClick={() => scrollActivities(-1)}>
                    <ChevronIcon direction="left" />
                  </button>
                  <button type="button" aria-label="查看下一项活动" disabled={!activities.length} onClick={() => scrollActivities(1)}>
                    <ChevronIcon direction="right" />
                  </button>
                </div>
              </div>
            </header>

            <div ref={activityGalleryRef} className={styles.horizontalGallery}>
              {activities.length ? activities.map((activity, index) => {
                const frequency = text(activity, "frequency");
                const status = text(activity, "status") ?? "ACTIVE";
                const details = [
                  frequency ? frequencyLabels[frequency] ?? frequency : undefined,
                  text(activity, "usual_period"),
                  statusLabels[status] ?? status,
                ].filter(Boolean).join(" · ");
                const activityName = objectName(activity, "长期活动");
                return (
                  <article
                    id={`society-card-${activity.id}`}
                    key={activity.id}
                    data-activity-card-id={activity.id}
                    style={activityDragStyle(activity.id, index)}
                    className={`${styles.activityCard} ${
                      focusCardId === activity.id ? styles.focusedCard : ""
                    } ${activityDrag?.cardId === activity.id ? styles.draggingActivity : ""} ${
                      activityDrag && activityDrag.cardId !== activity.id ? styles.shiftingActivity : ""
                    }`}
                  >
                    <div className={styles.activityTopline}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div className={styles.activityMeta}>
                        <span>{details || "长期活动"}</span>
                        <button
                          type="button"
                          className={styles.dragHandle}
                          aria-label={`调整${activityName}的顺序；可拖动，或使用左右方向键`}
                          disabled={activityOrderSaving || activities.length < 2}
                          onPointerDown={(event) => beginActivityDrag(event, activity.id)}
                          onPointerMove={moveActivityDrag}
                          onPointerUp={(event) => endActivityDrag(event)}
                          onPointerCancel={(event) => endActivityDrag(event, true)}
                          onKeyDown={(event) => moveActivityByKeyboard(event, activity.id)}
                        >
                          <GripIcon />
                        </button>
                      </div>
                    </div>
                    <h3>{activityName}</h3>
                    <div className={styles.activityCardBottom}>
                      <p>{text(activity, "description") ?? "活动介绍待补充。"}</p>
                      <div className={styles.cardActions}>
                        <button
                          type="button"
                          aria-label={`直接编辑${activityName}`}
                          onClick={() => openEditor(activity, activityName)}
                        >
                          <PencilIcon />
                        </button>
                        <button
                          type="button"
                          aria-label={`用 Echo 更新${activityName}`}
                          onClick={() => onAskAI(`请读取 ${viewKey} 中 ID 为 ${activity.id} 的活动卡片，和我确认后更新“${activityName}”的信息。`)}
                        >
                          <EchoIcon />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              }) : (
                <EmptySlot eyebrow="活动卡片" title="长期活动待补充" onActivate={() => promptToFill("长期活动")} />
              )}
              <div className={styles.galleryEnd} aria-hidden="true" />
            </div>
          </section>

          <section className={styles.teamSection} aria-labelledby="society-team-title">
            <header className={styles.sectionHeading}>
              <div>
                <p>我们的团队</p>
                <h2 id="society-team-title">让每一场活动发生的人。</h2>
              </div>
            </header>

            <div className={styles.peopleBlock}>
              <div className={styles.peopleBlockHeading}>
                <h3>指导老师</h3>
                <span>{String(advisors.length).padStart(2, "0")}</span>
              </div>
              <div className={styles.peopleGrid}>
                {advisors.length ? advisors.map((advisor) => (
                  <article
                    id={`society-card-${advisor.id}`}
                    key={advisor.id}
                    className={`${styles.personCard} ${focusCardId === advisor.id ? styles.focusedCard : ""}`}
                  >
                    <p>指导老师</p>
                    <h4>{objectName(advisor, "姓名待补充")}</h4>
                    <div className={styles.cardActions}>
                      <button
                        type="button"
                        onClick={() => openEditor(advisor, objectName(advisor, "指导老师"))}
                        aria-label={`编辑${objectName(advisor, "指导老师")}的人物资料`}
                      >
                        <PencilIcon />
                      </button>
                      <button type="button" onClick={onOpenInspector} aria-label="打开指导老师高级视图">
                        <ArrowUpRightIcon />
                      </button>
                    </div>
                  </article>
                )) : (
                  <EmptySlot compact eyebrow="指导老师" title="指导老师待补充" onActivate={() => promptToFill("指导老师")} />
                )}
              </div>
            </div>

            <div className={styles.peopleBlock}>
              <div className={styles.peopleBlockHeading}>
                <h3>干事队伍</h3>
                <span>{String(teamMembers.length).padStart(2, "0")}</span>
              </div>
              <div className={styles.peopleGrid}>
                {teamMembers.length ? teamMembers.map((member) => {
                  const memberName = objectName(member, "姓名待补充");
                  return (
                    <article
                      id={`society-card-${member.id}`}
                      key={member.id}
                      className={`${styles.personCard} ${styles.memberCard} ${focusCardId === member.id ? styles.focusedCard : ""}`}
                    >
                      <p>{text(member, "department") ?? "部门待补充"}</p>
                      <h4>{memberName}</h4>
                      <span className={styles.memberPosition}>{text(member, "position") ?? "职位待补充"}</span>
                      <div className={styles.cardActions}>
                        <button
                          type="button"
                          onClick={() => openEditor(member, memberName)}
                          aria-label={`编辑${memberName}的人物资料`}
                        >
                          <PencilIcon />
                        </button>
                      </div>
                    </article>
                  );
                }) : (
                  <EmptySlot compact eyebrow="干事队伍" title="干事成员待补充" onActivate={() => promptToFill("干事队伍，记录每位干事的姓名、部门和职位")} />
                )}
              </div>
            </div>
          </section>
        </div>

        <section className={styles.joinSection} aria-labelledby="society-join-title">
          <header className={styles.joinHeading}>
            <Image src={badgeImage} alt="" width={72} height={76} />
            <p>加入我们</p>
            <h2 id="society-join-title">下一场，等你上场。</h2>
            {description ? <p>{description}</p> : null}
          </header>

          <div className={styles.platformGrid}>
            {platforms.length ? platforms.map((platform) => {
              const href = safePublicUrl(text(platform, "url"));
              const label = objectName(platform, text(platform, "platform_type") ?? "平台入口");
              const platformStatus = text(platform, "status") ?? "UNKNOWN";
              const accessInstructions = text(platform, "access_instructions");
              const className = `${styles.platformCard} ${focusCardId === platform.id ? styles.focusedCard : ""}`;
              return (
                <article id={`society-card-${platform.id}`} key={platform.id} className={className}>
                  <p>
                    {text(platform, "platform_type") ?? "平台入口"}
                    {platformStatus === "ACTIVE" ? "" : ` · ${platformStatusLabels[platformStatus] ?? platformStatus}`}
                  </p>
                  <h3>{label}</h3>
                  <span>{accessInstructions ?? text(platform, "description") ?? (platformStatus === "UNKNOWN" ? "访问或加入方式待确认" : "查看平台信息")}</span>
                  <div className={styles.cardActions}>
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer" aria-label={`打开${label}`}>
                        <ArrowUpRightIcon />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => openEditor(platform, label)}
                      aria-label={`直接编辑${label}`}
                    >
                      <PencilIcon />
                    </button>
                  </div>
                </article>
              );
            }) : (
              <EmptySlot eyebrow="平台信息" title="加入方式与平台待补充" onActivate={() => promptToFill("加入方式和平台入口")} />
            )}
          </div>

          <div className={styles.joinActions}>
            <button type="button" onClick={askToImprove} className={styles.primaryButton}>
              <EchoIcon />
              {society ? "用 Echo 更新" : "建立社团概览"}
            </button>
            <button type="button" onClick={onOpenInspector} className={styles.secondaryButton}>高级视图</button>
          </div>

          <footer className={styles.footer}>
            <span>{observedLabel(snapshot.observedAt)}</span>
            <span>USTC Table Tennis Association</span>
          </footer>
        </section>
      </main>
      {editorTarget && editorCard && editorCardType ? (
        <SocietyCardEditor
          key={editorCard.id}
          card={editorCard}
          cardType={editorCardType}
          identityLabel={editorTarget.identityLabel}
          saving={editorSaving}
          error={editorError}
          onClose={closeEditor}
          onSave={(changes) => void saveEditor(changes)}
        />
      ) : null}
    </div>
  );
}
