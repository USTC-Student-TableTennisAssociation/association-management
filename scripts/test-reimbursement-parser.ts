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
        console.log(`❌ ${m.invoiceFile} 未匹配到购买截图`);
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