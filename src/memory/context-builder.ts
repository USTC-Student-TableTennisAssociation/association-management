import type {
  MemoryAssertionSeed,
  MemoryObjectSeed,
  MemoryRetrievalResult,
  MemorySourceReference,
  MemorySourceTime,
  StructuredSeedMap,
} from "@/memory/types";

function renderMatchSummary(seed: MemoryObjectSeed | MemoryAssertionSeed): string {
  return seed.matchedBy
    .map((match) => {
      const distance = match.distance === undefined ? "" : `, distance=${match.distance.toFixed(4)}`;
      return `${match.facetId}/${match.channel}/${match.method}/rank=${match.rank}/score=${match.score.toFixed(4)}${distance}`;
    })
    .join("；");
}

function renderSource(source: MemorySourceReference): string {
  if (source.kind === "chat") {
    return `${source.actorDisplayName} 的聊天陈述，submittedAt=${source.submittedAt}，timezone=${source.timezone}`;
  }
  const pages = source.pages.length ? `，页码 ${source.pages.join(", ")}` : "";
  return `${source.sourceTitle}，block=${source.sourceBlockId}${pages}，sourceNode=${source.sourceNodeId}`;
}

function renderSourceTime(sourceTime: MemorySourceTime | undefined): string {
  if (!sourceTime) return "未加载。";
  const evidence = sourceTime.supportingBlocks.length
    ? sourceTime.supportingBlocks.map((block) => {
        const pages = block.pages.length ? `，页码 ${block.pages.join(", ")}` : "";
        return `${block.sourceBlockId}${pages}`;
      }).join("；")
    : "无";
  return [
    `来源：${sourceTime.sourceTitle}`,
    `来源时间：${sourceTime.text ?? "未提供明确时间锚点"}`,
    `来源时间证据块：${evidence}`,
    "说明：来源时间只定位文档历史位置，不表示其中全部 Assertion 的有效期。",
  ].join("\n");
}

function renderObject(seed: MemoryObjectSeed): string {
  const surfaceForms = seed.surfaceForms.length
    ? `；Surface forms：${seed.surfaceForms.join("、")}`
    : "；Surface forms：无";
  const supports = seed.supportingAssertions.length
    ? `；支撑 Assertion：${seed.supportingAssertions.join("、")}`
    : "；当前没有支撑 Assertion";
  return [
    `[${seed.ref}] Global Object：${seed.canonicalName}${surfaceForms}`,
    `  Identity：${seed.globalObjectKey}`,
    `  命中类型：${seed.lexicalMatch ? "lexical" : ""}${seed.lexicalMatch && seed.semanticMatch ? " + " : ""}${seed.semanticMatch ? "assertion-derived" : ""}`,
    `  Facets：${seed.matchedFacets.join("、") || "无"}${supports}`,
    `  检索明细：${renderMatchSummary(seed) || "无"}`,
  ].join("\n");
}

function renderAssertion(seed: MemoryAssertionSeed): string {
  const assertionKind = seed.kind === "reference"
    ? "Reference（导航索引，需要回读来源）"
    : "Grounded（事实证据）";
  return [
    `[${seed.ref}] ${seed.renderedStatement}`,
    `  类型：${assertionKind}`,
    `  上下文依赖：${seed.contextDependent ? "是，不得脱离当前来源语境扩张解读" : "否"}`,
    `  Facets：${seed.matchedFacets.join("、") || "无"}`,
    `  检索明细：${renderMatchSummary(seed) || "无"}`,
    `  Assertion 证据块：${seed.sources.length ? seed.sources.map(renderSource).join("\n  - ") : "未加载"}`,
  ].join("\n");
}

function renderConnections(seedMap: StructuredSeedMap): string {
  if (!seedMap.connections.length) return "无。";
  return seedMap.connections
    .map((connection) => `${connection.assertionRef} ↔ ${connection.objectRef}`)
    .join("\n");
}

export function buildEvidenceContext(result: MemoryRetrievalResult): string {
  const seedMap = result.seedMap;
  const facets = seedMap.facets
    .map((facet) => `${facet.id}: ${facet.text}（${facet.source}）`)
    .join("\n");
  const objects = seedMap.objects.map(renderObject).join("\n\n") || "无。";
  const assertions = seedMap.assertions.map(renderAssertion).join("\n\n") || "无。";

  return [
    "以下是程序 Locate 得到的只读 Object–Assertion Structured Seed Map。",
    "其中只包含 Assertion 知识与最小来源标识，不包含 SourceBlock 原文，也不包含聊天 Evidence 原文。",
    "来源标题、页码、block、sourceNode、Actor 和提交时间只用于引用追溯，不作为额外事实内容。",
    "Object 的 canonical identity 和 surface forms 只用于识别“指向哪个对象”，不是事实证据。",
    "回答中的事实必须依据 kind=grounded 的 Assertion。Object 名称命中或 Object–Assertion Connection 本身不证明 Assertion 之外的任何事实。",
    "kind=reference 只说明应去哪个 SourceRegion/SourceBlock 继续读取；在目标原文未被 dereference 前，不得将它当成最终事实证据。",
    "类似活动或其他 Object 的事实只能作为类比，不得改写成用户所问 Object 自身的事实。",
    "组织知识不足时必须明确说明，不得用知识库外常识补齐组织事实。",
    "重要结论请在句末引用对应 Assertion，例如 [A1]；只能引用下列真实存在的 Assertion ref。",
    "",
    "## Query Facets",
    facets || "无。",
    "",
    "## Source Time Provenance",
    renderSourceTime(seedMap.sourceTime),
    "",
    "## Global Object Seeds",
    objects,
    "",
    "## Assertion Seeds",
    assertions,
    "",
    "## Object–Assertion Connections",
    renderConnections(seedMap),
  ].join("\n");
}

export function countSeedMapItems(seedMap: StructuredSeedMap): number {
  return seedMap.objects.length + seedMap.assertions.length;
}

export function sliceSeedMapAssertions(
  seedMap: StructuredSeedMap,
  count: number,
): StructuredSeedMap {
  const assertions = seedMap.assertions.slice(0, Math.max(0, count));
  const assertionRefs = new Set(assertions.map((item) => item.ref));
  const relevantObjectRefs = new Set(
    seedMap.connections
      .filter((connection) => assertionRefs.has(connection.assertionRef))
      .map((connection) => connection.objectRef),
  );
  const objects = seedMap.objects.filter(
    (item) => item.lexicalMatch || relevantObjectRefs.has(item.ref),
  );
  const objectRefs = new Set(objects.map((item) => item.ref));
  return {
    facets: seedMap.facets,
    ...(seedMap.sourceTime ? { sourceTime: seedMap.sourceTime } : {}),
    objects,
    assertions,
    connections: seedMap.connections.filter(
      (connection) =>
        assertionRefs.has(connection.assertionRef) && objectRefs.has(connection.objectRef),
    ),
  };
}
