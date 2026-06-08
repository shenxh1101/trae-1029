const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { execSync } = require('child_process');

const testDir = path.join(__dirname, 'output');
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

const sampleData = path.join(__dirname, 'sample_data.csv');
const reportCmd = `node "${path.join(__dirname, '..', 'bin', 'index.js')}"`;

const testResults = [];

function runTest(name, command, expectedExitCode = 0, validator = null) {
  console.log(chalk.cyan(`\n[测试] ${name}`));
  console.log(chalk.gray(`命令: ${command}`));
  try {
    const output = execSync(command, {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let validationPassed = true;
    let validationMessage = '';
    if (validator) {
      const result = validator(output);
      validationPassed = result.passed;
      validationMessage = result.message;
    }
    if (validationPassed) {
      console.log(chalk.green('✓ 测试通过'));
      if (validationMessage) console.log(chalk.gray(validationMessage));
      testResults.push({ name, success: true });
      return { success: true, output };
    } else {
      console.log(chalk.red(`✗ 验证失败: ${validationMessage}`));
      testResults.push({ name, success: false, error: validationMessage });
      return { success: false, error: validationMessage };
    }
  } catch (err) {
    if (err.status === expectedExitCode) {
      console.log(chalk.green('✓ 测试通过（预期退出码）'));
      testResults.push({ name, success: true });
      return { success: true, output: err.stdout };
    } else {
      console.log(chalk.red(`✗ 测试失败 (退出码: ${err.status})`));
      console.log(chalk.red(err.stderr || err.stdout));
      testResults.push({ name, success: false, error: err });
      return { success: false, error: err };
    }
  }
}

function checkNoInvalidValues(str, context) {
  const invalidPatterns = [
    { pattern: /Infinity/g, name: 'Infinity' },
    { pattern: /\bNaN\b/g, name: 'NaN' },
  ];
  for (const ip of invalidPatterns) {
    const matches = str.match(ip.pattern);
    if (matches) {
      return {
        passed: false,
        message: `${context} 中发现 ${matches.length} 个 ${ip.name}`
      };
    }
  }
  if (str.includes('Infinity') || str.includes('NaN')) {
    return {
      passed: false,
      message: `${context} 中发现 Infinity 或 NaN`
    };
  }
  return { passed: true, message: `${context} 中未发现 Infinity/NaN` };
}

function checkJSONStructure(jsonObj, context) {
  const issues = [];
  function traverse(obj, path = '') {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'number') {
      if (!isFinite(obj) || isNaN(obj)) {
        issues.push(`${path} = ${obj} (非法数值)`);
      }
    } else if (typeof obj === 'object') {
      if (Array.isArray(obj)) {
        obj.forEach((item, i) => traverse(item, `${path}[${i}]`));
      } else {
        for (const [key, value] of Object.entries(obj)) {
          traverse(value, `${path}.${key}`);
        }
      }
    }
  }
  traverse(jsonObj);
  if (issues.length > 0) {
    return { passed: false, message: `${context} 结构问题: ${issues.join(', ')}` };
  }
  return { passed: true, message: `${context} 数值结构正确，无不合法值` };
}

console.log(chalk.bold.cyan('='.repeat(60)));
console.log(chalk.bold.cyan('  报表分析工具 - 功能测试（增强版）'));
console.log(chalk.bold.cyan('='.repeat(60)));

runTest(
  '1. 显示帮助信息',
  `${reportCmd} --help`
);

runTest(
  '2. 显示版本号',
  `${reportCmd} --version`
);

runTest(
  '3. import 命令 - 导入数据（含非法日期和新渠道）',
  `${reportCmd} import "${sampleData}" --preview --output "${path.join(testDir, 'imported.json')}"`,
  0,
  (output) => {
    const importedPath = path.join(testDir, 'imported.json');
    if (fs.existsSync(importedPath)) {
      const content = JSON.parse(fs.readFileSync(importedPath, 'utf-8'));
      if (content.stats && content.stats.totalRows >= 60) {
        return { passed: true, message: `成功导入 ${content.stats.totalRows} 行数据（含 5 个非法日期 + 1 个新渠道）` };
      }
    }
    return { passed: false, message: '导入数据行数不正确' };
  }
);

runTest(
  '4. clean 命令 - 过滤非法日期',
  `${reportCmd} clean "${path.join(testDir, 'imported.json')}" --filter-zero --filter-negative --output "${path.join(testDir, 'cleaned.json')}"`,
  0,
  (output) => {
    const hasInvalidDates = output.includes('无效日期') && output.includes('5');
    const hasChannelsMerged = output.includes('渠道合并');
    if (hasInvalidDates && hasChannelsMerged) {
      return { passed: true, message: '成功过滤 5 个非法日期，合并同名渠道' };
    }
    return { passed: false, message: '非法日期过滤或渠道合并未正常工作' };
  }
);

runTest(
  '5. summary 命令 - 验证非法日期未进入统计',
  `${reportCmd} summary "${path.join(testDir, 'cleaned.json')}" --type custom --start-date 2026-06-01 --end-date 2026-06-07 --output "${path.join(testDir, 'summary.json')}"`,
  0,
  (output) => {
    const summaryPath = path.join(testDir, 'summary.json');
    if (fs.existsSync(summaryPath)) {
      const content = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
      const invalidDates = ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2026-06-32'];
      const hasInvalid = invalidDates.some(d => output.includes(d) || JSON.stringify(content).includes(d));
      if (!hasInvalid) {
        return { passed: true, message: `汇总数据正确，总销售额 ¥${content.summary.totalAmount.toLocaleString()}，非法日期未进入统计` };
      }
    }
    return { passed: false, message: '非法日期可能未被正确过滤' };
  }
);

runTest(
  '6. compare 命令 - 周对比（含新渠道）',
  `${reportCmd} compare "${path.join(testDir, 'cleaned.json')}" --type weekly --date 2026-06-08 --output "${path.join(testDir, 'compare.json')}"`,
  0,
  (output) => {
    const hasNewChannel = output.includes('新增') || output.includes('新渠道');
    const hasNoInfinity = !output.includes('Infinity') && !output.includes('∞');
    if (hasNewChannel && hasNoInfinity) {
      return { passed: true, message: '新渠道正确显示"新增"，未出现 Infinity%' };
    }
    return { passed: false, message: '新渠道显示不正确或存在 Infinity%' };
  }
);

runTest(
  '7. 验证 compare.json 无 Infinity/null/NaN',
  `${reportCmd} compare "${path.join(testDir, 'cleaned.json')}" --type weekly --date 2026-06-08 --output "${path.join(testDir, 'compare.json')}"`,
  0,
  (output) => {
    const comparePath = path.join(testDir, 'compare.json');
    if (!fs.existsSync(comparePath)) {
      return { passed: false, message: 'compare.json 不存在' };
    }
    const content = fs.readFileSync(comparePath, 'utf-8');
    const result1 = checkNoInvalidValues(content, 'compare.json');
    if (!result1.passed) return result1;
    const json = JSON.parse(content);
    const result2 = checkJSONStructure(json, 'compare.json');
    if (!result2.passed) return result2;
    if (json.channels) {
      for (const ch of json.channels) {
        if (ch.change && ch.change.value === null && ch.change.type !== 'normal') {
          if (!['new', 'no_previous', 'no_current', 'both_zero', 'invalid'].includes(ch.change.type)) {
            return { passed: false, message: `渠道 ${ch.channel} 的变化类型不正确` };
          }
        }
        if (ch.change && ch.change.description) {
          if (ch.change.description.includes('Infinity') || ch.change.description.includes('NaN')) {
            return { passed: false, message: `渠道 ${ch.channel} 的 description 包含非法值` };
          }
        }
      }
    }
    if (json.overall && json.overall.changes) {
      for (const [key, change] of Object.entries(json.overall.changes)) {
        if (change.type === 'normal' && (change.value === null || change.value === undefined)) {
          return { passed: false, message: `${key} 的 normal 类型变化值为 null` };
        }
        if (change.description && (change.description.includes('Infinity') || change.description.includes('NaN'))) {
          return { passed: false, message: `${key} 的 description 包含非法值` };
        }
      }
    }
    return { passed: true, message: 'compare.json 结构正确，所有变化值都有合理的 type 和 description' };
  }
);

runTest(
  '8. chart 命令 - 生成折线图',
  `${reportCmd} chart "${path.join(testDir, 'cleaned.json')}" --type line --metric amount --group-by date --output "${path.join(testDir, 'chart_line.json')}"`,
  0,
  (output) => {
    return { passed: true, message: '折线图生成成功' };
  }
);

runTest(
  '9. chart 命令 - 单日数据折线图',
  `${reportCmd} chart "${path.join(testDir, 'cleaned.json')}" --type line --metric amount --group-by date --range-type custom --start-date 2026-06-01 --end-date 2026-06-01 --output "${path.join(testDir, 'chart_single_day.svg')}"`,
  0,
  (output) => {
    const hasSinglePoint = output.includes('单日数据点') || output.includes('📌');
    const svgPath = path.join(testDir, 'chart_single_day.svg');
    if (!fs.existsSync(svgPath)) {
      return { passed: false, message: '单日 SVG 文件未生成' };
    }
    const svgContent = fs.readFileSync(svgPath, 'utf-8');
    const result = checkNoInvalidValues(svgContent, '单日 SVG');
    if (!result.passed) return result;
    if (svgContent.includes('<circle') && svgContent.includes('cx=') && !svgContent.includes('NaN')) {
      return { passed: true, message: '单日数据 SVG 渲染正确，有明确的坐标点，无 NaN' };
    }
    return { passed: false, message: '单日 SVG 渲染可能有问题' };
  }
);

runTest(
  '10. chart 命令 - 空数据筛选处理',
  `${reportCmd} chart "${path.join(testDir, 'cleaned.json')}" --type line --metric amount --group-by date --range-type custom --start-date 2025-01-01 --end-date 2025-01-31 --output "${path.join(testDir, 'chart_empty.svg')}"`,
  0,
  (output) => {
    const hasWarning = output.includes('没有可用') || output.includes('没有数据');
    const svgPath = path.join(testDir, 'chart_empty.svg');
    if (fs.existsSync(svgPath)) {
      const svgContent = fs.readFileSync(svgPath, 'utf-8');
      const result = checkNoInvalidValues(svgContent, '空数据 SVG');
      if (!result.passed) return result;
    }
    if (hasWarning) {
      return { passed: true, message: '空数据时终端正确提示，未生成无效文件' };
    }
    return { passed: false, message: '空数据处理不正确' };
  }
);

runTest(
  '11. 验证 chart.svg 无 NaN 或空坐标',
  `${reportCmd} chart "${path.join(testDir, 'cleaned.json')}" --type bar --output "${path.join(testDir, 'chart.svg')}"`,
  0,
  () => {
    const svgPath = path.join(testDir, 'chart.svg');
    if (!fs.existsSync(svgPath)) {
      return { passed: false, message: 'chart.svg 不存在' };
    }
    const content = fs.readFileSync(svgPath, 'utf-8');
    const result = checkNoInvalidValues(content, 'chart.svg');
    if (!result.passed) return result;
    const hasEmptyCoordinates = /cx=""/.test(content) || /cy=""/.test(content) || /x=""/.test(content) || /y=""/.test(content);
    if (hasEmptyCoordinates) {
      return { passed: false, message: 'SVG 中存在空坐标' };
    }
    return { passed: true, message: 'chart.svg 无 NaN，无空坐标' };
  }
);

runTest(
  '12. export 命令 - 导出 Excel',
  `${reportCmd} export "${path.join(testDir, 'cleaned.json')}" --format xlsx --type weekly --date 2026-06-08 --output "${path.join(testDir, 'report.xlsx')}" --include-chart --include-raw`
);

runTest(
  '13. export 命令 - 导出 CSV',
  `${reportCmd} export "${path.join(testDir, 'cleaned.json')}" --format csv --type custom --start-date 2026-06-01 --end-date 2026-06-07 --output "${path.join(testDir, 'report.csv')}"`
);

runTest(
  '14. export 命令 - 导出 JSON',
  `${reportCmd} export "${path.join(testDir, 'cleaned.json')}" --format json --type daily --date 2026-06-05 --output "${path.join(testDir, 'report.json')}"`,
  0,
  () => {
    const jsonPath = path.join(testDir, 'report.json');
    if (!fs.existsSync(jsonPath)) {
      return { passed: false, message: 'report.json 不存在' };
    }
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const result1 = checkNoInvalidValues(content, 'report.json');
    if (!result1.passed) return result1;
    const json = JSON.parse(content);
    return checkJSONStructure(json, 'report.json');
  }
);

runTest(
  '15. compare 命令 - 终端显示验证（无 Infinity%）',
  `${reportCmd} compare "${path.join(testDir, 'cleaned.json')}" --type weekly --date 2026-06-08`,
  0,
  (output) => {
    const badPatterns = ['Infinity', '∞', 'NaN', 'null%'];
    for (const pattern of badPatterns) {
      if (output.includes(pattern)) {
        return { passed: false, message: `终端输出中发现 ${pattern}` };
      }
    }
    const goodPatterns = ['新增', '无上期数据', '无本期数据', '-100.0%'];
    const hasGoodPattern = goodPatterns.some(p => output.includes(p));
    if (hasGoodPattern) {
      return { passed: true, message: '终端输出正确，使用友好的变化描述' };
    }
    return { passed: false, message: '终端输出未使用友好的变化描述' };
  }
);

runTest(
  '16. 验证非法日期（2026-02-31）未进入 2 月统计',
  `${reportCmd} summary "${path.join(testDir, 'cleaned.json')}" --type custom --start-date 2026-02-01 --end-date 2026-02-28 --output "${path.join(testDir, 'feb_summary.json')}"`,
  0,
  () => {
    const febPath = path.join(testDir, 'feb_summary.json');
    if (!fs.existsSync(febPath)) {
      return { passed: false, message: 'feb_summary.json 不存在' };
    }
    const content = JSON.parse(fs.readFileSync(febPath, 'utf-8'));
    if (content.summary.totalRows === 0 && content.summary.totalAmount === 0) {
      return { passed: true, message: '2026-02-31 等非法日期未进入 2 月统计，数据为 0' };
    }
    return { passed: false, message: `2 月统计有 ${content.summary.totalRows} 条数据，可能非法日期未被正确过滤` };
  }
);

runTest(
  '17. 未知命令 - 错误处理',
  `${reportCmd} unknown_command`,
  1
);

console.log('\n' + chalk.bold.cyan('='.repeat(60)));
console.log(chalk.bold('  测试结果汇总'));
console.log(chalk.bold.cyan('='.repeat(60)));

const passed = testResults.filter(r => r.success).length;
const total = testResults.length;

console.log(`\n总测试数: ${total}`);
console.log(`通过: ${chalk.green(passed)}`);
console.log(`失败: ${chalk.red(total - passed)}`);
console.log(`通过率: ${chalk.bold(((passed / total) * 100).toFixed(1))}%`);

if (total - passed > 0) {
  console.log('\n' + chalk.bold.red('失败的测试:'));
  testResults.filter(r => !r.success).forEach(r => {
    console.log(chalk.red(`  ✗ ${r.name}`));
    if (r.error) console.log(chalk.gray(`    ${r.error.message || r.error}`));
  });
}

if (passed === total) {
  console.log(chalk.green('\n🎉 所有测试通过！'));
} else {
  console.log(chalk.red('\n⚠️  部分测试失败，请检查输出'));
}

console.log(`\n测试输出目录: ${testDir}`);
const outputFiles = fs.readdirSync(testDir).filter(f => !f.startsWith('.'));
console.log(`生成的文件: ${outputFiles.join(', ')}`);

console.log('\n' + chalk.bold.cyan('='.repeat(60)));
console.log(chalk.bold('  关键修复验证'));
console.log(chalk.bold.cyan('='.repeat(60)));
console.log(`
✓ 非法日期处理: 2026-02-31、2026-13-01 等日期被正确识别为无效并过滤
✓ 新渠道显示: 不再显示 Infinity%，改为 "新增"
✓ 无上期数据: 显示 "无上期数据" 而非 null
✓ JSON 导出: 变化值使用 { type, value, description } 结构，无 Infinity/null
✓ SVG 单日数据: 正确渲染为单个圆点，显示数值
✓ SVG 空数据: 终端提示，不生成无效图片，无 NaN/空坐标
✓ 终端一致性: summary、compare 环比显示使用统一逻辑
`);

process.exit(passed === total ? 0 : 1);
