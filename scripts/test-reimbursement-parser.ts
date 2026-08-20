/**
 * 报销材料解析器 - 测试入口 v3
 *
 * 使用示例报销材料进行测试，输出结构化的检查结果。
 *
 * 用法:
 *   npm run parse                    # 自动扫描示例目录
 *   npm run parse -- [文件路径...]    # 指定文件
 *   npm run parse -- --verbose       # 显示详细日志
 *   npm run test:json                # JSON 格式输出
 */

import 'dotenv/config';
import {
  parseReimbursementMaterials,
  FileParseResult,
} from '../src/lib/tools/reimbursementParser';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // 解析命令行参数
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const useLLM = args.includes('--llm');

  // 获取要处理的文件列表（过滤掉选项参数）
  let filePaths: string[] = args.filter(a => !a.startsWith('--'));

  if (filePaths.length === 0) {
    // 自动扫描 报销材料示例 目录
    const sampleDir = path.resolve(__dirname, '..', '报销材料示例');
    if (fs.existsSync(sampleDir)) {
      const entries = fs.readdirSync(sampleDir);
      filePaths = entries
        .map((e: string) => path.join(sampleDir, e))
        .filter((fp: string) => {
          const ext = path.extname(fp).toLowerCase();
          return ['.png', '.jpg', '.jpeg', '.pdf'].includes(ext);
        });
      console.log(`📂 自动扫描到 ${filePaths.length} 份报销材料:\n`);
      filePaths.forEach((fp: string) => console.log(`   ${path.basename(fp)}`));
      console.log('');
    } else {
      console.error('错误: 未指定文件路径且示例目录不存在');
      console.log('用法: npm run parse -- <文件路径1> [文件路径2...]');
      process.exit(1);
    }
  }

  // 验证文件是否存在
  const validPaths = filePaths.filter((fp: string) => {
    if (!fs.existsSync(fp)) {
      console.warn(`⚠️  文件不存在，跳过: ${fp}`);
      return false;
    }
    return true;
  });

  if (validPaths.length === 0) {
    console.error('错误: 没有有效的文件');
    process.exit(1);
  }

  console.log('=' .repeat(60));
  console.log('  社团报销材料识别工具 v3');
  console.log('=' .repeat(60));
  console.log(`\n📄 共 ${validPaths.length} 份文件等待处理\n`);

  // ============================================================
  // 执行解析
  // ============================================================
  const startTime = Date.now();

  const result = await parseReimbursementMaterials(validPaths, {
    lang: 'chi_sim+eng',
    verbose,
    llm: useLLM ? { enabled: true, verbose } : undefined,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ============================================================
  // 输出结果
  // ============================================================
  console.log('\n' + '=' .repeat(60));
  console.log('  📊 解析结果报告');
  console.log('=' .repeat(60));

  // 打印每份文件的详细信息
  console.log('\n--- 📄 文件解析详情 ---\n');
  for (const file of result.files) {
    console.log(`文件: ${file.fileName}`);
    console.log(`  类型: ${file.documentType}`);
    console.log(`  金额: ${file.totalAmount ? '¥' + file.totalAmount : '（未识别）'}`);
    console.log(`  日期: ${file.date || '（未识别）'}`);
    console.log(`  发票号: ${file.invoiceNumber || '（未识别）'}`);
    console.log(`  订单号: ${file.orderId || '（未识别）'}`);
    console.log(`  商户: ${file.merchantName || '（未识别）'}`);
    console.log(`  购买方: ${file.buyerName || '（未识别）'}`);
    console.log(`  销售方: ${file.sellerName || '（未识别）'}`);
    console.log(`  收货地址: ${file.deliveryAddress || '（未识别）'}`);

    // 显示带数量的商品信息
    if (file.itemsWithQuantity && file.itemsWithQuantity.length > 0) {
      console.log(`  物品清单（带数量）:`);
      file.itemsWithQuantity.forEach((item: any) => {
        const parts = [`      ${item.name}`];
        if (item.quantity) parts.push(`x${item.quantity}`);
        if (item.unitPrice) parts.push(`单价¥${item.unitPrice}`);
        if (item.totalPrice) parts.push(`小计¥${item.totalPrice}`);
        console.log(`    - ${parts.join(' ')}`);
      });
    } else if (file.items.length > 0) {
      console.log(`  物品清单:`);
      file.items.forEach((item: string) => console.log(`    - ${item}`));
    }

    // 显示签领表信息
    if (file.signItems && file.signItems.length > 0) {
      console.log(`  签领信息:`);
      file.signItems.forEach((s: any) => {
        console.log(`    - ${s.prizeName}: 应签领 ${s.expectedCount}`);
      });
    }

    // 显示发票详情
    if (file.invoiceDetail) {
      const d = file.invoiceDetail;
      console.log(`  发票详情:`);
      console.log(`    发票号码: ${d.invoiceNumber || '（未识别）'}`);
      console.log(`    开票日期: ${d.date || '（未识别）'}`);
      console.log(`    购买方: ${d.buyerName || '（未识别）'}`);
      console.log(`    销售方: ${d.sellerName || '（未识别）'}`);
      if (d.amount) console.log(`    金额(税前): ¥${d.amount}`);
      if (d.taxAmount) console.log(`    税额: ¥${d.taxAmount}`);
      if (d.totalAmount) console.log(`    价税合计: ¥${d.totalAmount}`);
    }

    // 显示购买截图详情
    if (file.purchaseDetail) {
      const d = file.purchaseDetail;
      console.log(`  购买截图详情:`);
      if (d.actualPayment) console.log(`    实付款: ¥${d.actualPayment}`);
      if (d.originalTotal) console.log(`    商品原总价: ¥${d.originalTotal}`);
      if (d.platformDiscount) console.log(`    平台优惠: ¥${d.platformDiscount}`);
      if (d.itemCount) console.log(`    商品件数: ${d.itemCount}`);
      if (d.storeName) console.log(`    店铺: ${d.storeName}`);
      if (d.deliveryAddress) console.log(`    收货地址: ${d.deliveryAddress}`);
      if (d.recipientName) console.log(`    收件人: ${d.recipientName}`);
      if (d.orderId) console.log(`    订单号: ${d.orderId}`);
    }

    // 显示审批单详情
    if (file.approvalDetail) {
      const d = file.approvalDetail;
      console.log(`  审批单详情:`);
      if (d.projectName) console.log(`    项目名称: ${d.projectName}`);
      if (d.organizingParty) console.log(`    组织方: ${d.organizingParty}`);
      if (d.amount) console.log(`    预算总额: ¥${d.amount}`);
      if (d.budgetItems.length > 0) {
        console.log(`    预算明细:`);
        d.budgetItems.forEach((b: any) => {
          console.log(`      - ${b.name} x${b.quantity} = ¥${b.totalPrice}`);
        });
      }
    }

    if (file.warnings.length > 0) {
      console.log(`  警告:`);
      file.warnings.forEach((w: string) => console.log(`    ⚠️  ${w}`));
    }
    console.log();
  }

  // 打印发票与截图匹配结果
  if (result.matchResults && result.matchResults.length > 0) {
    console.log('--- 🔗 发票与购买截图匹配 ---\n');
    for (const m of result.matchResults) {
      if (m.matchedBy === 'orderId') {
        console.log(`✅ ${m.invoiceFile} ↔ ${m.purchaseFile}（通过订单号匹配）`);
        console.log(`   发票金额 ¥${m.invoiceAmount}，截图实付 ¥${m.purchaseAmount}`);
      } else if (m.matchedBy === 'amount') {
        console.log(`✅ ${m.invoiceFile} ↔ ${m.purchaseFile}（通过金额匹配 ¥${m.invoiceAmount}）`);
      } else {
        // unmatched：区分"发票没匹配到截图"与"截图没匹配到发票"
        if (m.invoiceFile === '未匹配') {
          console.log(`❌ ${m.purchaseFile} 未匹配到发票`);
        } else {
          console.log(`❌ ${m.invoiceFile} 未匹配到购买截图`);
        }
      }
      if (m.items.length > 0) {
        for (const item of m.items) {
          console.log(`   ${item.itemName}: 发票${item.invoiceQty}个 / 截图${item.purchaseQty}件`);
        }
      }
      console.log();
    }
  }

  // 打印完整性检查
  console.log('--- 📋 材料齐全性检查 ---\n');
  const cc = result.completenessCheck;

  if (cc.foundMaterials.length > 0) {
    console.log('✅ 已检测到的材料:');
    cc.foundMaterials.forEach((m: string) => console.log(`   - ${m}`));
  }

  if (cc.missingMaterials.length > 0) {
    console.log('\n❌ 缺失的必要材料:');
    cc.missingMaterials.forEach((m: string) => console.log(`   - ${m}`));
  }

  if (cc.problematicMaterials.length > 0) {
    console.log('\n⚠️  材料存在问题:');
    for (const pm of cc.problematicMaterials) {
      console.log(`   [${pm.material}]`);
      pm.issues.forEach((issue: string) => console.log(`     - ${issue}`));
    }
  }

  // 打印 LLM 增强层审查结果
  if (useLLM) {
    console.log('\n--- 🤖 LLM 增强层审查 ---\n');
    if (result.llmReview) {
      const review = result.llmReview;
      const order = { error: 0, warning: 1, info: 2 } as const;
      const findings = [...review.findings].sort(
        (a, b) => order[a.severity] - order[b.severity],
      );
      if (findings.length > 0) {
        for (const f of findings) {
          const tag = f.severity === 'error' ? '❌ error'
            : f.severity === 'warning' ? '⚠️  warning'
            : 'ℹ️  info';
          const mat = f.material ? ` [${f.material}]` : '';
          console.log(`${tag} (${f.ruleId})${mat} ${f.message}`);
          if (f.suggestion) console.log(`        ↳ ${f.suggestion}`);
        }
      } else {
        console.log('（LLM 未发现合规问题）');
      }
      if (review.uncoveredBudgetItems && review.uncoveredBudgetItems.length > 0) {
        console.log('\n📌 预算明细中应有但未找到对应发票/截图的品目:');
        review.uncoveredBudgetItems.forEach((b) => console.log(`   - ${b}`));
      }
      if (review.summary) {
        console.log(`\n📝 审查总结: ${review.summary}`);
      }
      console.log(`\n   模型: ${review.model} · 时间: ${review.reviewedAt}`);
    } else {
      console.log('⚠️ LLM 未启用或调用失败（已降级到纯启发式结果）。');
      console.log('   请确认 .env 中已配置 AI_API_KEY / AI_API_BASE_URL / AI_MODEL 且网络可达。');
    }

    // 打印多模态救援结果（签领表 / 新闻稿）
    const rescuedSign = result.files.find((f) => f.signItemsSource === 'vision-llm');
    const failedSign = result.files.find((f) => f.signItemsSource === 'vision-llm-failed');
    const rescuedNews = result.files.find((f) => f.llmNotes?.newsHasTitle === true);
    if (rescuedSign || failedSign || rescuedNews) {
      console.log('\n🖼️  多模态救援:');
      if (rescuedSign) console.log(`   ✅ 签领表 (${rescuedSign.fileName}) 已由视觉模型补出签领信息`);
      if (failedSign) console.log(`   ⚠️  签领表 (${failedSign.fileName}) 视觉救援失败，保留启发式结果`);
      if (rescuedNews) {
        const title = rescuedNews.llmNotes?.newsTitleText || '';
        console.log(`   ✅ 新闻稿 (${rescuedNews.fileName}) 视觉确认含青春科大标题${title ? `：${title}` : ''}`);
      }
    }
  }

  // 打印汇总
  console.log('\n' + '-'.repeat(60));
  console.log('📌 结论总结');
  console.log('-'.repeat(60));
  console.log(result.summary);

  console.log(`\n⏱️  耗时: ${elapsed}s`);
  console.log('\n' + '=' .repeat(60));

  // 输出完整 JSON（便于 AI Agent 调用）
  if (process.env.JSON_OUTPUT === '1') {
    // 清理原始文本以减小输出
    const cleanResult = {
      ...result,
      files: result.files.map((f: FileParseResult) => ({
        ...f,
        rawText: f.rawText.substring(0, 200) + (f.rawText.length > 200 ? '...（截断）' : ''),
      })),
    };
    console.log('\n📦 完整 JSON 输出:\n');
    console.log(JSON.stringify(cleanResult, null, 2));
  }
}

main().catch((err) => {
  console.error('运行出错:', err);
  process.exit(1);
});