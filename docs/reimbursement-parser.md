# 社团报销材料识别工具

从图片/PDF 报销材料中提取结构化信息，自动检查社团报销材料是否齐全完备。

## 整体管线

```
文件输入 → 类型检测 → OCR/PDF文本提取 → 文档分类 → 字段解析 → 匹配核对 → 完备性检查 → 结果输出
```

## 技术架构

### 1. 文本提取层

```
              ┌─────────────────────┐
              │   extractText()     │ ← 入口
              └────────┬────────────┘
                       │
        ┌──────────────┴──────────────┐
        │                             │
   detectFileType()             按扩展名判断
        │                             │
   ┌────┴──────────┐         ┌───────┴──────────┐
   │   PDF (.pdf)  │         │  图片 (.jpg/.png) │
   └────┬──────────┘         └───────┬──────────┘
        │                             │
extractTextFromPdf()         extractTextFromImage()
   pdfjs-dist 逐页解析           ┌─ tesseract.js (chi_sim+eng)
   TextContent 拼接              │   ├─ 中文字符≥10 → 直接返回
                                 │   └─ 太少 → 进入预处理
                                 ├─ sharp 图片预处理
                                 │   ├─ grayscale → normalize
                                 │   ├─ modulate(brightness:1.1, contrast:1.3)
                                 │   └─ sharpen → 二次OCR
                                 └─ 仍失败 → 英文eng回退OCR
```

**OCR 降级策略（三层回退）：**
1. `chi_sim+eng` 基础 OCR → 中文 ≥ 10 个字符 → 直接返回
2. sharp 预处理（灰度+对比度+锐化）→ 再次 `chi_sim+eng` OCR
3. 英文 `eng` 回退 OCR（保底兜底）

### 2. 文档分类层

通过**关键词打分机制**将文件分类为 8 种文档类型：

| 策略 | 权重 | 示例 |
|------|------|------|
| 内容关键词匹配 | ×2/次 | 文本出现 "发票" 一次 → 2分 |
| 文件名关键词 | ×10/次 | 文件名含 "发票" → 10分 |
| 文件名直接匹配 | +15~20 | 文件名含"审批单" → 额外+20分 |
| 置信度排序 | — | 取最高分类型，无匹配 → "未知" |

**8种文档类型：** 二课审批单 / 发票 / 购买截图 / 新闻稿截图 / 签领表 / 荣誉证书 / 其他 / 未知

### 3. 金额归一化层

解决 OCR 和 PDF 解析中的两类核心噪声：

| 问题 | 示例 | 处理 |
|------|------|------|
| PDF 空格分离数字 | `¥ 1 0. 8 9` | `preprocessAmounts()` 正则去空格归一 |
| OCR ¥→Y 混淆 | `Y11`、`金Y8` | 单字母 Y/y 在数字前 → 替换为 ¥ |
| 无小数点金额 | 截图 `129` vs 发票 `129.00` | `normalizeAmount(raw, autoDecimal)` 参数控制 |
| 金额拼接排版 | `¥ 4 2 . 7 7` | 去空格 + 保留一个小数点 + 保留2位小数 |

**金额提取优先级：** 价税合计 > 实付款 > 商品总价 > 预算金额 > 合计 > 总计 > 任何 `¥XX.XX`

### 4. 字段提取层（按文档类型）

#### 发票 PDF

| 字段 | 函数 | 策略 |
|------|------|------|
| 价税合计/税额/税前 | `extractInvoiceAmounts()` | `¥XX.XX` 顺序推演：第1个=税前、第2个=税额、第3个=价税合计 |
| 发票号 | `extractInvoiceNumber()` | 匹配"发票号码："后的16-20位数字 |
| 商品名+数量 | `extractInvoiceItems()` | `*xxx*商品名` 正则，清理空格拼接 |
| 开票日期 | `extractDate()` | 年/月/日 → YYYY-MM-DD |
| 销售方 | `extractSellerName()` | 关键词直接匹配 + 公司名模式"XX有限公司" |

#### 购买截图（淘宝）

| 字段 | 函数 | 策略 |
|------|------|------|
| 实付款/总价/优惠 | `extractAmountByPriority()` | 匹配"实付款：¥XX"等标签 |
| 商品名+数量 | `extractPurchaseItems()` | **最复杂模块，见下方详解** |
| 收货地址 | `extractAddressAndRecipient()` | `noSpace` 后匹配"中国科学技术大学...号楼" |
| 订单号 | `extractOrderId()` | 匹配"订单"后的19位数字 |
| 商家 | `extractMerchantName()` | 匹配"旗舰店"/"专卖店"模式 |

#### 购买截图商品提取（`extractPurchaseItems`）— 最复杂的启发式模块

淘宝界面 OCR 质量极差：价格标记混入商品名、同一商品被拆成多行。采用**去空格 + 关键字组合**的启发式策略：

```
noSpace = text.replace(/\s+/g, '')   ← 去空格扁平化

关键字组合检测:

  (1) 金属 + 乒乓 → 合并为1个商品
      从 "金属" 截到 "七...奖牌" 结束
      清理价格噪声: v¥72, 金Y8, ¥72
      → "金属奖牌定制奖杯篮球足球七彩-乒乓球奖牌"

  (2) 金属 only   → 截取 "金属" 到下一个 ¥ 记号
  (3) 乒乓 only   → 截取 "七"/"彩" 到下一个标记符
  (4) 荣誉证书    → 截取 "荣誉" 到 ¥ 记号，去除 ES/小尾缀
  (5) 条蛋布      → 横幅 OCR 质量极差，直接用保底名 "横幅布条"
```

**数量分配策略：**

```
1. "共N件"    → N 作为总数量（最优先，淘宝订单明确标注）
2. "xN" 标记  → 取 max(所有xN) 作为总数量
3. 上述都无   → 每个商品 qty=1（保底）

单商品 → 全部数量给它
多商品 → 平分（最后一件向上取整）
```

#### 二课审批单 PDF

| 字段 | 函数 | 策略 |
|------|------|------|
| 预算明细 | `extractBudgetItems()` | 匹配 `预算金额 品目 数量 单价 总金额` 模式 |
| 项目名称 | `extractProjectName()` | 匹配"项目名称"后的文本 |
| 组织方 | `extractProjectName()` 同上 | — |

#### 新闻稿截图

| 字段 | 函数 | 策略 |
|------|------|------|
| 发布日期 | `extractDate()` | 匹配"发布时间："格式 |

#### 签领表

| 字段 | 函数 | 策略 |
|------|------|------|
| 签领条目 | `extractSignItems()` | 尝试匹配"中文名 x数字"模式，但效果有限 — 实拍手写 OCR 死局 |

### 5. 匹配与核对层

#### 发票 ↔ 购买截图匹配（`matchInvoicesAndPurchases`）

```
1. 订单号匹配:   发票 rawText 包含购买截图的19位订单号 → matchedBy='orderId'
2. 金额匹配:     价税合计 ≈ 实付款 (Math.abs差<0.5)  → matchedBy='amount'
3. 无匹配:       any                                   → matchedBy='unmatched'
```

#### 商品模糊匹配（`buildMatchedItems`）

发票商品名与购买截图商品名做双向 `includes` 匹配，`filter` + `reduce` 汇总所有匹配项数量（而非 `find` 只取第一个）。

#### 金额一致性比较（`amountsEqual`）

`parseFloat` 比较，容差 < 0.01，处理 `"129"` vs `"129.00"` 等价。

### 6. 完备性检查层（`checkCompleteness`）

4 种必要材料各有专门校验规则：

| 材料 | 校验规则 |
|------|---------|
| **二课审批单** | 总额可否提取？预算明细是否为空？ |
| **新闻稿截图** | 是否含"青春科大"/"young.ustc.edu.cn"/"社团风采"？ |
| **商品发票** | 金额？发票号？日期？商品信息？ |
| **购买截图** | 实付金额？收货地址是否在中科大校内？ |
| **签领表** | 签领信息可否提取？（实拍图标记需人工核对） |

### 7. 审批单-签领表一致性（`checkItemConsistency`）

```
审批单可签领物品（奖牌/证书/横幅等） ←→ 签领表条目
逐项核对名称和数量，报告不一致项
```

## 关键设计决策

| 决策 | 理由 |
|------|------|
| **单文件 ~1000行** | 报销工具是独立模块，不拆分减少跳转 |
| **heuristics > ML** | 报销材料格式相对固定，关键词+正则足够 |
| **noSpace 模式** | OCR 对中文的空格插入是最大噪声源 |
| **保底名称** | 横幅OCR极差（"条蛋布"），输出可读名而非乱码 |
| **签领表标记人工** | 中文字写是 Tesseract 死穴，不识别优于误识别 |
| **sharp 可选依赖** | 预处理失败回退英文OCR，不直接报错 |
| **三层OCR回退** | 基础 → 图像增强 → 英文兜底，最大化识别成功率 |

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
| **sharp** | 图片预处理（可选，灰度+对比度+锐化） |

## 改进历史

### fix: 适配 ESM 项目结构与 pnpm 构建

| # | 问题 | 改进 |
|---|------|------|
| 1 | `import { recognize }` 在 ESM 项目中对 CJS 包报错 | 改为默认导入 `Tesseract.recognize` |
| 2 | `__dirname` 在 ESM 下报未定义 | 用 `fileURLToPath(import.meta.url)` 替代 |
| 3 | pnpm `ignoredBuiltDependencies` 与 `allowBuilds` 配置冲突 | 统一用 `allowBuilds`，移除 `ignoredBuiltDependencies` |

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