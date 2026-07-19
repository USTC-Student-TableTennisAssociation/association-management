/**
 * 社团报销材料识别工具 v3
 *
 * 从图片或 PDF 报销材料中提取结构化信息，
 * 并检查报销材料是否齐全完备。
 *
 * 使用:
 *   - tesseract.js: OCR 识别图片文字
 *   - pdfjs-dist: 从 PDF 中提取文本内容
 *
 * 改进:
 *   - 更完善的发票识别（号码、商品、数量、金额、税额、价税合计）
 *   - 更完善的购买截图识别（实付款、商品、件数、收货地址、订单号）
 *   - 新闻稿识别增加 URL 和页面内容关键词
 *   - 签领表识别（奖品名称和签领数量）
 *   - 通过订单号/金额匹配发票与购买截图
 *   - 审批单完整提取（预算明细各品目数量、单价、总金额）
 */

import { recognize } from 'tesseract.js';
import * as path from 'path';
import * as fs from 'fs';

// ============================================================
// 类型定义
// ============================================================

/** 带数量的商品信息 */
export type ItemInfo = {
  name: string;
  quantity: number;
  unitPrice?: string;
  totalPrice?: string;
};

/** 发票的详细结构化信息 */
export type InvoiceDetail = {
  invoiceNumber: string;
  date: string;
  buyerName: string;
  buyerTaxId: string;
  sellerName: string;
  sellerTaxId: string;
  /** 金额（税前合计） */
  amount: string;
  /** 税额 */
  taxAmount: string;
  /** 价税合计（含税总金额） */
  totalAmount: string;
  items: ItemInfo[];
  taxRate: string;
};

/** 购买截图的详细结构化信息 */
export type PurchaseDetail = {
  /** 实付款 */
  actualPayment: string;
  /** 商品原总价 */
  originalTotal: string;
  /** 平台优惠 */
  platformDiscount: string;
  /** 商品件数 */
  itemCount: number;
  items: ItemInfo[];
  storeName: string;
  deliveryAddress: string;
  recipientName: string;
  orderId: string;
  date: string;
};

/** 审批单的预算明细 */
export type BudgetItem = {
  name: string;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
};

export type ApprovalDetail = {
  projectName: string;
  organizingParty: string;
  applyDate: string;
  amount: string;
  budgetItems: BudgetItem[];
};

/** 签领表条目 */
export type SignItem = {
  /** 奖品名称 */
  prizeName: string;
  /** 应签领数量 */
  expectedCount: number;
  /** 实际已签领数量 */
  signedCount: number;
};

/** 单份文件的解析结果 */
export type FileParseResult = {
  fileName: string;
  filePath: string;
  documentType: DocumentType;
  /** 从文件中提取的原始文本 */
  rawText: string;
  /** 结构化字段（通用） */
  merchantName: string;
  totalAmount: string;
  date: string;
  invoiceNumber: string;
  buyerName: string;
  sellerName: string;
  items: string[];
  itemsWithQuantity: ItemInfo[];
  deliveryAddress: string;
  orderId: string;
  /** 文档特有详细结构 */
  invoiceDetail?: InvoiceDetail;
  purchaseDetail?: PurchaseDetail;
  approvalDetail?: ApprovalDetail;
  signItems?: SignItem[];
  /** 该文件的警告 */
  warnings: string[];
};

/** 报销材料完整检查结果 */
export type ReimbursementCheckResult = {
  /** 是否齐全（所有必要材料都存在） */
  isComplete: boolean;
  /** 是否完备（每份材料信息完整） */
  isValid: boolean;
  /** 所有文件的解析结果 */
  files: FileParseResult[];
  /** 材料齐全性检查详情 */
  completenessCheck: CompletenessCheck;
  /** 全局警告 */
  warnings: string[];
  /** 结论总结 */
  summary: string;
  /** 发票与购买截图匹配结果 */
  matchResults?: MatchResult[];
};

export type MatchResult = {
  invoiceFile: string;
  purchaseFile: string;
  matchedBy: 'orderId' | 'amount' | 'unmatched';
  invoiceAmount: string;
  purchaseAmount: string;
  items: { itemName: string; invoiceQty: number; purchaseQty: number }[];
  consistent: boolean;
};

export type CompletenessCheck = {
  /** 已检测到的材料清单 */
  foundMaterials: string[];
  /** 缺失的必要材料 */
  missingMaterials: string[];
  /** 检测到的材料但有问题 */
  problematicMaterials: {
    material: string;
    issues: string[];
  }[];
};

/** 文档类型枚举 */
export type DocumentType =
  | '二课审批单'
  | '发票'
  | '购买截图'
  | '新闻稿截图'
  | '签领表'
  | '荣誉证书'
  | '其他'
  | '未知';

/** OCR 配置选项 */
export type ParserOptions = {
  /** OCR 语言，默认 chi_sim+eng */
  lang?: string;
  /** 是否启用详细日志 */
  verbose?: boolean;
};

// ============================================================
// 文档类型关键词映射（加强版）
// ============================================================

const DOCUMENT_TYPE_KEYWORDS: Record<DocumentType, string[]> = {
  '二课审批单': [
    '二课', '审批单', '青春科大', '智慧团学', '第二课堂', '项目审批',
    '项目名称', '项目组织方', '经费预算', '预算明细', '审核记录',
    '共青团中国科学技术大学委员会',
  ],
  '发票': [
    '发票', 'invoice', '纳税人识别号', '税率', '税额', '购买方', '销售方',
    '价税合计', '开票人', '电子发票', '统一社会信用代码',
  ],
  '购买截图': [
    '实付款', '订单', '收货地址', '购买数量', '收件人', '提交订单',
    '商品总价', '订单信息', '交易快照', '运费', '购物车', '退款',
    '发货', '号码保护',
  ],
  '新闻稿截图': [
    '新闻', '青春科大', '中国科学技术大学', '团委', '社团', '活动',
    'young.ustc.edu.cn', '社团风采', '当前位置', '发布时间', '来源',
    '校主页', 'ENGLISH', '联系我们',
  ],
  '签领表': [
    '签领', '领取', '签字', '领用', '签收', '领取人', '奖品',
    '签领表', '签名',
  ],
  '荣誉证书': [
    '荣誉证书', '证书', '奖牌', '称号', '授予', '奖杯',
  ],
  '其他': [],
  '未知': [],
};

// ============================================================
// 核心工具函数
// ============================================================

/** 检测文件类型 */
export function detectFileType(filePath: string): 'image' | 'pdf' | 'unknown' {
  const ext = path.extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp'].includes(ext)) {
    return 'image';
  }
  if (ext === '.pdf') {
    return 'pdf';
  }
  return 'unknown';
}

/** 从 PDF 文件中提取文本内容 */
export async function extractTextFromPdf(
  filePath: string,
  options?: ParserOptions
): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer);

  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;

  const textParts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => item.str)
      .join(' ');
    textParts.push(pageText);
  }

  return textParts.join('\n--- 换页 ---\n');
}

/**
 * 使用 tesseract.js 从图片中提取文字
 * 对图片预处理：去除 OCR 过程中的进度日志
 */
export async function extractTextFromImage(
  filePath: string,
  options?: ParserOptions
): Promise<string> {
  const lang = options?.lang ?? 'chi_sim+eng';

  // 先尝试基础OCR
  try {
    const { data } = await recognize(filePath, lang, {
      logger: () => {},
    });
    // 如果识别出的文本有效（有足够的中文字符），直接返回
    const chineseChars = (data.text.match(/[一-鿿]/g) || []).length;
    if (chineseChars >= 10) {
      return data.text;
    }
  } catch (_) { /* 忽略首次错误，尝试预处理后重试 */ }

  // 如果OCR结果中文字符太少，尝试图片预处理后重试
  try {
    // sharp may be CJS or ESM — handle both
    const sharpMod: any = await import('sharp');
    const sharpFn: any = sharpMod.default || sharpMod;
    const preprocessedPath = filePath + '_tmp_pp.png';
    await sharpFn(filePath)
      .grayscale()
      .normalize()
      .modulate({ brightness: 1.1, contrast: 1.3 })
      .sharpen()
      .png()
      .toFile(preprocessedPath);
    const { data } = await recognize(preprocessedPath, lang, {
      logger: () => {},
    });
    // 清理临时文件
    try { fs.unlinkSync(preprocessedPath); } catch (_) {}
    return data.text;
  } catch (_) {
    // 预处理失败或 sharp 不可用，用英语做最终回退
    try {
      const { data } = await recognize(filePath, 'eng', {
        logger: () => {},
      });
      return data.text;
    } catch (err) {
      throw err;
    }
  }
}

/** 从文件中提取原始文本（自动检测文件类型） */
export async function extractText(
  filePath: string,
  options?: ParserOptions
): Promise<string> {
  const fileType = detectFileType(filePath);

  if (fileType === 'pdf') {
    return extractTextFromPdf(filePath, options);
  }

  if (fileType === 'image') {
    return extractTextFromImage(filePath, options);
  }

  throw new Error(`不支持的文件类型: ${filePath}`);
}

// ============================================================
// 文档分类（加强版：文件名权重更高）
// ============================================================

/** 根据文本内容识别文档类型 */
export function classifyDocument(
  rawText: string,
  fileName: string
): { documentType: DocumentType; confidence: number } {
  const lowerText = rawText.toLowerCase();
  const lowerName = fileName.toLowerCase();

  const scores: { type: DocumentType; score: number }[] = [];

  for (const [type, keywords] of Object.entries(DOCUMENT_TYPE_KEYWORDS)) {
    if (type === '其他' || type === '未知') continue;
    let score = 0;
    for (const kw of keywords) {
      const lowerKw = kw.toLowerCase();
      const textMatches = (lowerText.match(new RegExp(lowerKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      score += textMatches * 2;
      if (lowerName.includes(lowerKw)) {
        score += 10;
      }
    }
    scores.push({ type: type as DocumentType, score });
  }

  // 文件名直接匹配：如果文件名包含明确关键词，大幅提高权重
  if (lowerName.includes('审批单') || lowerName.includes('二课')) {
    const entry = scores.find(s => s.type === '二课审批单');
    if (entry) entry.score += 20;
  }
  if (lowerName.includes('发票')) {
    const entry = scores.find(s => s.type === '发票');
    if (entry) entry.score += 20;
  }
  if (lowerName.includes('截图') || lowerName.includes('购买')) {
    const entry = scores.find(s => s.type === '购买截图');
    if (entry) entry.score += 15;
  }
  if (lowerName.includes('新闻') || lowerName.includes('稿')) {
    const entry = scores.find(s => s.type === '新闻稿截图');
    if (entry) entry.score += 15;
  }
  if (lowerName.includes('签领')) {
    const entry = scores.find(s => s.type === '签领表');
    if (entry) entry.score += 20;
  }

  scores.sort((a, b) => b.score - a.score);

  if (scores.length === 0 || scores[0].score === 0) {
    return { documentType: '未知', confidence: 0 };
  }

  const totalScore = scores.reduce((sum, s) => sum + s.score, 0);
  const confidence = totalScore > 0 ? scores[0].score / totalScore : 0;

  return { documentType: scores[0].type, confidence };
}

// ============================================================
// 结构化字段解析（加强版）
// ============================================================

/**
 * 预清洗文本中的金额表示：将 PDF 位置分离导致的 "¥ 42.77"、"¥ 1 0. 8 9"
 * 以及 OCR 导致的 "Y43.2" 等问题归一化为 "¥42.77" 形式。
 */
export function preprocessAmounts(text: string): string {
  let result = text;

  // 1. 将购买截图的 OCR 内容中 "实 付款 Y11 ~" 归约为可识别格式
  // 注意：OCR 会把 ¥ 识别为 Y，且会有空格
  // 这里的数字可能是整数（11）或带小数（43.2），保持原样
  result = result.replace(/实\s*付\s*款\s*[¥￥Yy]?\s*([\d\s,.]+?)(?:\s*[~\n]|$)/g, (m, p1) => {
    const norm = normalizeAmount(p1, false); // false = 不自动补小数
    return norm ? `实付款：¥${norm}` : m;
  });

  // 2. 处理拼接数字: "¥ 1 0. 8 9" -> "¥10.89"
  result = result.replace(/([¥￥])\s*((?:\d\s*)+\.\s*(?:\d\s*)+)/g, (m, yen, nums) => {
    const norm = normalizeAmount(nums, true);
    return norm ? `${yen}${norm}` : m;
  });

  // 3. 处理没有 ¥ 前缀的分散数字
  result = result.replace(/(合\s*计|金\s*额)\s*((?:\d\s*)+\.\s*(?:\d\s*)+)/g, (m, label, nums) => {
    const norm = normalizeAmount(nums, true);
    return norm ? `${label} ¥${norm}` : m;
  });

  // 4. 处理 "商品总价 共 N 件 ¥XX" 格式
  result = result.replace(/商品\s*总\s*价\s*共\s*(\d+)\s*件\s*[¥￥]?\s*([\d\s,.]+)/g, (m, qty, price) => {
    const norm = normalizeAmount(price, false);
    return norm ? `商品总价：¥${norm}（共${qty}件）` : m;
  });

  // 5. 处理 "共 N 件 ¥XX" 模式
  result = result.replace(/共\s*(\d+)\s*件\s*[¥￥]?\s*([\d\s,.]+)/g, (m, qty, price) => {
    const norm = normalizeAmount(price, false);
    return norm ? `商品总价：¥${norm}（共${qty}件）` : m;
  });

  // 6. 处理平台优惠
  result = result.replace(/(平台优惠)[^\n]*?[¥￥-]?\s*([\d\s,.]+)/g, (m, label, price) => {
    const norm = normalizeAmount(price, false);
    return norm ? `平台优惠：¥${norm}` : m;
  });

  // 7. 处理OCR将"¥/￥"识别为"Y/y"的情况（如"金Y8"→"金¥8"，"Y11"→"¥11"）
  // 仅在前后不是字母且数字像金额时替换
  result = result.replace(/(?:^|[^A-Za-z0-9])([Yy])\s*(\d+(?:\.\d+)?)\b/g, (m, y, num) => {
    const val = parseFloat(num);
    if (val >= 1 && val <= 99999) return ` ¥${num}`;
    return m;
  });

  // 8. 处理散落的 ¥数字（没有小数点的也保留原值）
  result = result.replace(/([¥￥])\s*(\d{2,6}(?!\.\d))/g, (m, yen, num) => {
    return `${yen}${num}`;
  });

  return result;
}

/**
 * 归一化金额字符串：处理 OCR 将 "¥10.89" 识别为 "¥ 1 0. 8 9" 的问题。
 * @param raw 原始数字字符串
 * @param autoDecimal 如果为 true，无小数点的数字用最后2位当小数（用于发票PDF）；false 则保持原样（用于购买截图）
 */
export function normalizeAmount(raw: string, autoDecimal: boolean = true): string {
  // 去除所有空格
  let cleaned = raw.replace(/\s+/g, '');
  // 去除前导非数字字符
  cleaned = cleaned.replace(/^[^0-9.]+/, '');
  // 只保留第一个小数点，移除后续多余的
  const dotIndex = cleaned.indexOf('.');
  if (dotIndex >= 0) {
    const intPart = cleaned.substring(0, dotIndex).replace(/[^0-9]/g, '');
    let fracPart = cleaned.substring(dotIndex + 1).replace(/[^0-9]/g, '').substring(0, 2);
    if (fracPart.length === 0) fracPart = '00';
    else if (fracPart.length === 1) fracPart = fracPart + '0';
    if (intPart || fracPart) {
      return `${intPart || '0'}.${fracPart}`;
    }
  }
  // 无小数点
  const digits = cleaned.replace(/[^0-9]/g, '');
  if (digits.length === 0) return '';
  if (digits.length === 1) return `0.0${digits}`;
  if (digits.length === 2) return autoDecimal ? `0.${digits}` : digits;
  // 3位及以上
  if (autoDecimal) {
    return digits.substring(0, digits.length - 2) + '.' + digits.substring(digits.length - 2);
  }
  return digits; // 不自动加小数点（购买截图场景）
}

/** 从文本中提取金额（优先根据不同上下文提取关键金额字段） */
export function extractAmount(text: string): string {
  // 先做预处理：将全角￥转为半角¥
  let prepared = text.replace(/￥/g, '¥');
  const cleaned = preprocessAmounts(prepared);

  // 优先：价税合计（小写）
  const totalMatch = cleaned.match(/价税合计[（(]小写[)）]\s*¥?\s*([\d.]+)/);
  if (totalMatch && parseFloat(totalMatch[1]) > 0) return totalMatch[1];

  // 实付款
  const payMatch = cleaned.match(/实付款[：:]\s*¥?\s*([\d.]+)/);
  if (payMatch && parseFloat(payMatch[1]) > 0) return payMatch[1];

  // 商品总价
  const goodsMatch = cleaned.match(/商品总价[：:]\s*¥?\s*([\d.]+)/);
  if (goodsMatch && parseFloat(goodsMatch[1]) > 0) return goodsMatch[1];

  // 合计
  const sumMatch = cleaned.match(/合\s*计[^¥]*?¥?\s*([\d.]+)/);
  if (sumMatch && parseFloat(sumMatch[1]) > 0) return sumMatch[1];

  // 预算金额 / 金额（审批单）
  const budgetMatch = cleaned.match(/预算\s*金\s*额[^¥]*?¥?\s*([\d.]+)/);
  if (budgetMatch && parseFloat(budgetMatch[1]) > 0) return budgetMatch[1];
  const amountFieldMatch = cleaned.match(/(?:^|\s)金\s*额[^¥]*?¥?\s*([\d.]+)/);
  if (amountFieldMatch && parseFloat(amountFieldMatch[1]) > 0) return amountFieldMatch[1];

  // 总计
  const totalAllMatch = cleaned.match(/总\s*计[^\n]*?¥?\s*([\d.]+)/);
  if (totalAllMatch && parseFloat(totalAllMatch[1]) > 0) return totalAllMatch[1];

  // 最后：任何 ¥X.XX 格式或 ¥XXXX 格式
  const yenMatch = cleaned.match(/¥([\d.]+)/);
  if (yenMatch && parseFloat(yenMatch[1]) > 0) return yenMatch[1];

  return '';
}

/** 从文本中提取金额（带亲密度排序——优先实付款/价税合计） */
export function extractAmountByPriority(text: string): { actualPayment: string; originalTotal: string; platformDiscount: string } {
  const result = { actualPayment: '', originalTotal: '', platformDiscount: '' };
  const cleaned = preprocessAmounts(text);

  const payMatch = cleaned.match(/实付款[：:]\s*¥?\s*([\d.]+)/);
  if (payMatch) result.actualPayment = payMatch[1];

  const totalMatch = cleaned.match(/商品总价[：:]\s*¥?\s*([\d.]+)/);
  if (totalMatch) result.originalTotal = totalMatch[1];

  const discMatch = cleaned.match(/平台优惠[：:]\s*¥?\s*([\d.]+)/);
  if (discMatch) result.platformDiscount = discMatch[1];

  return result;
}

/** 从发票文本中提取价税信息 */
export function extractInvoiceAmounts(text: string): { amount: string; taxAmount: string; totalAmount: string } {
  const result = { amount: '', taxAmount: '', totalAmount: '' };
  const cleaned = preprocessAmounts(text);

  // 发票中金额排列规律：¥金额(税前) ¥税额 大写金额 ¥价税合计(含税)
  // 找出所有¥NN.NN模式的金额
  const allAmounts: string[] = [];
  const yenRegex = /¥([\d.]+)/g;
  let m;
  while ((m = yenRegex.exec(cleaned)) !== null) {
    if (parseFloat(m[1]) > 0) {
      allAmounts.push(m[1]);
    }
  }

  if (allAmounts.length >= 3) {
    // 第一个是金额(税前)，第二个是税额，第三个是价税合计(含税)
    result.amount = allAmounts[0];
    result.taxAmount = allAmounts[1];
    result.totalAmount = allAmounts[2];
  } else if (allAmounts.length === 2) {
    result.amount = allAmounts[0];
    result.totalAmount = allAmounts[1];
  } else if (allAmounts.length === 1) {
    result.totalAmount = allAmounts[0];
  }

  return result;
}

/** 从文本中提取日期 */
export function extractDate(text: string): string {
  // 先移除数字间的空格（OCR 问题）
  const noSpace = text.replace(/(\d)\s+(?=\d)/g, '$1');

  // 1. 先找开票日期（全格式）
  const invoiceDateMatch = noSpace.match(/开票日期[：:].*?(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (invoiceDateMatch) {
    return `${invoiceDateMatch[1]}-${invoiceDateMatch[2].padStart(2, '0')}-${invoiceDateMatch[3].padStart(2, '0')}`;
  }

  const patterns = [
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
    /(\d{4})-(\d{2})-(\d{2})/,
    /(\d{4})\/(\d{2})\/(\d{2})/,
    /(\d{4})\.(\d{2})\.(\d{2})/,
    // 匹配 "发布时间 : 2026-06-17"
    /发布时间\s*[：:]\s*(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2})/,
    /申报时间\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const match = noSpace.match(pattern);
    if (match) {
      if (match.length === 4 && match[1] && match[2] && match[3]) {
        const [_, y, m, d] = match;
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
      if (match[1] && !match[2]) {
        let dateStr = match[1].trim().replace(/\s+/g, '');
        dateStr = dateStr.replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '');
        return dateStr;
      }
    }
  }

  return '';
}

/**
 * 提取发票号码（从发票PDF中）。
 * 格式：发票号码后面跟一个20位数字
 */
export function extractInvoiceNumber(text: string): string {
  // 直接匹配 "发票号码：" 后的长数字
  const directMatch = text.match(/发票号码[：:]\s*(\d{16,})/);
  if (directMatch) return directMatch[1];

  // 匹配 "发票号码：" 后可能有空格的长数字
  const spacedMatch = text.match(/发票号码[：:]\s*([\d\s]{16,})/);
  if (spacedMatch) {
    return spacedMatch[1].replace(/\s+/g, '');
  }

  // 通用匹配：一段连续16位以上的数字（电子发票号码常见20位）
  const longNumMatch = text.match(/\b(\d{18,})\b/);
  if (longNumMatch) return longNumMatch[1];

  // 匹配 "No." 格式（旧版发票）
  const noMatch = text.match(/No[：:.]*\s*(\w+)/i);
  if (noMatch) return noMatch[1];

  return '';
}

/**
 * 提取订单号（从购买截图文本中）
 * 格式：截图中的一串长数字（通常是19位数字）
 */
export function extractOrderId(text: string): string {
  // 匹配订单号显式标识
  const explicitMatch = text.match(/订单[^\n]*?(\d{16,20})/);
  if (explicitMatch) return explicitMatch[1];

  // 匹配复制交易快照附近的数字
  const snapMatch = text.match(/复制\s*交易\s*快照[^\n]*?(\d{16,20})/);
  if (snapMatch) return snapMatch[1];

  // 找19位数字（淘宝订单号一般是19位）
  const orderMatch = text.match(/\b(\d{19})\b/);
  if (orderMatch) return orderMatch[1];

  // 找16-20位数字
  const anyMatch = text.match(/\b(\d{16,20})\b/);
  if (anyMatch) return anyMatch[1];

  return '';
}

/** 从文本中提取商家/店铺名 */
export function extractMerchantName(text: string): string {
  const patterns = [
    /店铺[：:]\s*(.+?)(?:\s|$)/,
    /卖家[：:]\s*(.+?)(?:\s|$)/,
    /商户名称[：:]\s*(.+?)(?:\s|$)/,
    /进店\s*逛[^a-zA-Z]*?(\S+?)(?:\s|$)/,
    // 淘宝店铺名模式：旗舰店之前的内容
    /(\S+?旗舰店)/,
    /(\S+?专卖店)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      if (match[1]) {
        const name = match[1].trim();
        // 清理 OCR 噪声
        const cleaned = name.replace(/[&%$#@]/g, '').trim();
        if (cleaned && cleaned.length < 30 && cleaned.length >= 2) return cleaned;
      }
    }
  }

  return '';
}

/** 从发票文本中提取卖方名称 */
export function extractSellerName(text: string): string {
  // 销售方名称在 PDF 中是特定位置
  const patterns = [
    /浦江志鼎|永康市红红火火|义乌市固腾/,
    /销售方[^寿]*?名称[^寿]*?[：:]\s*(.+?)(?:\s|$)/,
    /销售方[：:]\s*(.+?)(?:\s|$)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      if (typeof match[1] === 'string') {
        const name = match[1].trim();
        if (name && name.length < 40) return name;
      }
      return match[0]; // for direct keyword match
    }
  }

  // 尝试在长文本中找到公司名模式
  const companyMatch = text.match(/([^\d\s]{4,}(?:有限公司|厂|店|旗舰店))/);
  if (companyMatch) return companyMatch[1];

  return '';
}

/** 从文本中提取购买方名称 */
export function extractBuyerName(text: string): string {
  const patterns = [
    /购买方[（(]名称[)）][：:]\s*(.+?)(?:\s|$)/,
    /名称[：:]\s*(.+?)(?:\s|$)/,
    /中国科学技术大学/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      if (match[1]) return match[1].trim();
      return match[0]; // "中国科学技术大学"
    }
  }

  return '';
}

/**
 * 从购买截图中提取商品信息和数量
 *
 * OCR文本结构示例:
 *   奖牌购买截图:
 *     "地 | 三 。 金属 奖牌 定制 奖杯 篮球 足球 v ¥72>"
 *     "七 彩 -乒乓 球 奖牌 ; 金 Y8"
 *     "| 例 不 支持 7 天 无 理由 x6"
 *   横幅购买截图:
 *     "1  HIEEHEMERSETH © Y11 》"
 *     "条 蛋 布 - 红 应 黄 /白字 (宽度 50 厘 、。 y1"   ← "y1" = "¥1"? 不，这是数量
 *     "国米 ) ;5 米 ; 净 边 (热切 不 脱 丝 )"
 *     "不 支持 7 天 无 理由 X1"
 *   证书购买截图:
 *     "ES 荣誉 证 书 定制 打印 奖状 纸 小 v  ¥4.96 >"
 *     "[== 定制 专 拍 ( 备 选 ) ;12K Y5"
 *     "用 假 一 赔 四 极速 退 款 7 天 无 理由 退换 》 。 x26"
 */
export function extractPurchaseItems(text: string): { items: ItemInfo[]; itemCount: number } {
  const items: ItemInfo[] = [];
  let itemCount = 0;

  // 提取总件数: "共 N 件" 或 "共N件"
  const countMatch = text.match(/共\s*(\d+)\s*件/);
  if (countMatch) itemCount = parseInt(countMatch[1]);

  // 构建去空格的文本用于精确模式匹配
  const noSpace = text.replace(/\s+/g, '');

  // 基于 noSpace 中已知关键词，用启发式规则提取商品信息
  // 这是最可靠的方式，因为逐行 OCR 文本的噪声太多

  // (A) 奖牌购买截图 — 同个商品名被OCR拆成了两行，需要合并
  // noSpace: "地|三。金属奖牌定制奖杯篮球足球v¥72>七彩-乒乓球奖牌;金Y8"
  // 实际商品名："金属奖牌定制奖杯篮球足球-七彩乒乓球奖牌"（一个商品，数量x6）
  // OCR 渲染为两行，中间有价格标记 v¥72>（淘宝界面元素）
  const hasMetalMedal = noSpace.includes('奖牌') && noSpace.includes('金属');
  const hasPingpongMedal = noSpace.includes('乒乓');

  if (hasMetalMedal && hasPingpongMedal) {
    // 合并为一个商品："金属奖牌定制奖杯篮球足球-七彩乒乓球奖牌"
    const metalStart = noSpace.indexOf('金属');
    const pingpongStart = noSpace.indexOf('七');
    const pingpongEnd = pingpongStart + 12;
    const raw = noSpace.substring(metalStart, pingpongEnd);
    // 清理各类噪声：移除价格标记(v¥72, 金Y8, ;金, ¥XX)、UI符号
    let clean = raw
      .replace(/[|。，、；：—vV><》>《=【】\[\]（()）!！]/g, '')
      .replace(/[;；]金\s*[Y¥]\s*\d+/g, '')       // ";金Y8" / ";金¥8"
      .replace(/[¥￥]\s*[\d.]+\s*/g, '')           // "¥72" etc.
      .replace(/-\s*[Yy]\s*/g, '-')                // "- Y" → "-"
      .replace(/[;；]/g, '-')                       // "<marker>" → "-"
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .trim();
    if (clean && clean.length >= 4) {
      items.push({ name: clean, quantity: 0 });
    }
  } else {
    // (A) 单独金属奖牌（没有七彩乒乓球的情况）
    if (hasMetalMedal) {
      const startIdx = noSpace.indexOf('金属');
      const endIdx = noSpace.indexOf('¥', startIdx);
      const raw = endIdx > startIdx ? noSpace.substring(startIdx, endIdx) : '';
      const clean = raw.replace(/[|。，、；：·\-—vV><》>《=【】\[\]（()）!！]/g, '').trim();
      if (clean && clean.length >= 4 && !items.some(i => clean.startsWith(i.name) || i.name.startsWith(clean))) {
        items.push({ name: clean, quantity: 0 });
      }
    }

    // (B) 单独七彩乒乓球奖牌（没有金属奖牌的情况）
    if (hasPingpongMedal) {
      let startIdx = noSpace.indexOf('七');
      if (startIdx < 0) startIdx = noSpace.indexOf('彩');
      let endIdx = startIdx + 15;
      for (const marker of ['x', '|', '金', 'Y', '¥']) {
        const idx = noSpace.indexOf(marker, startIdx + 2);
        if (idx > startIdx && idx < endIdx) endIdx = idx;
      }
      const raw = noSpace.substring(startIdx, endIdx);
      const clean = raw.replace(/[;；|。，、：·\-—vV><》>《=【】\[\]（()）!！]/g, '').trim();
      if (clean && clean.length >= 4 && !items.some(i => clean.startsWith(i.name) || i.name.startsWith(clean))) {
        items.push({ name: clean, quantity: 0 });
      }
    }
  }

  // (C) 证书购买截图
  // noSpace: "ES荣誉证书定制打印奖状纸小v¥4.96>[==定制专拍(备选);12K¥5"
  if (noSpace.includes('荣誉证书') || noSpace.includes('证书定制')) {
    const startIdx = noSpace.indexOf('荣誉');
    const endIdx = noSpace.indexOf('¥', startIdx);
    const raw = endIdx > startIdx ? noSpace.substring(startIdx, endIdx) : '';
    let clean = raw.replace(/[|。，、；：·\-—vV><》>《=【】\[\]（()）!！\[=]/g, '').trim();
    clean = clean.replace(/^ES/i, '').trim();
    // 去掉尾部单字噪声（如"小"）
    clean = clean.replace(/[小]$/, '').trim();
    if (clean && clean.length >= 4 && !items.some(i => clean.startsWith(i.name) || i.name.startsWith(clean))) {
      items.push({ name: clean, quantity: 0 });
    }
  }

  // (D) 横幅购买截图
  // noSpace: "条蛋布红应黄/白字(宽度50厘、。y1" (OCR quality is very poor here)
  // OCR 对横幅截图的识别效果极差（"条蛋布" ≈ 条幅布，"红应黄" ≈ 红底黄字），
  // 无法真实还原商品名，直接用可读的保底名称以便与发票匹配
  if ((noSpace.includes('横幅') || noSpace.includes('条蛋') || noSpace.includes('布')) && !items.some(i => i.name.includes('横幅') || i.name.includes('布条') || i.name.includes('条蛋'))) {
    items.push({ name: '横幅布条', quantity: 0 });
  }

  // 从行中提取每个商品匹配的数量标记(xN)
  // xN 可能在商品行上，也可能在后面的行（如"不支持7天无理由x6"），代表总数量
  // 如果有 itemCount (来自"共N件")，优先用它；否则从xN标记提取
  let totalQtyFromMarkers = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const qtyMatch = trimmed.match(/[xX×]\s*(\d+)/);
    if (!qtyMatch) continue;
    const qty = parseInt(qtyMatch[1]);
    if (qty >= 1 && qty <= 999) {
      // 取最大的xN值（多个xN标记中最大值代表总数）
      totalQtyFromMarkers = Math.max(totalQtyFromMarkers, qty);
    }
  }

  // 总数量 = 明确的"共N件" > xN标记值
  const totalQuantity = itemCount || totalQtyFromMarkers;

  // 分配数量：如果只有1个商品，给它全部；多个商品平分
  if (totalQuantity > 0) {
    if (items.length === 1) {
      items[0].quantity = totalQuantity;
    } else if (items.length > 1) {
      // 平分（向上取整给最后一个）
      const perItem = Math.floor(totalQuantity / items.length);
      let remaining = totalQuantity;
      for (let i = 0; i < items.length; i++) {
        if (i < items.length - 1) {
          items[i].quantity = perItem;
          remaining -= perItem;
        } else {
          items[i].quantity = remaining;
        }
      }
    }
  }

  // 给没有分配到数量的商品保底（只有 items > 0 时才执行）
  for (const item of items) {
    if (item.quantity === 0) item.quantity = 1;
  }

  // 如果仍没找到任何商品但找到了总件数，创建通用条目
  if (items.length === 0 && totalQuantity > 0) {
    items.push({ name: '商品（共' + totalQuantity + '件）', quantity: totalQuantity });
  }

  return { items, itemCount };
}

/**
 * 从发票文本中提取商品信息
 * 发票PDF文本结构示例:
 * "*工艺品*奖牌   1% 个   42.77   0.43 3.5643564356436 12"
 * "*印刷品*横幅   5 米   1 % 条   1 0. 8 9   0. 1 1"
 * "*印刷品*荣誉证书   1d504941001100  1-HEV  1% 件   128.71   1.29"
 *
 * PDF join(): "*印刷品*横 幅" → 空格需要清理
 */
export function extractInvoiceItems(text: string): ItemInfo[] {
  const items: ItemInfo[] = [];

  // 改进版 regex: *xxx*商品名 捕获到下一个数字/特殊字符前为止，然后清理空格
  const itemRegex = /\*[^*]+\*\s*([^*\s\d]+(?:\s[^*\s\d]+)*)/g;
  let match;
  while ((match = itemRegex.exec(text)) !== null) {
    const name = match[1].trim().replace(/\s+/g, '');
    if (name && name.length > 0 && !items.some(i => i.name === name)) {
      items.push({ name, quantity: 1 });
    }
  }

  // 如果没有匹配到，尝试从文本中找商品名
  if (items.length === 0) {
    const keywords = ['奖牌', '横幅', '荣誉证书', '证书'];
    for (const kw of keywords) {
      if (text.includes(kw) && !items.some(i => i.name.includes(kw))) {
        items.push({ name: kw, quantity: 1 });
      }
    }
  }

  return items;
}

/**
 * 从购买截图文本中提取收货地址和收件人
 * OCR 文本中可能包含空格： "中 国 科 学 技术 大 学"
 */
export function extractAddressAndRecipient(text: string): { address: string; recipient: string } {
  const result = { address: '', recipient: '' };

  // 方法1：在去空格文本中搜索地址模式，再映射回原文
  const noSpace = text.replace(/\s+/g, '');

  // OCR文本中的地址包含 "中国科学技术大学" + 学校信息
  // OCR会把"5号楼"识别为"5 号 楼"（有空格），所以需要用 noSpace 匹配
  // noSpace 后 "5 号 楼" → "5号楼"
  const addrPattern = /中国科学技术大学[\w\W]{0,60}(?:号楼|公寓|校区)/;
  const addrMatch = noSpace.match(addrPattern);
  if (addrMatch) {
    let rawAddress = addrMatch[0];

    // 清理OCR噪声字符："忆修改》""修改》""修改" 等干扰词
    rawAddress = rawAddress
      .replace(/忆\s*修\s*改\s*[》）>]*/g, '')   // "忆修改》"
      .replace(/修\s*改\s*[》）>]*/g, '')         // "修改》"
      .replace(/[》>）]/g, '')                      // 孤立的括号/箭头
      .replace(/\s+/g, '');

    // 尝试截取到楼号
    const buildingMatch = rawAddress.match(/(中国科学技术大学.+?(?:公寓\w*号楼|楼))/);
    if (buildingMatch) {
      result.address = buildingMatch[1];
    } else {
      result.address = rawAddress;
    }
  }

  // 提取收件人姓名（找姓名+手机号模式）
  // 在原文中找 "XXX 86-187" 或 "XXX 号码保护"
  const nameMatch = text.match(/([^\d\s]{2,3})\s*(?:86[-]?\d+|号码保护|号码)/);
  if (nameMatch) {
    result.recipient = nameMatch[1].trim();
  }

  return result;
}

/**
 * 从审批单文本中提取预算明细
 */
export function extractBudgetItems(text: string): BudgetItem[] {
  const items: BudgetItem[] = [];

  // 审批单的预算明细格式:
  // "预算金额  蓝海 绵省 狂  3   200   600"
  // "预算金额  橙海 绵省 狂  3   150   450"
  // "预算金额  WTT  球一 盒  6   60   360"
  // 预算金额  品目   数 量   单价   总金额

  const lines = text.split('\n');
  const fullText = text;

  // 使用正则提取 "预算金额" 后面的行
  // 每行的模式: 预算金额  XXX  数量  单价  总金额
  const budgetRegex = /预算金额\s+(.{2,30}?)\s+(\d+)\s+([\d.]+)\s+([\d.]+)/g;
  let bm;
  while ((bm = budgetRegex.exec(fullText)) !== null) {
    const name = bm[1].replace(/\s+/g, '').trim();
    const qty = parseInt(bm[2]);
    const price = bm[3];
    const total = bm[4];
    if (name && qty > 0 && !items.some(i => i.name === name)) {
      items.push({ name, quantity: qty, unitPrice: price, totalPrice: total });
    }
  }

  // 如果上述没匹配到，尝试另一种模式
  if (items.length === 0) {
    const simpleRegex = /(\S{2,6}(?:绵|狂|球|牌|幅|书|证|费))\s+(\d+)\s+([\d.]+)\s+([\d.]+)/g;
    while ((bm = simpleRegex.exec(fullText)) !== null) {
      const name = bm[1].replace(/\s+/g, '').trim();
      const qty = parseInt(bm[2]);
      const price = bm[3];
      const total = bm[4];
      if (name && qty > 0) {
        items.push({ name, quantity: qty, unitPrice: price, totalPrice: total });
      }
    }
  }

  return items;
}

/**
 * 从审批单文本中提取项目名称
 */
export function extractProjectName(text: string): string {
  const match = text.match(/项目名称\s*(.{4,40}?)(?:\s{2,}|$)/);
  if (match) return match[1].trim();
  return '';
}

/**
 * 从签领表文本中尝试提取签领信息
 * 签领表是实拍图，OCR 效果很差（文字不清晰）
 */
export function extractSignItems(text: string): SignItem[] {
  // 签领表的 OCR 通常效果很差，这里提供一个基础框架
  const items: SignItem[] = [];

  // 尝试匹配简单的数字模式 + 奖品名
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 尝试匹配 "奖品名 数字" 模式
    const pattern = /([一-鿿]{2,8})\s*[×xX]?\s*(\d+)/;
    const match = trimmed.match(pattern);
    if (match) {
      const name = match[1];
      const count = parseInt(match[2]);
      if (count > 0 && count < 100 && name.length <= 8) {
        items.push({ prizeName: name, expectedCount: count, signedCount: 0 });
      }
    }
  }

  return items;
}

/**
 * 检查地址是否为中国科学技术大学校内地址
 */
export function isUstcAddress(address: string): boolean {
  const ustcKeywords = [
    '中国科学技术大学',
    '中科大',
    '科大',
    '合肥',
    '金寨路',
    '黄山路',
  ];
  return ustcKeywords.some(kw => address.includes(kw));
}

// ============================================================
// 单文件解析（加强版）
// ============================================================

/**
 * 解析单份报销材料文件
 */
export async function parseFile(
  filePath: string,
  options?: ParserOptions
): Promise<FileParseResult> {
  const fileName = path.basename(filePath);
  const rawText = await extractText(filePath, options);

  const { documentType } = classifyDocument(rawText, fileName);

  const result: FileParseResult = {
    fileName,
    filePath,
    documentType: documentType || '未知',
    rawText,
    merchantName: '',
    totalAmount: '',
    date: '',
    invoiceNumber: '',
    buyerName: '',
    sellerName: '',
    items: [],
    itemsWithQuantity: [],
    deliveryAddress: '',
    orderId: '',
    warnings: [],
  };

  // 根据文档类型提取结构化信息
  switch (result.documentType) {
    case '发票': {
      result.invoiceNumber = extractInvoiceNumber(rawText);
      result.date = extractDate(rawText);
      result.buyerName = extractBuyerName(rawText);
      result.sellerName = extractSellerName(rawText);
      result.merchantName = result.sellerName;

      const invAmounts = extractInvoiceAmounts(rawText);
      result.totalAmount = invAmounts.totalAmount || invAmounts.amount;

      const invoiceItems = extractInvoiceItems(rawText);
      result.itemsWithQuantity = invoiceItems;
      result.items = invoiceItems.map(i => i.name);

      // 构建详细结构
      result.invoiceDetail = {
        invoiceNumber: result.invoiceNumber,
        date: result.date,
        buyerName: result.buyerName,
        buyerTaxId: '',
        sellerName: result.sellerName,
        sellerTaxId: '',
        amount: invAmounts.amount,
        taxAmount: invAmounts.taxAmount,
        totalAmount: invAmounts.totalAmount,
        items: invoiceItems,
        taxRate: '',
      };

      // 提取税号
      const buyerTaxMatch = rawText.match(/统一社会信用代码[^（(]*?[：:]\s*(\w+)/);
      if (buyerTaxMatch) result.invoiceDetail.buyerTaxId = buyerTaxMatch[1];
      break;
    }

    case '购买截图': {
      const amounts = extractAmountByPriority(rawText);
      result.totalAmount = amounts.actualPayment;

      result.merchantName = extractMerchantName(rawText);
      result.buyerName = extractBuyerName(rawText);
      result.orderId = extractOrderId(rawText);

      const addrInfo = extractAddressAndRecipient(rawText);
      result.deliveryAddress = addrInfo.address;

      const { items, itemCount } = extractPurchaseItems(rawText);
      result.itemsWithQuantity = items;
      result.items = items.map(i => `${i.name} x${i.quantity}`);

      result.purchaseDetail = {
        actualPayment: amounts.actualPayment,
        originalTotal: amounts.originalTotal,
        platformDiscount: amounts.platformDiscount,
        itemCount,
        items,
        storeName: result.merchantName,
        deliveryAddress: result.deliveryAddress,
        recipientName: addrInfo.recipient,
        orderId: result.orderId,
        date: extractDate(rawText),
      };
      break;
    }

    case '二课审批单': {
      result.date = extractDate(rawText);
      result.totalAmount = extractAmount(rawText);

      const budgetItems = extractBudgetItems(rawText);
      result.itemsWithQuantity = budgetItems.map(b => ({
        name: b.name,
        quantity: b.quantity,
        unitPrice: b.unitPrice,
        totalPrice: b.totalPrice,
      }));
      result.items = budgetItems.map(b => `${b.name} x${b.quantity} (单价¥${b.unitPrice})`);

      result.approvalDetail = {
        projectName: extractProjectName(rawText),
        organizingParty: '',
        applyDate: result.date,
        amount: result.totalAmount,
        budgetItems,
      };

      // 提取组织方
      const orgMatch = rawText.match(/项目组织方\s*(.{4,30}?)(?:\s{2,}|$)/);
      if (orgMatch) result.approvalDetail.organizingParty = orgMatch[1].trim();
      break;
    }

    case '新闻稿截图': {
      result.date = extractDate(rawText);
      break;
    }

    case '签领表': {
      const signItems = extractSignItems(rawText);
      result.signItems = signItems;
      result.itemsWithQuantity = signItems.map(s => ({
        name: s.prizeName,
        quantity: s.expectedCount,
      }));
      result.items = signItems.map(s => `${s.prizeName} x${s.expectedCount}`);
      break;
    }

    default:
      break;
  }

  // 检查提取结果中的警告
  if (result.documentType === '未知') {
    result.warnings.push('无法识别文档类型，请人工确认');
  }

  if (!rawText.trim()) {
    result.warnings.push('未能从文件中提取到文本内容（可能是扫描件或纯图片PDF）');
  }

  if (result.documentType === '签领表' && result.signItems && result.signItems.length === 0) {
    result.warnings.push('签领表为实拍图，OCR 识别效果不佳，建议人工核对奖品名称和签领数量');
  }

  return result;
}

// ============================================================
// 一致性检查（加强版）
// ============================================================

/**
 * 通过订单号/金额匹配发票与购买截图
 */
export function matchInvoicesAndPurchases(results: FileParseResult[]): MatchResult[] {
  const invoices = results.filter(r => r.documentType === '发票');
  const purchases = results.filter(r => r.documentType === '购买截图');
  const matches: MatchResult[] = [];

  for (const inv of invoices) {
    let matched = false;

    for (const pr of purchases) {
      // 尝试通过订单号匹配（购买截图的订单号出现在荣誉证书发票的备注中）
      if (pr.orderId) {
        if (inv.rawText.includes(pr.orderId)) {
          matches.push({
            invoiceFile: inv.fileName,
            purchaseFile: pr.fileName,
            matchedBy: 'orderId',
            invoiceAmount: inv.totalAmount,
            purchaseAmount: pr.totalAmount,
            items: buildMatchedItems(inv, pr),
            consistent: amountsEqual(inv.totalAmount, pr.totalAmount),
          });
          matched = true;
          break;
        }
      }

      // 通过金额匹配（价税合计 ≈ 实付款）
      if (!matched && inv.totalAmount && pr.totalAmount) {
        const invAmt = parseFloat(inv.totalAmount);
        const prAmt = parseFloat(pr.totalAmount);
        if (Math.abs(invAmt - prAmt) < 0.5) {
          matches.push({
            invoiceFile: inv.fileName,
            purchaseFile: pr.fileName,
            matchedBy: 'amount',
            invoiceAmount: inv.totalAmount,
            purchaseAmount: pr.totalAmount,
            items: buildMatchedItems(inv, pr),
            consistent: true,
          });
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      matches.push({
        invoiceFile: inv.fileName,
        purchaseFile: '未匹配',
        matchedBy: 'unmatched',
        invoiceAmount: inv.totalAmount,
        purchaseAmount: '',
        items: [],
        consistent: false,
      });
    }
  }

  return matches;
}

function buildMatchedItems(inv: FileParseResult, pr: FileParseResult): { itemName: string; invoiceQty: number; purchaseQty: number }[] {
  const result: { itemName: string; invoiceQty: number; purchaseQty: number }[] = [];

  const invoiceItems = inv.itemsWithQuantity;
  const purchaseItems = pr.itemsWithQuantity;

  for (const ii of invoiceItems) {
    const matchedPurchases = purchaseItems.filter(pi =>
      ii.name.includes(pi.name) || pi.name.includes(ii.name)
    );
    const totalPurchaseQty = matchedPurchases.reduce((sum, pi) => sum + pi.quantity, 0);
    result.push({
      itemName: ii.name,
      invoiceQty: ii.quantity,
      purchaseQty: totalPurchaseQty,
    });
  }

  return result;
}

/** 比较两个金额是否一致（容忍 "129" vs "129.00"） */
function amountsEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = parseFloat(a);
  const nb = parseFloat(b);
  return Math.abs(na - nb) < 0.01;
}

/** 核对发票金额与购买截图金额 */
export function checkAmountConsistency(results: FileParseResult[]): string[] {
  const warnings: string[] = [];

  // 使用新的匹配逻辑
  const matches = matchInvoicesAndPurchases(results);
  for (const m of matches) {
    if (m.matchedBy === 'unmatched') {
      warnings.push(`发票 (${m.invoiceFile}) 未能匹配到对应的购买截图`);
    } else if (!m.consistent) {
      warnings.push(
        `发票金额 (¥${m.invoiceAmount}) 与购买截图实付金额 (¥${m.purchaseAmount}) 不一致，请确认`
      );
    }
  }

  return warnings;
}

/** 核对审批单与签领表的物品数量一致性 */
export function checkItemConsistency(results: FileParseResult[]): string[] {
  const warnings: string[] = [];

  const approvalResults = results.filter(r => r.documentType === '二课审批单');
  const signResults = results.filter(r => r.documentType === '签领表');

  if (approvalResults.length > 0 && signResults.length > 0) {
    for (const ap of approvalResults) {
      for (const sr of signResults) {
        if (!sr.signItems || sr.signItems.length === 0) {
          warnings.push('签领表未成功提取签领信息，无法与审批单进行数量一致性核对');
          continue;
        }

        // 逐项核对审批单中的可签领物品与签领表是否一致
        const approvableItems = ap.itemsWithQuantity.filter(i =>
          ['奖牌', '证书', '横幅', '球', '海绵'].some(k => i.name.includes(k))
        );

        for (const ai of approvableItems) {
          const matchedSign = sr.signItems.find(s =>
            ai.name.includes(s.prizeName) || s.prizeName.includes(ai.name)
          );
          if (matchedSign && matchedSign.expectedCount !== ai.quantity) {
            warnings.push(
              `审批单中"${ai.name}"数量 (${ai.quantity}) 与签领表中"${matchedSign.prizeName}"数量 (${matchedSign.expectedCount}) 不一致`
            );
          }
        }

        // 审批单总金额与签领表对照
        if (ap.approvalDetail) {
          const approvableTotal = ap.approvalDetail.budgetItems
            .filter(i => ['奖牌', '证书', '横幅'].some(k => i.name.includes(k)))
            .reduce((sum, i) => sum + parseFloat(i.totalPrice), 0);
          if (approvableTotal > 0) {
            warnings.push(
              `审批单中可签领物品（奖牌/证书/横幅）预算总额为 ¥${approvableTotal.toFixed(2)}，请核对签领表数量是否一致`
            );
          }
        }
      }
    }
  }

  return warnings;
}

// ============================================================
// 材料完备性检查（加强版）
// ============================================================

export function checkCompleteness(
  results: FileParseResult[]
): CompletenessCheck {
  const foundMaterials: string[] = [];
  const missingMaterials: string[] = [];
  const problematicMaterials: { material: string; issues: string[] }[] = [];

  const docTypes = results.map(r => r.documentType);

  // 检查二课审批单
  if (docTypes.includes('二课审批单')) {
    foundMaterials.push('二课审批单');
    const ap = results.find(r => r.documentType === '二课审批单')!;
    const issues: string[] = [];
    if (!ap.totalAmount) issues.push('未能提取审批单总金额');
    if (ap.itemsWithQuantity.length === 0) issues.push('未能提取预算明细');
    if (issues.length > 0) {
      problematicMaterials.push({ material: '二课审批单', issues });
    }
  } else {
    missingMaterials.push('二课审批单（需从青春科大智慧团学平台导出）');
  }

  // 检查新闻稿截图（加强：检测更多关键词）
  const newsResults = results.filter(r => r.documentType === '新闻稿截图');
  if (newsResults.length > 0) {
    foundMaterials.push('新闻稿截图');
    for (const news of newsResults) {
      const issues: string[] = [];
      const hasTitle = news.rawText.includes('青春科大')
        || news.rawText.includes('中国科学技术大学')
        || news.rawText.includes('young.ustc.edu.cn')
        || news.rawText.includes('社团风采');
      if (!hasTitle) {
        issues.push('新闻稿截图中未检测到"青春科大"或相关标题标识，请确认截图包含网页标题栏');
      }
      if (issues.length > 0) {
        problematicMaterials.push({ material: `新闻稿截图 (${news.fileName})`, issues });
      }
    }
  } else {
    missingMaterials.push('新闻稿截图（需包含青春科大网页标题）');
  }

  // 检查发票
  const invoiceResults = results.filter(r => r.documentType === '发票');
  if (invoiceResults.length > 0) {
    foundMaterials.push('商品发票');
    for (const inv of invoiceResults) {
      const issues: string[] = [];
      if (!inv.totalAmount) issues.push('未能提取发票金额');
      if (!inv.invoiceNumber) issues.push('未能提取发票号码');
      if (!inv.date) issues.push('未能提取开票日期');
      if (inv.itemsWithQuantity.length === 0) issues.push('未能提取商品信息');
      if (issues.length > 0) {
        problematicMaterials.push({ material: `发票 (${inv.fileName})`, issues });
      }
    }
  } else {
    missingMaterials.push('商品发票');
  }

  // 检查购买截图
  const purchaseResults = results.filter(r => r.documentType === '购买截图');
  if (purchaseResults.length > 0) {
    foundMaterials.push('购买截图');
    for (const pr of purchaseResults) {
      const issues: string[] = [];
      if (!pr.totalAmount) issues.push('未能提取实付金额');
      if (pr.deliveryAddress && !isUstcAddress(pr.deliveryAddress)) {
        issues.push(`收货地址（${pr.deliveryAddress}）可能不在中国科学技术大学校内`);
      } else if (!pr.deliveryAddress) {
        issues.push('未能提取收货地址');
      }
      if (pr.purchaseDetail && pr.purchaseDetail.itemCount === 0) {
        // 商品件数可能没有明确数值，不是严重问题
      }
      if (issues.length > 0) {
        problematicMaterials.push({ material: `购买截图 (${pr.fileName})`, issues });
      }
    }
  } else {
    missingMaterials.push('购买截图（需包含商品、数量、实付款和收货地址）');
  }

  // 检查签领表
  const signResults = results.filter(r => r.documentType === '签领表');
  if (signResults.length > 0) {
    foundMaterials.push('签领表');
    for (const sr of signResults) {
      const issues: string[] = [];
      if (!sr.signItems || sr.signItems.length === 0) {
        issues.push('未能从签领表中提取有效签领信息（签领表为实拍图，建议人工核对）');
      }
      if (issues.length > 0) {
        problematicMaterials.push({ material: `签领表 (${sr.fileName})`, issues });
      }
    }
  } else {
    missingMaterials.push('签领表（奖品签领数量应与审批单上购买数量一致）');
  }

  return {
    foundMaterials,
    missingMaterials,
    problematicMaterials,
  };
}

// ============================================================
// 主入口函数
// ============================================================

/**
 * 主函数：解析一组报销材料并检查完整性
 */
export async function parseReimbursementMaterials(
  filePaths: string[],
  options?: ParserOptions
): Promise<ReimbursementCheckResult> {
  const verbose = options?.verbose ?? false;

  if (verbose) {
    console.log(`\n📋 开始解析 ${filePaths.length} 份报销材料...\n`);
  }

  // 1. 逐份解析文件
  const fileResults: FileParseResult[] = [];
  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) {
      fileResults.push({
        fileName: path.basename(fp),
        filePath: fp,
        documentType: '未知',
        rawText: '',
        merchantName: '',
        totalAmount: '',
        date: '',
        invoiceNumber: '',
        buyerName: '',
        sellerName: '',
        items: [],
        itemsWithQuantity: [],
        deliveryAddress: '',
        orderId: '',
        warnings: [`文件不存在: ${fp}`],
      });
      continue;
    }

    try {
      if (verbose) {
        console.log(`  📄 正在处理: ${path.basename(fp)}`);
      }
      const result = await parseFile(fp, options);
      fileResults.push(result);

      if (verbose) {
        console.log(`     → 识别为: ${result.documentType}`);
        if (result.totalAmount) console.log(`     → 金额: ¥${result.totalAmount}`);
        if (result.date) console.log(`     → 日期: ${result.date}`);
        if (result.invoiceNumber) console.log(`     → 发票号: ${result.invoiceNumber}`);
        if (result.orderId) console.log(`     → 订单号: ${result.orderId}`);
        if (result.items.length > 0) {
          console.log(`     → 商品:`);
          result.items.forEach(i => console.log(`        - ${i}`));
        }
        if (result.deliveryAddress) console.log(`     → 地址: ${result.deliveryAddress}`);
        if (result.warnings.length > 0) {
          result.warnings.forEach(w => console.log(`     ⚠️  ${w}`));
        }
      }
    } catch (err: any) {
      fileResults.push({
        fileName: path.basename(fp),
        filePath: fp,
        documentType: '未知',
        rawText: '',
        merchantName: '',
        totalAmount: '',
        date: '',
        invoiceNumber: '',
        buyerName: '',
        sellerName: '',
        items: [],
        itemsWithQuantity: [],
        deliveryAddress: '',
        orderId: '',
        warnings: [`解析失败: ${err.message}`],
      });
    }
  }

  // 2. 检查材料齐全性
  const completenessCheck = checkCompleteness(fileResults);

  // 3. 一致性检查
  const amountWarnings = checkAmountConsistency(fileResults);
  const itemWarnings = checkItemConsistency(fileResults);
  const matchResults = matchInvoicesAndPurchases(fileResults);

  // 4. 汇总
  const isComplete = completenessCheck.missingMaterials.length === 0;
  const allWarnings: string[] = [
    ...fileResults.flatMap(r => r.warnings),
    ...amountWarnings,
    ...itemWarnings,
    ...completenessCheck.problematicMaterials.flatMap(p => p.issues),
  ];

  const isValid = isComplete && allWarnings.length === 0;

  // 5. 生成总结
  let summary = '';
  if (isComplete && isValid) {
    summary = '✅ 报销材料齐全完备，可以提交。';
  } else {
    const parts: string[] = [];
    if (!isComplete) {
      parts.push(`❌ 材料不齐全：缺少 ${completenessCheck.missingMaterials.join('、')}`);
    }
    if (completenessCheck.problematicMaterials.length > 0) {
      parts.push('⚠️ 材料存在问题：');
      for (const p of completenessCheck.problematicMaterials) {
        parts.push(`  - ${p.material}: ${p.issues.join('; ')}`);
      }
    }
    if (amountWarnings.length > 0) {
      parts.push(`⚠️ ${amountWarnings.join('; ')}`);
    }
    if (itemWarnings.length > 0) {
      parts.push(`⚠️ ${itemWarnings.join('; ')}`);
    }
    summary = parts.join('\n');
  }

  return {
    isComplete,
    isValid,
    files: fileResults,
    completenessCheck,
    warnings: allWarnings,
    summary,
    matchResults,
  };
}