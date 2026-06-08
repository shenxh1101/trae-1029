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

function runTest(name, command, expectedExitCode = 0) {
  console.log(chalk.cyan(`\n[测试] ${name}`));
  console.log(chalk.gray(`命令: ${command}`));
  try {
    const output = execSync(command, {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.green('✓ 测试通过'));
    if (output.length < 2000) {
      console.log(chalk.gray(output.slice(0, 500) + (output.length > 500 ? '...' : '')));
    }
    return { success: true, output };
  } catch (err) {
    if (err.status === expectedExitCode) {
      console.log(chalk.green('✓ 测试通过（预期退出码）'));
      return { success: true, output: err.stdout };
    } else {
      console.log(chalk.red(`✗ 测试失败 (退出码: ${err.status})`));
      console.log(chalk.red(err.stderr || err.stdout));
      return { success: false, error: err };
    }
  }
}

console.log(chalk.bold.cyan('='.repeat(60)));
console.log(chalk.bold.cyan('  报表分析工具 - 功能测试'));
console.log(chalk.bold.cyan('='.repeat(60)));

const results = [];

results.push(runTest(
  '1. 显示帮助信息',
  `${reportCmd} --help`
));

results.push(runTest(
  '2. 显示版本号',
  `${reportCmd} --version`
));

results.push(runTest(
  '3. import 命令 - 导入数据并预览',
  `${reportCmd} import "${sampleData}" --preview --output "${path.join(testDir, 'imported.json')}"`
));

results.push(runTest(
  '4. clean 命令 - 清洗数据（过滤无效、合并渠道）',
  `${reportCmd} clean "${path.join(testDir, 'imported.json')}" --filter-zero --filter-negative --preview --output "${path.join(testDir, 'cleaned.json')}"`
));

results.push(runTest(
  '5. summary 命令 - 生成周报',
  `${reportCmd} summary "${path.join(testDir, 'cleaned.json')}" --type weekly --date 2026-06-08 --export-text "${path.join(testDir, 'weekly_report.txt')}"`
));

results.push(runTest(
  '6. summary 命令 - 生成自定义时间段报告',
  `${reportCmd} summary "${path.join(testDir, 'cleaned.json')}" --type custom --start-date 2026-06-01 --end-date 2026-06-07 --output "${path.join(testDir, 'summary.json')}"`
));

results.push(runTest(
  '7. compare 命令 - 周周对比',
  `${reportCmd} compare "${path.join(testDir, 'cleaned.json')}" --type weekly --date 2026-06-08 --output "${path.join(testDir, 'compare.json')}"`
));

results.push(runTest(
  '8. chart 命令 - 生成折线图',
  `${reportCmd} chart "${path.join(testDir, 'cleaned.json')}" --type line --metric amount --group-by date --output "${path.join(testDir, 'chart_line.json')}"`
));

results.push(runTest(
  '9. chart 命令 - 生成渠道横向柱状图',
  `${reportCmd} chart "${path.join(testDir, 'cleaned.json')}" --type horizontal --metric amount --group-by channel --top 5`
));

results.push(runTest(
  '10. chart 命令 - 生成 SVG 图表',
  `${reportCmd} chart "${path.join(testDir, 'cleaned.json')}" --type bar --output "${path.join(testDir, 'chart.svg')}"`
));

results.push(runTest(
  '11. export 命令 - 导出 Excel',
  `${reportCmd} export "${path.join(testDir, 'cleaned.json')}" --format xlsx --type weekly --date 2026-06-08 --output "${path.join(testDir, 'report.xlsx')}" --include-chart --include-raw`
));

results.push(runTest(
  '12. export 命令 - 导出 CSV',
  `${reportCmd} export "${path.join(testDir, 'cleaned.json')}" --format csv --type custom --start-date 2026-06-01 --end-date 2026-06-07 --output "${path.join(testDir, 'report.csv')}"`
));

results.push(runTest(
  '13. export 命令 - 导出 JSON',
  `${reportCmd} export "${path.join(testDir, 'cleaned.json')}" --format json --type daily --date 2026-06-05 --output "${path.join(testDir, 'report.json')}"`
));

results.push(runTest(
  '14. export 命令 - 列出配置',
  `${reportCmd} export --list-configs`
));

results.push(runTest(
  '15. 未知命令 - 错误处理',
  `${reportCmd} unknown_command`,
  1
));

console.log('\n' + chalk.bold.cyan('='.repeat(60)));
console.log(chalk.bold('  测试结果汇总'));
console.log(chalk.bold.cyan('='.repeat(60)));

const passed = results.filter(r => r.success).length;
const total = results.length;

console.log(`\n总测试数: ${total}`);
console.log(`通过: ${chalk.green(passed)}`);
console.log(`失败: ${chalk.red(total - passed)}`);
console.log(`通过率: ${chalk.bold(((passed / total) * 100).toFixed(1))}%`);

if (passed === total) {
  console.log(chalk.green('\n🎉 所有测试通过！'));
} else {
  console.log(chalk.red('\n⚠️  部分测试失败，请检查输出'));
}

console.log(`\n测试输出目录: ${testDir}`);
const outputFiles = fs.readdirSync(testDir).filter(f => !f.startsWith('.'));
console.log(`生成的文件: ${outputFiles.join(', ')}`);

process.exit(passed === total ? 0 : 1);
