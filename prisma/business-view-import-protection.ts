export type ProtectedBusinessView = {
  viewKey: string;
  cardCount: number;
};

export function protectedBusinessViewImportMessage(
  views: ProtectedBusinessView[],
  proposalCount = 0,
): string | undefined {
  if (!views.length && proposalCount === 0) return undefined;

  const protectedState = [
    views.length
      ? `正式 Business View：${views
          .map((view) => `${view.viewKey} (${view.cardCount} 张正式 Card)`)
          .join("、")}`
      : undefined,
    proposalCount > 0 ? `${proposalCount} 条 Business View Proposal` : undefined,
  ].filter(Boolean).join("；");

  return (
    `数据库中已有${protectedState}。` +
    "cold-start 导入会替换整个 Shared Brain Compilation，当前禁止直接覆盖；" +
    "请先完成 Business View 状态到新 Compilation 的迁移或明确清理这些状态。"
  );
}
