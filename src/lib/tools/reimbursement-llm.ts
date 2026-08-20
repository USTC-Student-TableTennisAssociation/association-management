/**
 * 报销材料识别工具 —— LLM 增强层（可选）
 *
 * 在纯启发式主流程之外提供两项能力，默认关闭、失败静默降级、永不改写主结果：
 *   1. reviewComplianceWithLLM —— 语义合规审查：对照 yaoqiu.txt 与《社团财务报销流程》规则，
 *      检查启发式做不到的语义一致性，输出结构化 findings。
 *   2. rescueWithVisionLLM    —— 多模态 OCR 救援：对启发式 OCR 死局（手写签领表、左上角标题
 *      识别失败的新闻稿截图）直接把原图喂给视觉模型，补出结构化字段。
 *
 * 设计原则：
 *   - 复用仓库已有 OpenAI 协议 /chat/completions 客户端范式（见 src/app/api/chat/route.ts），
 *     不引入任何 LLM SDK，全程原生 fetch。
 *   - 复用 guidance-ai.ts 的严格 JSON 契约范式（system prompt 强制只返回 JSON、extractJsonObject
 *     防御性解析），但 extractJsonObject 在本模块本地实现，不反向依赖 src/features/。
 *   - LLM 结果是 advisory：只新增 optional 字段（llmReview / signItemsSource / llmNotes），
 *     绝不碰 isComplete / isValid / summary / 启发式 warnings / completenessCheck。
 *
 * 环境变量（与仓库 chat/guidance 路由一致）：
 *   AI_API_KEY、AI_API_BASE_URL（默认 https://api.openai.com/v1）、AI_MODEL
 */

import type { FileParseResult, SignItem, ReimbursementCheckResult, DocumentType } from './reimbursementParser';
import { applyFieldExtraction } from './reimbursementParser';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// 类型定义
// ============================================================

export type LLMOptions = {
  /** 是否启用 LLM 增强层，默认 false */
  enabled?: boolean;
  /** 覆盖环境变量 AI_MODEL */
  model?: string;
  /** 覆盖环境变量 AI_API_BASE_URL */
  baseUrl?: string;
  /** 覆盖环境变量 AI_API_KEY（仅进程内传入，不写盘） */
  apiKey?: string;
  /** 是否启用多模态视觉救援，默认 true */
  enableMultimodal?: boolean;
  /** 打印 LLM 调用日志 */
  verbose?: boolean;
};

export type LLMFinding = {
  /** error=明显违规；warning=需人工确认；info=提示 */
  severity: 'error' | 'warning' | 'info';
  /** 规则标识，对应 reimbursementRulesSystemPrompt 中的 ruleId */
  ruleId: string;
  /** 关联文件名（可选） */
  material?: string;
  /** 中文问题描述 */
  message: string;
  /** 修改建议（可选） */
  suggestion?: string;
};

export type LLMReviewResult = {
  findings: LLMFinding[];
  /** 中文总结 */
  summary: string;
  /** yaoqiu #4：预算明细中"应有发票或截图"但未找到对应材料的品目 */
  uncoveredBudgetItems?: string[];
  /** 审查时间（ISO，调用方注入，避免本模块依赖 Date.now） */
  reviewedAt: string;
  /** 使用的模型 */
  model: string;
};

type LLMMessageContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>;

type LLMMessage = {
  role: 'system' | 'user' | 'assistant';
  content: LLMMessageContent;
};

type CallLLMOptions = {
  /** 要求模型只返回 JSON 对象；解析失败时抛 LLMResponseError 供上层重试 */
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** base64 data-url 图片列表，触发多模态 */
  images?: string[];
  /** 超时毫秒，默认 45000 */
  timeoutMs?: number;
};

// ============================================================
// 错误类型
// ============================================================

/** 缺少 API key / model 等配置错误 —— 调用方应静默降级 */
export class LLMConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMConfigurationError';
  }
}

/** 网络 / HTTP / 超时 / 响应解析失败 —— 调用方可重试或降级 */
export class LLMResponseError extends Error {
  readonly isTimeout: boolean;
  readonly statusCode?: number;
  constructor(message: string, opts: { isTimeout?: boolean; statusCode?: number } = {}) {
    super(message);
    this.name = 'LLMResponseError';
    this.isTimeout = opts.isTimeout ?? false;
    this.statusCode = opts.statusCode;
  }
}

// ============================================================
// 通用 LLM 客户端（复用 src/app/api/chat/route.ts 的 fetch 范式）
// ============================================================

function getApiUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

function resolveConfig(opts: LLMOptions): {
  apiKey: string;
  baseUrl: string;
  model: string;
} {
  const apiKey = opts.apiKey || process.env.AI_API_KEY || '';
  const baseUrl = opts.baseUrl || process.env.AI_API_BASE_URL || 'https://api.openai.com/v1';
  const model = opts.model || process.env.AI_MODEL || '';
  if (!apiKey || !model) {
    throw new LLMConfigurationError(
      'LLM 增强层未配置：缺少 AI_API_KEY 或 AI_MODEL（可在 .env 中配置，或通过 options.llm 传入）',
    );
  }
  return { apiKey, baseUrl, model };
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 端点。
 * 支持纯文本与多模态（images 为 base64 data-url）。
 */
export async function callLLM(
  messages: LLMMessage[],
  callOpts: CallLLMOptions = {},
  llmOpts: LLMOptions = {},
): Promise<string> {
  const { apiKey, baseUrl, model } = resolveConfig(llmOpts);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), callOpts.timeoutMs ?? 45000);

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: callOpts.temperature ?? 0.2,
    max_tokens: callOpts.maxTokens ?? 4000,
  };
  // 部分 OpenAI 兼容端点支持 response_format 强制 JSON
  if (callOpts.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  let response: Response;
  try {
    response = await fetch(getApiUrl(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      throw new LLMResponseError('LLM 请求超时', { isTimeout: true });
    }
    throw new LLMResponseError(`LLM 网络请求失败：${err?.message ?? String(err)}`);
  }
  clearTimeout(timeoutId);

  const text = await response.text().catch(() => '');
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 非 JSON 响应体
  }

  if (!response.ok) {
    const apiMsg = data?.error?.message || text.slice(0, 300) || `HTTP ${response.status}`;
    throw new LLMResponseError(`LLM 服务返回错误：${apiMsg}`, { statusCode: response.status });
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new LLMResponseError('LLM 未返回有效回复内容');
  }

  const trimmed = content.trim();
  if (callOpts.jsonMode) {
    // 校验是否为合法 JSON（用 extractJsonObject 兼容代码围栏），失败抛错供上层重试
    if (extractJsonObject(trimmed) === null) {
      throw new LLMResponseError('LLM 在 jsonMode 下未返回可解析的 JSON');
    }
  }
  return trimmed;
}

// ============================================================
// JSON 解析（本地实现，等价于 guidance-ai.ts 的 extractJsonObject）
// ============================================================

/** 从模型输出中提取首个 JSON 对象，容忍 ```json 围栏与前后多余文字；失败返回 null */
export function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }
  try {
    return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1)) as unknown;
  } catch {
    return null;
  }
}

// ============================================================
// 图片编码工具（多模态救援用）
// ============================================================

function imageToDataUrl(filePath: string): string | null {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
      : ext === '.bmp' ? 'image/bmp'
      : 'image/jpeg'; // jpg / jpeg / 其它默认
    const buf = fs.readFileSync(filePath);
    const base64 = buf.toString('base64');
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
}

// ============================================================
// 语义合规审查
// ============================================================

/**
 * 系统提示：报销合规规则。
 * 仅收录经用户确认由 LLM 处理的语义规则（启发式做不到的）。
 */
export const reimbursementRulesSystemPrompt = `你是一名高校学生社团报销材料的合规审查助手。你会收到一组报销材料的结构化解析结果（JSON），需要对照下面的规则检查并输出审查结果。

# 审查规则

## rule-invoice-header（开票信息一字不差）
发票购买方（抬头）的开票信息必须与学校信息完全一致：
- 单位名称：中国科学技术大学
- 税号：12100000485001086E
- 地址：安徽省合肥市金寨路96号
- 电话：0551-63607156
- 开户银行：中国银行合肥蜀山支行营业部
- 银行账号：184203468850
- 抬头类型：企业
若发票的 buyerName / buyerTaxId 与上述不符，报告 error。若一致则【不要为该发票报告此规则】（检查通过不产出 finding）。

## rule-invoice-items-match（发票商品与购物截图一致）
发票上的商品类别和明细应与对应的购物截图上的商品一致。
若存在发票与购买截图的匹配关系，但商品名称/类别明显不一致，报告 warning。

## rule-signoff-count（签领数量与购买数量一致）
奖品/服装需要签领，签领数量应与审批单上的购买数量一致。
**关键**：只能用材料数据里实际存在的签领数量（signItems 数组里某项的 signedCount）。
若签领表的 signItems 为空数组或缺失（OCR 无法读取手写表），【不要编造任何签领数量】，应报一条 info 指出"签领表未能读取签领数量，无法核对，建议人工核对"。
只有当 signItems 中确实存在某项且其数量与审批单对应品目购买数量不一致时，才报 warning 并指出具体差异。

## rule-budget-coverage（预算明细项是否有对应发票/截图）
审批单预算明细中"应有发票或购买截图"的品目（如奖牌、证书、横幅、球等实物奖品及服装），每一项都应有对应的发票或购买截图。
请将预算明细中的此类品目逐一与提供的发票/购买截图商品做语义对应，找出没有对应发票或截图的品目，填入 uncoveredBudgetItems。

# 输出要求
1. 只能依据用户消息中提供的材料解析结果判断，**严禁编造**不存在的字段、金额、数量或签领记录。数据里没有的数字一律不要写进 findings。
2. severity 用法：error=确证的违规；warning=需人工确认的疑似问题；info=提示性说明。**检查通过的项不要报告**（如开票信息一致，就不要为它产出任何 finding）。
3. 每条 finding 的 material 必须是材料数据里实际存在的 fileName，不得生造文件名。
4. 对每张发票/每张购物截图都要检查，不要只看第一份就下结论。
5. 证据不足时宁可不报，不要猜测。
6. 只返回一个 JSON 对象，不要使用 Markdown 代码围栏，也不要输出 JSON 之外的任何文字。

# 返回结构
{
  "findings": [
    { "severity": "error" | "warning" | "info", "ruleId": "规则ID", "material": "关联文件名（可选）", "message": "问题描述", "suggestion": "修改建议（可选）" }
  ],
  "summary": "本次审查的中文总结",
  "uncoveredBudgetItems": ["预算明细中应有但未找到对应发票/截图的品目名称"]
}
findings 最多 12 项，每项 message 不超过 200 字。`;

/**
 * 构造每份文件的紧凑结构化视图（去掉 rawText 噪声，控制 token）。
 */
export function buildCompactFileView(files: FileParseResult[]): unknown {
  return files.map((f) => {
    const view: Record<string, unknown> = {
      fileName: f.fileName,
      documentType: f.documentType,
      totalAmount: f.totalAmount || null,
      date: f.date || null,
      invoiceNumber: f.invoiceNumber || null,
      merchantName: f.merchantName || null,
      buyerName: f.buyerName || null,
      sellerName: f.sellerName || null,
      deliveryAddress: f.deliveryAddress || null,
      orderId: f.orderId || null,
      itemsWithQuantity: f.itemsWithQuantity || [],
    };
    if (f.invoiceDetail) {
      view.invoiceDetail = {
        invoiceNumber: f.invoiceDetail.invoiceNumber,
        date: f.invoiceDetail.date,
        buyerName: f.invoiceDetail.buyerName,
        buyerTaxId: f.invoiceDetail.buyerTaxId,
        sellerName: f.invoiceDetail.sellerName,
        amount: f.invoiceDetail.amount,
        taxAmount: f.invoiceDetail.taxAmount,
        totalAmount: f.invoiceDetail.totalAmount,
        items: f.invoiceDetail.items,
      };
    }
    if (f.purchaseDetail) {
      view.purchaseDetail = {
        actualPayment: f.purchaseDetail.actualPayment,
        originalTotal: f.purchaseDetail.originalTotal,
        itemCount: f.purchaseDetail.itemCount,
        items: f.purchaseDetail.items,
        storeName: f.purchaseDetail.storeName,
        deliveryAddress: f.purchaseDetail.deliveryAddress,
        orderId: f.purchaseDetail.orderId,
      };
    }
    if (f.approvalDetail) {
      view.approvalDetail = {
        projectName: f.approvalDetail.projectName,
        organizingParty: f.approvalDetail.organizingParty,
        amount: f.approvalDetail.amount,
        budgetItems: f.approvalDetail.budgetItems,
      };
    }
    if (f.signItems && f.signItems.length > 0) {
      view.signItems = f.signItems;
    }
    return view;
  });
}

/**
 * 仅对发票、审批单取 rawText 头部摘录（控 token），辅助 LLM 判断开票信息与预算项。
 */
export function buildRawTextExcerpts(
  files: FileParseResult[],
  maxCharsPerFile = 800,
): unknown {
  const excerpts: Record<string, string> = {};
  for (const f of files) {
    if (f.documentType === '发票' || f.documentType === '二课审批单') {
      const t = (f.rawText || '').replace(/\s+/g, ' ').trim();
      if (t) {
        excerpts[f.fileName] = t.slice(0, maxCharsPerFile);
      }
    }
  }
  return excerpts;
}

function normalizeFindings(value: unknown): LLMFinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): LLMFinding | null => {
      if (!item || typeof item !== 'object') return null;
      const c = item as Record<string, unknown>;
      const severity = c.severity === 'error' || c.severity === 'warning' || c.severity === 'info'
        ? c.severity
        : 'info';
      const ruleId = typeof c.ruleId === 'string' ? c.ruleId.trim().slice(0, 64) : '';
      const message = typeof c.message === 'string' ? c.message.trim().slice(0, 400) : '';
      if (!ruleId || !message) return null;
      const material = typeof c.material === 'string' ? c.material.trim().slice(0, 200) : undefined;
      const suggestion = typeof c.suggestion === 'string' ? c.suggestion.trim().slice(0, 400) : undefined;
      return { severity, ruleId, ...(material ? { material } : {}), message, ...(suggestion ? { suggestion } : {}) };
    })
    .filter((x): x is LLMFinding => x !== null)
    .slice(0, 12);
}

function normalizeStringList(value: unknown, cap = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, cap);
}

function parseReviewResult(raw: string, model: string, reviewedAt: string): LLMReviewResult | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed as Record<string, unknown>;
  const summary = typeof c.summary === 'string' ? c.summary.trim().slice(0, 1000) : '';
  const findings = normalizeFindings(c.findings);
  // 至少要有 summary 或 findings 之一才算有效
  if (!summary && findings.length === 0) return null;
  const uncoveredBudgetItems = normalizeStringList(c.uncoveredBudgetItems);
  return {
    findings,
    summary,
    ...(uncoveredBudgetItems.length > 0 ? { uncoveredBudgetItems } : {}),
    reviewedAt,
    model,
  };
}

/**
 * 语义合规审查。返回 LLMReviewResult；配置缺失或调用失败返回 null（调用方静默降级）。
 * reviewedAt 由调用方注入，避免本模块依赖 Date.now。
 */
export async function reviewComplianceWithLLM(
  files: FileParseResult[],
  opts: LLMOptions,
  reviewedAt: string,
): Promise<LLMReviewResult | null> {
  const verbose = opts.verbose ?? false;
  const { model } = resolveConfig(opts);

  const userContent = `以下是报销材料的结构化解析结果，请对照规则进行审查。

紧凑结构化视图：
${JSON.stringify(buildCompactFileView(files), null, 2)}

关键原文摘录（发票/审批单）：
${JSON.stringify(buildRawTextExcerpts(files), null, 2)}

请按规则输出 JSON。`;

  const messages: LLMMessage[] = [
    { role: 'system', content: reimbursementRulesSystemPrompt },
    { role: 'user', content: userContent },
  ];

  const doCall = (extra: string): Promise<string> =>
    callLLM(
      extra
        ? [
            { role: 'system', content: reimbursementRulesSystemPrompt },
            { role: 'user', content: userContent },
            { role: 'assistant', content: extra },
            { role: 'user', content: '你必须只返回一个 JSON 对象，不要输出任何其它文字。' },
          ]
        : messages,
      { jsonMode: true, maxTokens: 4000, temperature: 0.2, timeoutMs: 120000 },
      opts,
    );

  try {
    if (verbose) console.log('  🤖 [LLM] 正在进行合规审查...');
    const raw = await doCall('');
    const result = parseReviewResult(raw, model, reviewedAt);
    if (result) return result;
    if (verbose) console.log('  🤖 [LLM] 首次解析失败，重试一次...');
    const raw2 = await doCall('（上一次回复不是合法 JSON）');
    return parseReviewResult(raw2, model, reviewedAt);
  } catch (err) {
    if (verbose) console.log(`  🤖 [LLM] 合规审查失败，已降级：${(err as Error).message}`);
    return null;
  }
}

// ============================================================
// 多模态 OCR 救援
// ============================================================

const SIGNOFF_RESCUE_PROMPT = `这是一张社团奖品签领表的实拍照片（手写）。请识别其中的奖品签领信息，返回 JSON：
{
  "signItems": [
    { "prizeName": "奖品名称", "signedCount": 已签领数量(整数) }
  ]
}
只返回一个 JSON 对象，不要使用 Markdown 代码围栏，也不要输出 JSON 之外的任何文字。若无法识别任何条目，返回 {"signItems": []}。`;

const NEWS_RESCUE_PROMPT = `这是一张社团活动新闻稿的网页截图。请判断截图是否带有"青春科大"或学校官网的网页标题栏（通常在页面顶部/左上角）。返回 JSON：
{
  "hasTitle": true 或 false,
  "titleText": "识别到的标题文字，没有则为空字符串"
}
只返回一个 JSON 对象，不要使用 Markdown 代码围栏，也不要输出 JSON 之外的任何文字。`;

function parseSignItemsRescue(raw: string): SignItem[] {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return [];
  const arr = (parsed as Record<string, unknown>).signItems;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item): SignItem | null => {
      if (!item || typeof item !== 'object') return null;
      const c = item as Record<string, unknown>;
      const prizeName = typeof c.prizeName === 'string' ? c.prizeName.trim().slice(0, 40) : '';
      const signedCount = typeof c.signedCount === 'number' && Number.isFinite(c.signedCount)
        ? Math.max(0, Math.floor(c.signedCount))
        : (typeof c.signedCount === 'string' && /^\d+$/.test(c.signedCount) ? parseInt(c.signedCount, 10) : 0);
      if (!prizeName) return null;
      return { prizeName, expectedCount: signedCount, signedCount };
    })
    .filter((x): x is SignItem => x !== null);
}

function parseNewsRescue(raw: string): { hasTitle: boolean; titleText: string } | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed as Record<string, unknown>;
  const hasTitle = typeof c.hasTitle === 'boolean' ? c.hasTitle : false;
  const titleText = typeof c.titleText === 'string' ? c.titleText.trim().slice(0, 200) : '';
  return { hasTitle, titleText };
}

function newsRawTextMissingTitle(f: FileParseResult): boolean {
  const t = f.rawText || '';
  return !['青春科大', '中国科学技术大学', 'young.ustc.edu.cn'].some((k) => t.includes(k));
}

/**
 * 多模态 OCR 救援：直接 mutate files，补出启发式读不到的结构化字段。
 * 仅处理两类 OCR 死局；任何失败都静默降级，保留启发式结果。
 */
export async function rescueWithVisionLLM(
  files: FileParseResult[],
  opts: LLMOptions,
): Promise<void> {
  const enableMultimodal = opts.enableMultimodal ?? true;
  if (!enableMultimodal) return;
  const verbose = opts.verbose ?? false;

  // 1. 签领表：启发式未提取到 signItems 时，发原图
  for (const f of files) {
    if (f.documentType !== '签领表') continue;
    if (f.signItems && f.signItems.length > 0) {
      f.signItemsSource = 'heuristic';
      continue;
    }
    const dataUrl = imageToDataUrl(f.filePath);
    if (!dataUrl) {
      f.signItemsSource = 'vision-llm-failed';
      continue;
    }
    try {
      if (verbose) console.log(`  🤖 [LLM] 视觉救援签领表：${f.fileName}`);
      const raw = await callLLM(
        [
          { role: 'system', content: SIGNOFF_RESCUE_PROMPT },
          { role: 'user', content: [{ type: 'text', text: '请识别这张签领表。' }, { type: 'image_url', image_url: { url: dataUrl } }] },
        ],
        { jsonMode: true, maxTokens: 1500, temperature: 0.1, timeoutMs: 60000 },
        opts,
      );
      const items = parseSignItemsRescue(raw);
      if (items.length > 0) {
        f.signItems = items;
        f.signItemsSource = 'vision-llm';
        if (verbose) console.log(`     → 识别到 ${items.length} 项签领`);
      } else {
        f.signItemsSource = 'vision-llm-failed';
      }
    } catch (err) {
      if (verbose) console.log(`  🤖 [LLM] 签领表视觉救援失败，已降级：${(err as Error).message}`);
      f.signItemsSource = 'vision-llm-failed';
    }
  }

  // 2. 新闻稿截图：rawText 不含标题关键词时，发原图确认
  for (const f of files) {
    if (f.documentType !== '新闻稿截图') continue;
    if (!newsRawTextMissingTitle(f)) continue;
    const dataUrl = imageToDataUrl(f.filePath);
    if (!dataUrl) continue;
    try {
      if (verbose) console.log(`  🤖 [LLM] 视觉救援新闻稿标题：${f.fileName}`);
      const raw = await callLLM(
        [
          { role: 'system', content: NEWS_RESCUE_PROMPT },
          { role: 'user', content: [{ type: 'text', text: '请判断这张截图是否带有青春科大网页标题。' }, { type: 'image_url', image_url: { url: dataUrl } }] },
        ],
        { jsonMode: true, maxTokens: 500, temperature: 0.1, timeoutMs: 60000 },
        opts,
      );
      const parsed = parseNewsRescue(raw);
      if (parsed) {
        f.llmNotes = {
          ...(f.llmNotes || {}),
          newsHasTitle: parsed.hasTitle,
          newsTitleText: parsed.titleText,
        };
        if (verbose) console.log(`     → hasTitle=${parsed.hasTitle}`);
      }
    } catch (err) {
      f.llmNotes = { ...(f.llmNotes || {}), visionRescueFailed: true };
      if (verbose) console.log(`  🤖 [LLM] 新闻稿视觉救援失败，已降级：${(err as Error).message}`);
    }
  }
}

// ============================================================
// 购买截图跨平台 LLM 提取
// ============================================================

/**
 * 启发式只针对淘宝格式，京东/拼多多/抖音等平台文案不同会提取失败。
 * 当启发式未提取到关键字段（实付款/商品/订单号）时，用文本 LLM 从 OCR 原文提取，
 * 兼容各平台"实付金额/实付¥/应付款""订单号/单号"等同义不同名字段。
 * 只回填启发式缺失的字段，不覆盖已提取的（启发式对淘宝更准）。
 */
const PURCHASE_EXTRACT_PROMPT = `你从一张网购平台购物截图的 OCR 文本中提取结构化信息。这可能是淘宝/京东/拼多多/抖音等任意平台，文案表述各异（如"实付款/实付金额/应付款/实付¥"同义，"订单号/单号/订单编号"同义）。

只返回一个 JSON 对象，不要使用 Markdown 代码围栏，不要输出 JSON 之外的文字：
{
  "actualPayment": "实付金额数字字符串，如 43.20；找不到为空",
  "items": [{ "name": "商品名称", "quantity": 购买数量整数 }],
  "orderId": "订单号字符串；找不到为空",
  "deliveryAddress": "收货地址；找不到为空"
}
依据 OCR 文本判断，不得编造。quantity 找不到时给 1。`;

type LlmPurchaseExtract = {
  actualPayment?: string;
  items?: { name: string; quantity: number }[];
  orderId?: string;
  deliveryAddress?: string;
};

function parsePurchaseExtract(raw: string): LlmPurchaseExtract | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed as Record<string, unknown>;
  const result: LlmPurchaseExtract = {};
  if (typeof c.actualPayment === 'string') {
    const m = c.actualPayment.match(/[\d.]+/);
    if (m) result.actualPayment = m[0];
  }
  if (Array.isArray(c.items)) {
    result.items = c.items
      .map((it): { name: string; quantity: number } | null => {
        if (!it || typeof it !== 'object') return null;
        const o = it as Record<string, unknown>;
        const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : '';
        if (!name) return null;
        const quantity = typeof o.quantity === 'number' && o.quantity > 0
          ? Math.floor(o.quantity)
          : (typeof o.quantity === 'string' && /^\d+$/.test(o.quantity) ? parseInt(o.quantity, 10) : 1);
        return { name, quantity };
      })
      .filter((x): x is { name: string; quantity: number } => x !== null)
      .slice(0, 20);
  }
  if (typeof c.orderId === 'string' && c.orderId.trim()) result.orderId = c.orderId.trim().slice(0, 40);
  if (typeof c.deliveryAddress === 'string' && c.deliveryAddress.trim()) {
    result.deliveryAddress = c.deliveryAddress.trim().slice(0, 120);
  }
  return result;
}

/** 判断启发式对购买截图的提取是否不全（需要 LLM 补） */
function purchaseNeedsLLM(f: FileParseResult): boolean {
  if (f.documentType !== '购买截图') return false;
  const hasPayment = !!f.totalAmount;
  const hasItems = (f.itemsWithQuantity?.length ?? 0) > 0;
  const hasOrder = !!f.orderId;
  // 实付款、商品、订单号三者缺其二即认为不全（单缺订单号可能正常）
  const missing = [hasPayment, hasItems, hasOrder].filter(x => !x).length;
  return missing >= 2;
}

/**
 * 对启发式提取不全的购买截图，用文本 LLM 从 OCR 原文补提取。
 * 原地增强 files，只回填缺失字段。失败静默降级。
 */
export async function extractPurchaseWithLLM(
  files: FileParseResult[],
  opts: LLMOptions,
): Promise<void> {
  const verbose = opts.verbose ?? false;
  const targets = files.filter(f => purchaseNeedsLLM(f));
  if (targets.length === 0) return;

  for (const f of targets) {
    try {
      if (verbose) console.log(`  🤖 [LLM] 购买截图跨平台提取：${f.fileName}`);
      const raw = await callLLM(
        [
          { role: 'system', content: PURCHASE_EXTRACT_PROMPT },
          { role: 'user', content: `购买截图 OCR 原文（含噪声，请据此提取）：\n${(f.rawText || '').slice(0, 2000)}` },
        ],
        { jsonMode: true, maxTokens: 1200, temperature: 0.1, timeoutMs: 120000 },
        opts,
      );
      const parsed = parsePurchaseExtract(raw);
      if (!parsed) {
        if (verbose) console.log(`     → LLM 未返回有效结果，保留启发式`);
        continue;
      }
      let filled = 0;
      // 只回填启发式缺失的字段
      if (!f.totalAmount && parsed.actualPayment) {
        f.totalAmount = parsed.actualPayment;
        if (f.purchaseDetail) f.purchaseDetail.actualPayment = parsed.actualPayment;
        filled++;
      }
      if ((!f.itemsWithQuantity || f.itemsWithQuantity.length === 0) && parsed.items && parsed.items.length > 0) {
        f.itemsWithQuantity = parsed.items;
        f.items = parsed.items.map(i => i.name);
        if (f.purchaseDetail) {
          f.purchaseDetail.items = parsed.items;
          f.purchaseDetail.itemCount = parsed.items.reduce((s, i) => s + i.quantity, 0);
        }
        filled++;
      }
      if (!f.orderId && parsed.orderId) {
        f.orderId = parsed.orderId;
        if (f.purchaseDetail) f.purchaseDetail.orderId = parsed.orderId;
        filled++;
      }
      if (!f.deliveryAddress && parsed.deliveryAddress) {
        f.deliveryAddress = parsed.deliveryAddress;
        if (f.purchaseDetail) f.purchaseDetail.deliveryAddress = parsed.deliveryAddress;
        filled++;
      }
      if (filled > 0) {
        f.llmNotes = { ...(f.llmNotes || {}), purchaseExtractedByLLM: true };
        if (verbose) console.log(`     → 回填 ${filled} 个字段`);
      }
    } catch (err) {
      if (verbose) console.log(`  🤖 [LLM] 购买截图提取失败，已降级：${(err as Error).message}`);
    }
  }
}

// ============================================================
// 文档分类修正（从内容判断，不依赖文件名）
// ============================================================

const RECLASSIFY_PROMPT = `你判断一段报销材料的 OCR/PDF 文本是哪种报销材料。只依据文本内容判断，不要受文件名影响。

可选类型（只选一个）：
- 发票：含"发票号码""价税合计""税额""购买方""销售方""统一社会信用代码"等
- 购买截图：网购平台订单/购物截图，含"实付款/实付金额/应付款""订单号/单号""收货地址""商品+数量"等，通常无发票号
- 二课审批单：含"项目名称""预算明细""项目组织方""青春科大""智慧团学"等
- 新闻稿截图：含"发布时间""青春科大""young.ustc.edu.cn"等网页新闻特征
- 签领表：奖品/服装签领记录，通常含人名+签领数量，手写表格特征
- 荣誉证书：获奖证书，含"荣誉证书""荣获""特发此证"等

只返回一个 JSON 对象，不要使用 Markdown 代码围栏，不要输出 JSON 之外的文字：
{ "documentType": "上面六种之一" }`;

const VALID_RECLASSIFY_TYPES = new Set<DocumentType>([
  '发票', '购买截图', '二课审批单', '新闻稿截图', '签领表', '荣誉证书',
]);

function parseReclassify(raw: string): DocumentType | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const t = (parsed as Record<string, unknown>).documentType;
  if (typeof t === 'string' && VALID_RECLASSIFY_TYPES.has(t as DocumentType)) {
    return t as DocumentType;
  }
  return null;
}

/**
 * 启发式分类高度依赖文件名关键词权重；当文件名不含"发票/截图"等提示时易误判
 * （如购买截图被误判成荣誉证书）。此函数对"分类可疑"的文件用 LLM 从内容重新判断，
 * 若与启发式不同则修正 documentType 并重跑对应类型的字段提取。
 * 触发条件：置信度低（<0.5）、或被分到易混类型（购买截图/荣誉证书/其他/未知）。
 * 原地增强 files，失败静默降级。
 */
export async function reclassifyWithLLM(
  files: FileParseResult[],
  opts: LLMOptions,
): Promise<void> {
  const verbose = opts.verbose ?? false;
  // 易混类型：购买截图与荣誉证书内容都可能含"证书"等词；其他/未知/低置信度更需复核
  const ambiguous = new Set<DocumentType>(['购买截图', '荣誉证书', '其他', '未知']);
  const targets = files.filter(f => {
    const conf = f.classificationConfidence ?? 1;
    return conf < 0.5 || ambiguous.has(f.documentType);
  });
  if (targets.length === 0) return;

  for (const f of targets) {
    try {
      if (verbose) console.log(`  🤖 [LLM] 内容分类复核：${f.fileName}（启发式=${f.documentType}, conf=${(f.classificationConfidence ?? 0).toFixed(2)}）`);
      const raw = await callLLM(
        [
          { role: 'system', content: RECLASSIFY_PROMPT },
          { role: 'user', content: `文件名：${f.fileName}（仅供参考，请以内容为准）\n\n文本内容：\n${(f.rawText || '').slice(0, 1500)}` },
        ],
        { jsonMode: true, maxTokens: 200, temperature: 0.1, timeoutMs: 60000 },
        opts,
      );
      const newType = parseReclassify(raw);
      if (newType && newType !== f.documentType) {
        if (verbose) console.log(`     → 修正：${f.documentType} → ${newType}`);
        f.documentType = newType;
        f.documentTypeReclassified = true;
        // 重置旧类型的结构化字段，再按新类型重提取
        f.invoiceDetail = undefined;
        f.purchaseDetail = undefined;
        f.approvalDetail = undefined;
        f.signItems = undefined;
        f.signItemsSource = undefined;
        f.merchantName = '';
        f.totalAmount = '';
        f.date = '';
        f.invoiceNumber = '';
        f.buyerName = '';
        f.sellerName = '';
        f.items = [];
        f.itemsWithQuantity = [];
        f.deliveryAddress = '';
        f.orderId = '';
        applyFieldExtraction(f, f.rawText);
        // 移除旧的"无法识别文档类型"警告
        f.warnings = f.warnings.filter(w => !w.includes('无法识别文档类型'));
      }
    } catch (err) {
      if (verbose) console.log(`  🤖 [LLM] 分类复核失败，已降级：${(err as Error).message}`);
    }
  }
}

// ============================================================
// 增强入口（主流程 / Agent 二次调用均可）
// ============================================================

/**
 * 对已算出的启发式结果执行 LLM 增强（原地增强并返回）。
 * 顺序：分类修正（从内容判断）→ 视觉救援 → 购买截图跨平台提取 → 合规审查。
 * 分类修正最先跑，避免错分类导致后续字段提取/审查全错。全程 try/catch，任何失败都不影响主结果。
 * reviewedAt 由调用方注入。
 */
export async function enhanceWithLLM(
  result: ReimbursementCheckResult,
  opts: LLMOptions,
  reviewedAt: string,
): Promise<ReimbursementCheckResult> {
  if (!opts.enabled) return result;
  try {
    await reclassifyWithLLM(result.files, opts);
  } catch {
    /* 分类修正失败不影响后续 */
  }
  try {
    await rescueWithVisionLLM(result.files, opts);
  } catch {
    /* 救援整体失败不影响后续 */
  }
  try {
    await extractPurchaseWithLLM(result.files, opts);
  } catch {
    /* 购买截图提取失败不影响后续 */
  }
  try {
    const review = await reviewComplianceWithLLM(result.files, opts, reviewedAt);
    if (review) {
      result.llmReview = review;
    }
  } catch {
    /* 合规审查失败，主结果照常返回 */
  }
  return result;
}
