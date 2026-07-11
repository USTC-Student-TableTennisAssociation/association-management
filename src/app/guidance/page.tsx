import { Suspense } from "react";

import { GuidanceLayerInspector } from "@/features/guidance-inspector/GuidanceLayerInspector";
import { getGuidanceInspectorSource } from "@/features/guidance-inspector/guidance-source";

export const metadata = {
  title: "指导层结构观察器 | Club Management",
  description: "只读查看乒协指导层卡片、关系与结构诊断。",
};

export default function GuidancePage() {
  const source = getGuidanceInspectorSource();

  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-[#f6f7f4] text-sm text-zinc-600">
          正在加载指导层结构观察器...
        </main>
      }
    >
      <GuidanceLayerInspector source={source} />
    </Suspense>
  );
}
