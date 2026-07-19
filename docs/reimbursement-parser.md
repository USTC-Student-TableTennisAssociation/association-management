# 社团报销材料识别工具

从图片/PDF 报销材料中提取结构化信息，自动检查社团报销材料是否齐全完备。

## 项目结构

```
src/lib/tools/reimbursementParser.ts      # 核心工具函数（可被 AI Agent 调用）
scripts/test-reimbursement-parser.ts       # 测试入口脚本
报销材料示例/                               # 测试材料（发票、截图、审批单等）
```

## 需求背景

根据 `yaoqiu.txt`，本工具用于社团报销场景，需要从以下报销材料中提取结构化信息并检查完备性：

| # | 必要材料 | 说明 |
|---|---------|------|
| 1 | **二课审批单** | 从青春科大智慧团学平台导出 |
| 2 | **新闻稿截图** | 截图需带有青春科大网页标题（young.ustc.edu.cn） |
| 3 | **商品发票 + 购买截图** | 截图应包含物品、数量、实付款、收货地址（应在中科大校内） |
| 4 | **签领表** | 奖品签领数量应与审批单上购买数量一致 |

## 安装

```bash
pnpm install
```

OCR 依赖需要语言数据文件，首次使用时自动下载，或手动放置于项目根目录：

- `chi_sim.traineddata`（中文简体）
- `eng.traineddata`（英文）

## 使用方式

```bash
# 自动扫描 报销材料示例/ 目录
pnpm parse

# 指定文件路径
pnpm parse -- 文件1.pdf 文件2.jpg 文件3.png

# JSON 格式输出（便于 AI Agent 消费）
pnpm parse:json

# 显示 OCR 详细日志
pnpm parse -- --verbose
```

## 核心 API

### `parseReimbursementMaterials(filePaths, options?)`

**主入口函数** — 解析一组报销材料并输出结构化检查结果。

```typescript
const result = await parseReimbursementMaterials([
  '二课审批单.pdf',
  '新闻稿截图.png',
  '发票.pdf',
  '购买截图.jpg',
]);
```

### 返回类型

```typescript
type ReimbursementCheckResult = {
  isComplete: boolean;              // 材料是否齐全
  isValid: boolean;                 // 材料是否完备
  files: FileParseResult[];         // 每份文件的详细解析
  completenessCheck: {
    foundMaterials: string[];
    missingMaterials: string[];
    problematicMaterials: { material: string; issues: string[] }[];
  };
  matchResults?: MatchResult[];     // 发票与购买截图匹配结果
  summary: string;                  // 自然语言结论
};
```

### 发票与购买截图匹配

通过订单号匹配或金额匹配自动关联发票与购买截图：

```typescript
type MatchResult = {
  invoiceFile: string;
  purchaseFile: string;
  matchedBy: 'orderId' | 'amount' | 'unmatched';
  invoiceAmount: string;
  purchaseAmount: string;
  items: { itemName; invoiceQty; purchaseQty }[];
  consistent: boolean;
};
```

## 技术栈

| 工具 | 用途 |
|------|------|
| **tesseract.js** v5 | 图片 OCR 识别（中英文 `chi_sim+eng`） |
| **pdfjs-dist** v4 | PDF 文本内容提取 |
| **TypeScript** | 类型安全 |
| **tsx** | 直接运行 TypeScript |

## 改进历史

### v3 改进内容

| # | 问题 | 改进 |
|---|------|------|
| 1 | 发票商品名提取为单字"奖"、"荣" | 改进 `*xxx*商品名` 正则匹配 |
| 2 | 购买截图商品名含噪声、OCR错字 | 基于 `noSpace` 关键词启发式提取 |
| 3 | 收货地址含噪声字符 | 改进地址正则匹配优先级 |
| 4 | 签领表为实拍手写照片不可读 | 增加图片预处理，标记需人工核对 |

### v2 改进内容

| # | 问题 | 改进 |
|---|------|------|
| 1 | 新闻稿识别不完善 | 添加 URL 和页面内容关键词 |
| 2 | 发票金额未能提取 | 修复 PDF 空格分离问题 |
| 3 | 购买截图信息不全 | 改进实付款提取、地址提取 |
| 4 | 发票-截图匹配 | 通过订单号或金额自动匹配 |
| 5 | 审批单信息提取 | 完整提取预算明细 |