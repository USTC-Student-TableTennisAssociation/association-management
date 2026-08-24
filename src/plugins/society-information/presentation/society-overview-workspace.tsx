"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ViewCardState } from "@/contracts";
import type { ViewInspectorSnapshot } from "@/view-runtime/application/view-read-port";

import styles from "./society-overview.module.css";

type SocietyOverviewSnapshot = ViewInspectorSnapshot & {
  objects?: readonly { id: string; canonicalName: string }[];
};

type WorkspaceProps = {
  viewKey: string;
  focusCardId?: string;
  onOpenInspector: () => void;
  onAskAI: (prompt: string) => void;
};

type EmptySlotProps = {
  eyebrow: string;
  title: string;
  onActivate: () => void;
  compact?: boolean;
};

const OFFICIAL_PURPOSE = "服务科大乒乓球爱好者，促进科大乒乓球运动发展。";

const frequencyLabels: Record<string, string> = {
  ANNUAL: "每年",
  PER_SEMESTER: "每学期",
  IRREGULAR: "不定期",
};

const statusLabels: Record<string, string> = {
  ACTIVE: "持续举办",
  PAUSED: "暂时暂停",
  RETIRED: "历史活动",
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
  focusCardId,
  onOpenInspector,
  onAskAI,
}: WorkspaceProps) {
  const [reloadSequence, setReloadSequence] = useState(0);
  const [heroReady, setHeroReady] = useState(false);
  const requestKey = `${viewKey}:${reloadSequence}`;
  const heroScrollRef = useRef<HTMLElement>(null);
  const heroStageRef = useRef<HTMLDivElement>(null);
  const heroBadgeRef = useRef<HTMLDivElement>(null);
  const heroWordmarkRef = useRef<HTMLDivElement>(null);
  const activityGalleryRef = useRef<HTMLDivElement>(null);
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
      setResult({
        requestKey,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
    return () => controller.abort();
  }, [requestKey, viewKey]);

  const loading = result?.requestKey !== requestKey;
  const snapshot = loading ? undefined : result?.snapshot;
  const error = loading ? undefined : result?.error;
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
  const activities = cardsInSlot("activities");
  const platforms = cardsInSlot("platforms");
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
    if (!focusCardId || !snapshot) return;
    window.requestAnimationFrame(() => {
      const target = document.getElementById(`society-card-${focusCardId}`)
        ?? document.getElementById("society-purpose-anchor");
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

  if (loading) {
    return (
      <div className={styles.statePage}>
        <div className={styles.loadingMark}>
          <Image src="/brand/ustctta-badge.svg" alt="乒协徽章" width={96} height={101} priority />
        </div>
        <p>正在准备球场</p>
      </div>
    );
  }

  if (error || !snapshot) {
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
  const factLabels = [rating, foundedOn ? foundedLabel(foundedOn) : undefined].filter(
    (item): item is string => Boolean(item),
  );
  const promptToFill = (topic: string) => onAskAI(
    `请先读取 ${viewKey} 当前状态，帮我补充${topic}。先从 Shared Brain 与高价值原文中整理已有资料，只向我确认仍无法确定的正式 Object、当前性或必要字段，再只使用已声明的 society Commands 提交。`,
  );
  const askToImprove = () => onAskAI(
    society
      ? `请帮我完善社团概览。先读取 ${viewKey} 当前状态，再以 synthesis 方式从 Shared Brain 与高价值原文中整理社团资料、指导老师、干事队伍、长期活动和平台入口；只向我询问经过检索后仍无法确认的当前性、冲突或必要字段，确认后只使用已声明的 society Commands 提交。`
      : `请帮我建立社团概览。先在知识中定位“中国科学技术大学学生乒乓球协会”的稳定 Object；唯一确认后以 synthesis 方式整理 Shared Brain 与高价值原文中的已有资料，无法唯一确认时才询问我，再使用 society.initialize_overview 建立正式概览。`,
  );

  return (
    <div className={styles.workspace}>
      <main className={styles.main}>
        <section ref={heroScrollRef} className={styles.heroScroll} aria-labelledby="society-hero-title">
          <div ref={heroStageRef} className={styles.heroStage} data-ready={heroReady ? "true" : "false"}>
            <div className={styles.nightLayer} aria-hidden="true">
              <Image
                src="/society-information/hero-evening-hall.png"
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
              <Image src="/brand/ustctta-badge.svg" alt="" width={340} height={358} priority />
            </div>
            <div ref={heroWordmarkRef} className={styles.heroWordmark}>
              <Image className={styles.lightWordmark} src="/brand/ustctta-wordmark.svg" alt={societyName} width={890} height={84} priority />
              <Image className={styles.blueWordmark} src="/brand/ustctta-wordmark.svg" alt="" width={890} height={84} priority />
            </div>

            <section id="society-purpose-anchor" className={styles.purposeScene} aria-labelledby="society-purpose-title">
              <p>我们的宗旨</p>
              <h2 id="society-purpose-title">{purpose}</h2>
              {description ? <p className={styles.purposeDescription}>{description}</p> : null}
              {factLabels.length ? (
                <div className={styles.purposeFacts}>
                  {factLabels.map((fact) => <span key={fact}>{fact}</span>)}
                </div>
              ) : null}
            </section>

            <div className={styles.scrollCue} aria-hidden="true"><DownArrowIcon /></div>
          </div>
        </section>

        <div className={styles.lightStory}>
          <div className={styles.brandRail} aria-hidden="true">
            <div className={styles.contentBrand}>
              <Image src="/brand/ustctta-badge.svg" alt="" width={52} height={55} />
              <Image src="/brand/ustctta-wordmark.svg" alt="" width={890} height={84} />
            </div>
          </div>

          <section className={styles.activitiesSection} aria-labelledby="society-activities-title">
            <header className={styles.sectionHeading}>
              <div>
                <p>我们的活动</p>
                <h2 id="society-activities-title">在球桌两端相遇。</h2>
              </div>
              <div className={styles.galleryControls}>
                <button type="button" aria-label="查看上一项活动" disabled={!activities.length} onClick={() => scrollActivities(-1)}>
                  <ChevronIcon direction="left" />
                </button>
                <button type="button" aria-label="查看下一项活动" disabled={!activities.length} onClick={() => scrollActivities(1)}>
                  <ChevronIcon direction="right" />
                </button>
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
                    className={`${styles.activityCard} ${focusCardId === activity.id ? styles.focusedCard : ""}`}
                  >
                    <div className={styles.activityTopline}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <span>{details || "长期活动"}</span>
                    </div>
                    <h3>{activityName}</h3>
                    <div className={styles.activityCardBottom}>
                      <p>{text(activity, "description") ?? "活动介绍待补充。"}</p>
                      <button
                        type="button"
                        aria-label={`用 Echo 更新${activityName}`}
                        onClick={() => onAskAI(`请读取 ${viewKey} 中 ID 为 ${activity.id} 的活动卡片，和我确认后更新“${activityName}”的信息。`)}
                      >
                        <EchoIcon />
                      </button>
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
                    <button type="button" onClick={onOpenInspector} aria-label="打开指导老师卡片"><ArrowUpRightIcon /></button>
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
            <Image src="/brand/ustctta-badge.svg" alt="" width={72} height={76} />
            <p>加入我们</p>
            <h2 id="society-join-title">下一场，等你上场。</h2>
            {description ? <p>{description}</p> : null}
          </header>

          <div className={styles.platformGrid}>
            {platforms.length ? platforms.map((platform) => {
              const href = safePublicUrl(text(platform, "url"));
              const label = objectName(platform, text(platform, "platform_type") ?? "平台入口");
              const className = `${styles.platformCard} ${focusCardId === platform.id ? styles.focusedCard : ""}`;
              const body = (
                <>
                  <p>{text(platform, "platform_type") ?? "平台入口"}</p>
                  <h3>{label}</h3>
                  <span>{text(platform, "access_instructions") ?? text(platform, "description") ?? "查看平台信息"}</span>
                  <ArrowUpRightIcon />
                </>
              );
              return href ? (
                <a id={`society-card-${platform.id}`} key={platform.id} href={href} target="_blank" rel="noreferrer" className={className}>{body}</a>
              ) : (
                <article id={`society-card-${platform.id}`} key={platform.id} className={className}>{body}</article>
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
    </div>
  );
}
